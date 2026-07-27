import { createHash } from 'node:crypto';
import type { AgentConfig } from './config.ts';
import type { Collector } from './collector.ts';
import { createFixtureCollector } from './collector.ts';
import {
  buildDescription,
  CAPABILITY_ID,
  OPERATION,
  SEND_CAPABILITY_ID,
  SEND_OPERATION,
} from './contract.ts';
import { type Job, type JobResult, JobStore, TERMINAL_STATUSES } from './jobs.ts';
import { parseSendRequest, type Sender, type SendRequest } from './sender.ts';
import { resolveWorkspacePath, type WorkspaceRef } from './workspace.ts';
import { writeRawMarkdown } from './writeRawMarkdown.ts';

export type ExecuteRequest = {
  taskId?: string;
  idempotencyKey?: string;
  operation?: string;
  workspace?: WorkspaceRef;
  arguments?: Record<string, unknown>;
  constraints?: { requireApprovalForMutations?: boolean };
};

export type ExecuteResponse = {
  accepted: boolean;
  agentInstanceId: string;
  taskId?: string;
  jobId?: string;
  status?: string;
  idempotent?: boolean;
  terminal?: boolean;
  result?: unknown;
  error?: string;
};

/**
 * Framework-agnostic core of the connectors agent. It owns the job store,
 * resolves workspaces, runs the collector, and drives the sink — with no
 * knowledge of MCP or HTTP, so it is unit-testable in isolation. `server.ts`
 * simply binds these methods to the five orchestration tools.
 */
export class ConnectorsAgent {
  readonly #config: AgentConfig;
  readonly #jobs: JobStore;
  readonly #collectors: Map<string, Collector>;
  readonly #senders: Map<string, Sender>;
  readonly #defaultCollectorId: string;
  readonly #defaultSenderId?: string;

  constructor(
    config: AgentConfig,
    options: {
      collector?: Collector;
      collectors?: Collector[];
      senders?: Sender[];
      jobs?: JobStore;
    } = {},
  ) {
    this.#config = config;
    this.#jobs = options.jobs ?? new JobStore(config.dataDir);
    const configured =
      options.collectors ?? [options.collector ?? createFixtureCollector()];
    if (configured.length === 0) throw new Error('At least one collector is required.');
    this.#collectors = new Map(configured.map((collector) => [collector.connectorId, collector]));
    if (this.#collectors.size !== configured.length) {
      throw new Error('Collector identifiers must be unique.');
    }
    this.#defaultCollectorId = configured[0]!.connectorId;

    const senders = options.senders ?? [];
    this.#senders = new Map(senders.map((sender) => [sender.connectorId, sender]));
    if (this.#senders.size !== senders.length) {
      throw new Error('Sender identifiers must be unique.');
    }
    this.#defaultSenderId = senders[0]?.connectorId;
  }

