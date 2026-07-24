import type { AgentConfig } from './config.ts';

export const CONTRACT_VERSION = '1';
export const CAPABILITY_ID = 'external-source.collect';
export const OPERATION = 'collect';

/**
 * The generic multi-agent orchestration contract, executor-only.
 *
 * `external-source.collect` fetches from an external source and writes OKF Markdown
 * into the workspace's `raw/untracked/connectors/<instanceId>/`. It never runs
 * `ingest` — Donna schedules ingestion separately. It is mutating (writes both
 * to an external source cursor later and to the workspace), so it defaults to
 * requiring approval. The agent cannot plan; Donna assigns the capability.
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
    ],
    orchestration: {
      canPlan: false,
      canExpandPlan: false,
      canExecute: true,
      canCancel: true,
      canResume: false,
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
