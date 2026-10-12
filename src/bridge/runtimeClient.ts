import { errorCode } from './errors.ts';

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
        const response = await this.#fetch(`${this.#baseUrl}/events/stream?workspace=${encodeURIComponent(workspace)}`, {
          headers: { accept: 'text/event-stream', ...this.#auth() },
          signal,
        });
        if (!response.ok || !response.body) throw new Error(`runtime_stream_failed:${response.status}`);
        handlers.status('connected');
        delay = 1_000;
        await readSse(response.body, (name, data) => {
          if (name !== 'agent_event') return;
          try {
            handlers.event(JSON.parse(data) as RuntimeEvent);
          } catch {
            // A frame that does not parse is skipped; the next one is independent.
          }
        });
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

/** Minimal SSE reader: `event:` + `data:` lines, a blank line ends a frame; comments ignored. */
export async function readSse(
  body: ReadableStream<Uint8Array>,
  onFrame: (name: string, data: string) => void,
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
        if (data.length > 0) onFrame(name, data.join('\n'));
        name = 'message';
        data = [];
      } else if (line.startsWith(':')) {
        continue;
      } else if (line.startsWith('event:')) {
        name = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        data.push(line.slice(5).replace(/^ /, ''));
      }
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
