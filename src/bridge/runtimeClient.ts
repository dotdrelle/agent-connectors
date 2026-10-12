import { errorCode, sleep } from './util.ts';

/**
 * The manager runtime, seen from the bridge: the same `/turn` and
 * `/events/stream` the served chat uses, with the runtime's service bearer.
 * Nothing here decides anything — `/turn` classifies, queues, asks for
 * approval; the bridge relays.
 */

export type RuntimeEvent = {
  id?: string;
  type: string;
  runId?: string | null;
  turnId?: string | null;
  workspace?: string | null;
  conversationId?: string | null;
  payload?: Record<string, unknown>;
};

export type TurnResult = {
  status: number;
  body: Record<string, unknown>;
};

export class RuntimeClient {
  readonly #baseUrl: string;
  readonly #token: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(options: { baseUrl: string; token?: string; fetch?: typeof fetch }) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#token = options.token;
    this.#fetch = options.fetch ?? fetch;
  }

  async turn(body: {
    workspace: string;
    input: string;
    conversationId: string;
    mode: 'agent' | 'chat';
    context?: { channel?: { kind: string; label?: string } };
  }): Promise<TurnResult> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/turn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.#auth() },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (error) {
      throw new Error(`runtime_unreachable:${errorCode(error)}`);
    }
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    return { status: response.status, body: payload };
  }

  /**
   * Follow the workspace's event stream until `signal` aborts. Reconnects with
   * a capped backoff; every drop and every recovery is reported through
   * `onStatus`, so a dead stream is said, never silent.
   */
  async follow(
    workspace: string,
    handlers: {
      event(event: RuntimeEvent): void;
      status(state: 'connected' | 'disconnected', detail?: string): void;
    },
    signal: AbortSignal,
  ): Promise<void> {
    let delay = 1_000;
    while (!signal.aborted) {
      try {
        // events=agent_event: the runtime skips the state and maintenance frames,
        // which it rebuilds per client and the bridge would only drop.
        const response = await this.#fetch(`${this.#baseUrl}/events/stream?workspace=${encodeURIComponent(workspace)}&events=agent_event`, {
          headers: { accept: 'text/event-stream', ...this.#auth() },
          signal,
        });
        if (!response.ok || !response.body) throw new Error(`runtime_stream_failed:${response.status}`);
        handlers.status('connected');
        delay = 1_000;
        await readSse(response.body, (_name, data) => {
          try {
            handlers.event(JSON.parse(data) as RuntimeEvent);
          } catch {
            // A frame that does not parse is skipped; the next one is independent.
          }
        }, 'agent_event');
        if (!signal.aborted) handlers.status('disconnected', 'runtime_stream_closed');
      } catch (error) {
        if (signal.aborted) return;
        const reason = error instanceof Error && error.message.startsWith('runtime_') ? error.message : `runtime_unreachable:${errorCode(error)}`;
        handlers.status('disconnected', reason);
      }
      await sleep(delay, signal);
      delay = Math.min(delay * 2, 30_000);
    }
  }

  #auth(): Record<string, string> {
    return this.#token ? { authorization: `Bearer ${this.#token}` } : {};
  }
}

/**
 * Minimal SSE reader: `event:` + `data:` lines, a blank line ends a frame;
 * comments ignored. With `only`, the data of other events is not even kept.
 */
export async function readSse(
  body: ReadableStream<Uint8Array>,
  onFrame: (name: string, data: string) => void,
  only?: string,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';
  let name = 'message';
  let data: string[] = [];
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (line === '') {
        if (data.length > 0 && (!only || name === only)) onFrame(name, data.join('\n'));
        name = 'message';
        data = [];
      } else if (line.startsWith(':')) {
        continue;
      } else if (line.startsWith('event:')) {
        name = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        if (!only || name === only) data.push(line.slice(5).replace(/^ /, ''));
      }
    }
  }
}
