import type { RawItem } from './writeRawMarkdown.ts';

/**
 * A collector turns an `external-source.collect` task's arguments into OKF Markdown
 * items ready for the sink. Real connectors (Gmail, Slack, …) will implement
 * this same shape on top of OAuth + a source fetch; this skeleton ships a
 * dependency-free **fixture** collector so the contract and the sink can be
 * exercised end-to-end without any external credential.
 */
export type Collector = {
  /** Sink connector identifier; the sink writes under connectors/<instanceId>/. */
  readonly connectorId: string;
  collect(
    args: Record<string, unknown>,
    context: CollectorContext,
  ): RawItem[] | Promise<RawItem[]>;
};

export type CollectorContext = {
  workspace: { name: string; path: string };
  instanceId: string;
};

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * Fixture collector.
 *
 * - If `arguments.items` is provided, each entry is passed through to the sink
 *   after light validation (this is how tests and generic hosts drive it).
 * - Otherwise it emits a single deterministic "echo" item describing the
 *   request, proving the execute → sink path produces a real raw source file.
 */
export function createFixtureCollector(connectorId = 'fixture'): Collector {
  return {
    connectorId,
    collect(args: Record<string, unknown>): RawItem[] {
      const provided = Array.isArray(args.items) ? args.items : undefined;
      if (provided) {
        return provided.map((entry, index) => normalizeItem(entry, index, connectorId));
      }
      const label = asString(args.label) ?? 'fixture-collect';
      const timestamp = new Date().toISOString();
      return [
        {
          logicalName: `${label}-${timestamp.slice(0, 10)}`,
          okf: {
            type: 'connector-fixture',
            title: label,
            resource: connectorId,
            timestamp,
          },
          body: [
            `# ${label}`,
            '',
            'Fixture item produced by the connectors executor skeleton.',
            'No external source was contacted.',
          ].join('\n'),
        },
      ];
    },
  };
}

function normalizeItem(entry: unknown, index: number, connectorId: string): RawItem {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`items[${index}] must be an object.`);
  }
  const record = entry as Record<string, unknown>;
  const logicalName = asString(record.logicalName);
  if (!logicalName) {
    throw new Error(`items[${index}].logicalName is required.`);
  }
  const okf = record.okf;
  if (!okf || typeof okf !== 'object' || Array.isArray(okf)) {
    throw new Error(`items[${index}].okf must be an object.`);
  }
  if (typeof (okf as Record<string, unknown>).type !== 'string') {
    throw new Error(`items[${index}].okf.type is required.`);
  }
  const body = typeof record.body === 'string' ? record.body : '';
  return {
    logicalName,
    okf: { resource: connectorId, ...(okf as RawItem['okf']) },
    body,
  };
}
