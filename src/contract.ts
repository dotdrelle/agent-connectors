import type { AgentConfig } from './config.ts';

export const CONTRACT_VERSION = '1';
export const CAPABILITY_ID = 'external-source.collect';
export const OPERATION = 'collect';
export const SEND_CAPABILITY_ID = 'communication.send-email';
export const SEND_OPERATION = 'send';

/**
 * The generic multi-agent orchestration contract, executor-only.
 *
 * `external-source.collect` fetches from an external source and writes OKF Markdown
 * into the workspace's `raw/untracked/connectors/<instanceId>/`. It never runs
 * `ingest` — Donna schedules ingestion separately. It is mutating (writes both
 * to an external source cursor later and to the workspace), so it defaults to
 * requiring approval. The agent cannot plan; Donna assigns the capability.
 *
 * `communication.send-email` sends a plain-text message from the workspace's
 * own connected mailbox. It is a pure outbound action: it writes nothing into
 * the workspace and reads nothing back. It is the most consequential thing this
 * agent can do — an email cannot be un-sent — so it is always approval-gated
 * and is deliberately reachable only through `agent_execute`, never as a chat
 * tool. Operators can remove it entirely with `CONNECTORS_SEND_ENABLED=false`.
 */
export function buildDescription(config: AgentConfig): Record<string, unknown> {
  return {
    contractVersion: CONTRACT_VERSION,
    agentType: 'connectors',
    agentInstanceId: config.agentInstanceId,
    displayName: config.displayName,
    capabilities: [
      {
        id: CAPABILITY_ID,
        version: '1',
        description:
          'Collect content from an external connector source and write it as ' +
          'OKF Markdown under the workspace raw/untracked/connectors/<instanceId>/ ' +
          'directory, where the existing ingestion chain picks it up. Reads from ' +
          'the external source only; it never runs ingest and never fetches from ' +
          'other agents. Idempotent per idempotencyKey; unchanged items are skipped ' +
          'without touching the file.',
        inputSchema: {
          type: 'object',
          properties: {
            connectorId: {
              type: 'string',
              description: 'Connector family to execute (for example "google").',
            },
            instanceId: {
              type: 'string',
              description: 'Workspace-scoped connector instance (for example "google-1").',
            },
            query: {
              type: 'string',
              description: 'Provider query; Gmail uses the standard Gmail search syntax.',
            },
            maxMessages: {
              type: 'integer',
              minimum: 1,
              maximum: 500,
            },
            label: {
              type: 'string',
              description: 'Optional label for the collected batch.',
            },
            items: {
              type: 'array',
              description:
                'Optional pre-rendered OKF items ({ logicalName, okf, body }). ' +
                'When omitted, the fixture collector emits a single echo item.',
              items: { type: 'object' },
            },
          },
          additionalProperties: true,
        },
        outputSchema: { type: 'object', additionalProperties: true },
        supportedOperations: [OPERATION],
        mutationClass: 'external-source',
        defaultRequiresApproval: true,
      },
      ...(config.sendEnabled ? [buildSendCapability()] : []),
    ],
    orchestration: {
      canPlan: false,
      canExpandPlan: false,
      canExecute: true,
      canCancel: true,
      canResume: false,
      singleTaskOnly: true,
      supportsIdempotency: true,
      supportsParallelWorkers: true,
    },
    limits: {
      recommendedConcurrency: config.recommendedConcurrency,
      maxConcurrency: config.maxConcurrency,
    },
    health: { status: 'available' },
  };
}

function buildSendCapability(): Record<string, unknown> {
  return {
    id: SEND_CAPABILITY_ID,
    version: '1',
    description:
      'Send a single plain-text email from the workspace-connected mailbox ' +
      '(Gmail). Outbound only: it writes nothing into the workspace, reads no ' +
      'mailbox content, and never chains into another capability. Requires the ' +
      '"send" authorization grant on the connector instance, which is separate ' +
      'from the read grant used by collection. Idempotent per idempotencyKey: ' +
      'replaying a key returns the original outcome instead of sending twice.',
    inputSchema: {
      type: 'object',
      required: ['to', 'subject', 'body'],
      properties: {
        connectorId: {
          type: 'string',
          description: 'Connector family to send through (currently "google").',
        },
        instanceId: {
          type: 'string',
          description: 'Workspace-scoped connector instance (for example "google-1").',
        },
        to: {
          description: 'Recipient address, or list of addresses.',
          anyOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' }, minItems: 1 },
          ],
        },
        cc: {
          description: 'Optional carbon-copy recipients.',
          anyOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
          ],
        },
        bcc: {
          description: 'Optional blind carbon-copy recipients.',
          anyOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
          ],
        },
        subject: { type: 'string', description: 'Subject line (plain text).' },
        body: { type: 'string', description: 'Message body, plain text only.' },
        replyTo: { type: 'string', description: 'Optional Reply-To address.' },
        dryRun: {
          type: 'boolean',
          description:
            'Build and validate the message, report what would be sent, and ' +
            'contact no provider.',
        },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        messageId: { type: 'string' },
        threadId: { type: 'string' },
        recipients: { type: 'integer' },
        dryRun: { type: 'boolean' },
      },
      additionalProperties: true,
    },
    supportedOperations: [SEND_OPERATION],
    mutationClass: 'external-target',
    // Irreversible and externally visible: approval is not a default the
    // caller may flip off per task, it is the point of the capability.
    defaultRequiresApproval: true,
    requiresApproval: true,
  };
}