  describe(): Record<string, unknown> {
    return buildDescription(this.#config);
  }

  async execute(request: ExecuteRequest): Promise<ExecuteResponse> {
    const agentInstanceId = this.#config.agentInstanceId;
    const operation = request.operation ?? OPERATION;
    if (operation !== OPERATION && operation !== SEND_OPERATION) {
      return { accepted: false, agentInstanceId, taskId: request.taskId, error: `unsupported_operation:${operation}` };
    }
    if (operation === SEND_OPERATION && !this.#config.sendEnabled) {
      return {
        accepted: false,
        agentInstanceId,
        taskId: request.taskId,
        error: 'capability_disabled:communication.send-email',
      };
    }

    let workspace: { name: string; path: string };
    try {
      workspace = await resolveWorkspacePath(request.workspace, this.#config.workspacesRoot);
    } catch (error) {
      return { accepted: false, agentInstanceId, taskId: request.taskId, error: message(error) };
    }

    const args = request.arguments ?? {};
    const requestedConnectorId = normalizeKey(args.connectorId as string | undefined);
    let connectorId: string;
    let instanceId: string;
    let run: (context: {
      workspace: { name: string; path: string };
      instanceId: string;
      idempotencyKey?: string;
      job: Job;
    }) => Promise<JobResult>;

    if (operation === SEND_OPERATION) {
      connectorId = requestedConnectorId ?? this.#defaultSenderId ?? 'google';
      const sender = this.#senders.get(connectorId);
      if (!sender) {
        return {
          accepted: false,
          agentInstanceId,
          taskId: request.taskId,
          error: `unsupported_connector:${connectorId}`,
        };
      }
      instanceId =
        normalizeKey(args.instanceId as string | undefined) ?? `${sender.connectorId}-1`;
      // Argument validation is synchronous on purpose: a malformed send is a
      // rejected request, not a failed job. The orchestrator must be able to
      // tell "I never sent anything" from "I tried and the provider refused".
      let sendRequest: SendRequest;
      try {
        sendRequest = parseSendRequest(this.#sendArguments(args), {
          maxRecipients: this.#config.sendMaxRecipients,
          maxBodyBytes: this.#config.sendMaxBodyBytes,
          allowedRecipients: this.#config.sendAllowedRecipients,
        });
      } catch (error) {
        return {
          accepted: false,
          agentInstanceId,
          taskId: request.taskId,
          error: message(error),
        };
      }
      run = async (context) => {
        const outcome = await sender.send(sendRequest, {
          workspace: context.workspace,
          instanceId: context.instanceId,
          ...(context.idempotencyKey ? { idempotencyKey: context.idempotencyKey } : {}),
        });
        return { status: 'succeeded', sent: outcome };
      };
    } else {
      connectorId = requestedConnectorId ?? this.#defaultCollectorId;
      const collector = this.#collectors.get(connectorId);
      if (!collector) {
        return {
          accepted: false,
          agentInstanceId,
          taskId: request.taskId,
          error: `unsupported_connector:${connectorId}`,
        };
      }
      instanceId =
        normalizeKey(args.instanceId as string | undefined)
        ?? (collector.connectorId === 'fixture' ? 'fixture' : `${collector.connectorId}-1`);
      run = async (context) => {
        const items = await collector.collect(args, {
          workspace: context.workspace,
          instanceId: context.instanceId,
        });
        if (context.job.cancelRequested) return { status: 'cancelled' };
        const { written, skipped } = await writeRawMarkdown({
          workspacePath: context.workspace.path,
          connectorId: collector.connectorId,
          instanceId: context.instanceId,
          items,
        });
        return { status: 'succeeded', written, skipped };
      };
    }

    const idempotencyKey = normalizeKey(request.idempotencyKey);
    const requestFingerprint = fingerprint({
      operation,
      workspace: workspace.name,
      connectorId,
      instanceId,
      arguments: args,
    });
    if (idempotencyKey) {
      const existing = this.#jobs.findByIdempotencyKey(workspace.name, idempotencyKey);
      if (existing) {
        if (existing.requestFingerprint !== requestFingerprint) {
          return {
            accepted: false,
            agentInstanceId,
            taskId: request.taskId,
            error: 'idempotency_key_payload_mismatch',
          };
        }
        return this.#idempotentReplay(existing);
      }
    }

    const { job, settle } = this.#jobs.create({
      taskId: request.taskId,
      operation,
      workspace: workspace.name,
      idempotencyKey,
      requestFingerprint,
    });

    const response: ExecuteResponse = {
      accepted: true,
      agentInstanceId,
      taskId: request.taskId,
      jobId: job.jobId,
      status: job.status, // 'queued' — the run is deferred below.
      ...(idempotencyKey ? { idempotent: false } : {}),
    };

