import { createHash } from 'node:crypto';
import type { AgentConfig } from './config.ts';
import type { Collector } from './collector.ts';
import { createFixtureCollector } from './collector.ts';
import { buildDescription, CAPABILITY_ID, OPERATION } from './contract.ts';
import { type Job, JobStore, TERMINAL_STATUSES } from './jobs.ts';
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
  readonly #defaultCollectorId: string;

  constructor(
    config: AgentConfig,
    options: { collector?: Collector; collectors?: Collector[]; jobs?: JobStore } = {},
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
  }

  describe(): Record<string, unknown> {
    return buildDescription(this.#config);
  }

  async execute(request: ExecuteRequest): Promise<ExecuteResponse> {
    const agentInstanceId = this.#config.agentInstanceId;
    const operation = request.operation ?? OPERATION;
    if (operation !== OPERATION) {
      return { accepted: false, agentInstanceId, taskId: request.taskId, error: `unsupported_operation:${operation}` };
    }

    let workspace: { name: string; path: string };
    try {
      workspace = await resolveWorkspacePath(request.workspace, this.#config.workspacesRoot);
    } catch (error) {
      return { accepted: false, agentInstanceId, taskId: request.taskId, error: message(error) };
    }

    const connectorId = normalizeKey(request.arguments?.connectorId as string | undefined)
      ?? this.#defaultCollectorId;
    const collector = this.#collectors.get(connectorId);
    if (!collector) {
      return {
        accepted: false,
        agentInstanceId,
        taskId: request.taskId,
        error: `unsupported_connector:${connectorId}`,
      };
    }
    const instanceId =
      normalizeKey(request.arguments?.instanceId as string | undefined)
      ?? (collector.connectorId === 'fixture' ? 'fixture' : `${collector.connectorId}-1`);
    const idempotencyKey = normalizeKey(request.idempotencyKey);
    const requestFingerprint = fingerprint({
      operation,
      workspace: workspace.name,
      connectorId,
      instanceId,
      arguments: request.arguments ?? {},
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

    // Run the collection asynchronously; the caller polls agent_status.
    queueMicrotask(() => {
      void this.#runCollection(
        job,
        settle,
        workspace,
        collector,
        instanceId,
        request.arguments ?? {},
      );
    });

    return response;
  }

  async #runCollection(
    job: Job,
    settle: (result: import('./jobs.ts').JobResult) => void,
    workspace: { name: string; path: string },
    collector: Collector,
    instanceId: string,
    args: Record<string, unknown>,
  ): Promise<void> {
    this.#jobs.markRunning(job.jobId);
    try {
      if (job.cancelRequested) {
        settle({ status: 'cancelled' });
        return;
      }
      const items = await collector.collect(args, { workspace, instanceId });
      if (job.cancelRequested) {
        settle({ status: 'cancelled' });
        return;
      }
      const { written, skipped } = await writeRawMarkdown({
        workspacePath: workspace.path,
        connectorId: collector.connectorId,
        instanceId,
        items,
      });
      settle({ status: 'succeeded', written, skipped });
    } catch (error) {
      // Connector errors may contain provider responses or credentials. Keep
      // the persisted/status surface deliberately coarse and non-secret.
      settle({ status: 'failed', error: classifyCollectionError(error) });
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

function classifyCollectionError(error: unknown): string {
  const value = message(error);
  if (
    value === 'google_not_configured' ||
    value === 'google_tokens_invalid' ||
    value === 'gmail_readonly_scope_missing' ||
    value === 'google_refresh_token_missing' ||
    value === 'google_oauth_client_not_configured'
  ) {
    return 'authentication_required';
  }
  if (
    value.startsWith('google_token_refresh_failed:') ||
    value === 'google_token_refresh_invalid_response'
  ) {
    return 'authentication_failed';
  }
  if (value === 'gmail_api_failed:429') return 'provider_rate_limited';
  if (/^gmail_api_failed:5\d\d$/.test(value)) return 'provider_unavailable';
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