    // Run the work asynchronously; the caller polls agent_status.
    queueMicrotask(() => {
      void this.#runJob(job, settle, () =>
        run({
          workspace,
          instanceId,
          ...(idempotencyKey ? { idempotencyKey } : {}),
          job,
        }),
      );
    });

    return response;
  }

  /** Only the keys the send schema declares reach the sender. */
  #sendArguments(args: Record<string, unknown>): Record<string, unknown> {
    const { connectorId: _connectorId, instanceId: _instanceId, ...rest } = args;
    return rest;
  }

  async #runJob(
    job: Job,
    settle: (result: JobResult) => void,
    run: () => Promise<JobResult>,
  ): Promise<void> {
    this.#jobs.markRunning(job.jobId);
    try {
      // Cancellation is only honoured before the work starts. Once a message
      // has left for the provider there is nothing to cancel, and reporting
      // "cancelled" for a delivered email would be a lie.
      if (job.cancelRequested) {
        settle({ status: 'cancelled' });
        return;
      }
      settle(await run());
    } catch (error) {
      // Connector errors may contain provider responses or credentials. Keep
      // the persisted/status surface deliberately coarse and non-secret.
      settle({ status: 'failed', error: classifyProviderError(error) });
    }
  }

  /** Task-level status when a jobId is supplied. */
  status(jobId: string): Record<string, unknown> {
    const job = this.#jobs.get(jobId);
    if (!job) throw new Error(`unknown job: ${jobId}`);
    return this.#taskStatus(job);
  }

  /** Capability-level status (input discovery) when no jobId is supplied. */
  capabilityStatus(args: { capability?: string; operation?: string }): Record<string, unknown> {
    if (args.capability === SEND_CAPABILITY_ID || args.operation === SEND_OPERATION) {
      return {
        contractVersion: '1',
        agentInstanceId: this.#config.agentInstanceId,
        capability: SEND_CAPABILITY_ID,
        operation: SEND_OPERATION,
        available: this.#config.sendEnabled && this.#senders.size > 0,
        // Nothing to discover: sending is driven entirely by task arguments.
        pendingInputs: [],
        recipientAllowList: this.#config.sendAllowedRecipients.length > 0,
      };
    }
    if (args.capability && args.capability !== CAPABILITY_ID) {
      throw new Error(`unsupported capability: ${args.capability}`);
    }
    return {
      contractVersion: '1',
      agentInstanceId: this.#config.agentInstanceId,
      capability: CAPABILITY_ID,
      operation: OPERATION,
      available: true,
      // The fixture collector needs no external input discovery; real
      // connectors will list pending source items here.
      pendingInputs: [],
    };
  }

  cancel(jobId: string): Record<string, unknown> {
    const job = this.#jobs.requestCancel(jobId);
    if (!job) return { ok: false, jobId, error: 'unknown_job' };
    return { ok: true, ...this.#taskStatus(job) };
  }

  #idempotentReplay(job: Job): ExecuteResponse {
    const terminal = TERMINAL_STATUSES.has(job.status);
    return {
      accepted: true,
      idempotent: true,
      agentInstanceId: this.#config.agentInstanceId,
      taskId: job.taskId,
      jobId: job.jobId,
      status: job.status,
      terminal,
      ...(terminal ? { result: job.result } : {}),
    };
  }

  #taskStatus(job: Job): Record<string, unknown> {
    return {
      contractVersion: '1',
      agentInstanceId: this.#config.agentInstanceId,
      taskId: job.taskId,
      jobId: job.jobId,
      status: job.status,
      terminal: TERMINAL_STATUSES.has(job.status),
      updatedAt: job.updatedAt,
      ...(job.result ? { result: job.result } : {}),
    };
  }
}

function normalizeKey(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function classifyProviderError(error: unknown): string {
  const value = message(error);
  if (
    value === 'google_not_configured' ||
    value === 'google_tokens_invalid' ||
    value === 'gmail_readonly_scope_missing' ||
    value === 'gmail_send_scope_missing' ||
    value === 'google_refresh_token_missing' ||
    value === 'google_oauth_client_not_configured'
  ) {
    // The send grant is separate from the read grant, so a workspace that
    // collects fine can still land here; the code above is what tells the UI
    // to offer a re-authorization rather than a retry.
    return value === 'gmail_send_scope_missing'
      ? 'authorization_required:send'
      : 'authentication_required';
  }
  if (
    value.startsWith('google_token_refresh_failed:') ||
    value === 'google_token_refresh_invalid_response'
  ) {
    return 'authentication_failed';
  }
  if (value === 'gmail_api_failed:429' || value === 'gmail_send_failed:429') {
    return 'provider_rate_limited';
  }
  if (/^gmail_(?:api|send)_failed:5\d\d$/.test(value)) return 'provider_unavailable';
  // A 4xx on send is the provider rejecting the message itself (bad recipient,
  // quota, policy). Retrying an identical request cannot help, and a retry
  // loop on a send is exactly how duplicates happen — flag it as terminal.
  if (/^gmail_send_failed:4\d\d$/.test(value)) return 'send_rejected';
  if (value.startsWith('gmail_send_failed:')) return 'send_failed';
  return 'collection_failed';
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? JSON.stringify(String(value));
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(',')}}`;
}
