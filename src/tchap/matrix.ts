import { randomBytes } from 'node:crypto';

import { errorCode } from '../bridge/errors.ts';

/**
 * The handful of Matrix client-server calls the bridge needs, over plain
 * `fetch` — no SDK. Option A (an unencrypted forum guarded by the bridge)
 * needs no crypto, and `fetch` already honours the container's proxy through
 * NODE_USE_ENV_PROXY. Errors are `<code>:<status>[:<errcode>]`, never a body:
 * a Matrix error can echo the request.
 */

export type MatrixEvent = {
  event_id: string;
  type: string;
  sender: string;
  origin_server_ts?: number;
  state_key?: string;
  content?: Record<string, unknown>;
};

export type SyncResponse = {
  next_batch: string;
  rooms?: {
    join?: Record<string, {
      timeline?: { events?: MatrixEvent[]; limited?: boolean };
      state?: { events?: MatrixEvent[] };
    }>;
    leave?: Record<string, unknown>;
  };
};

/** Content key marking a message the bridge sent: its echo is never read back as a command. */
export const BRIDGE_MARKER = 'fr.wikillm.bridge';

export class MatrixError extends Error {
  readonly status: number;
  readonly errcode: string;
  constructor(code: string, status: number, errcode = '') {
    super(`${code}:${status}${errcode ? `:${errcode}` : ''}`);
    this.status = status;
    this.errcode = errcode;
  }
}

export class MatrixClient {
  readonly homeserver: string;
  readonly #token: (force: boolean) => Promise<string>;
  readonly #fetch: typeof fetch;

  constructor(options: {
    homeserver: string;
    /** Returns a valid access token; `force` asks for a renewal after a refusal. */
    token: (force: boolean) => Promise<string>;
    fetch?: typeof fetch;
  }) {
    this.homeserver = options.homeserver.replace(/\/+$/, '');
    this.#token = options.token;
    this.#fetch = options.fetch ?? fetch;
  }

  async whoami(): Promise<{ user_id: string; device_id?: string }> {
    return this.#request('GET', '/account/whoami');
  }

  async resolveAlias(alias: string): Promise<string> {
    const payload = await this.#request<{ room_id?: string }>('GET', `/directory/room/${encodeURIComponent(alias)}`);
    if (!payload.room_id) throw new Error('tchap_alias_unknown');
    return payload.room_id;
  }

  async joinRoom(roomIdOrAlias: string): Promise<string> {
    const payload = await this.#request<{ room_id?: string }>('POST', `/join/${encodeURIComponent(roomIdOrAlias)}`, {});
    return payload.room_id ?? roomIdOrAlias;
  }

  /** A state event's content, or `undefined` when the room has none of that type (404). */
  async getState(roomId: string, type: string, stateKey = ''): Promise<Record<string, unknown> | undefined> {
    try {
      return await this.#request('GET', `/rooms/${encodeURIComponent(roomId)}/state/${encodeURIComponent(type)}/${encodeURIComponent(stateKey)}`);
    } catch (error) {
      if (error instanceof MatrixError && error.status === 404) return undefined;
      throw error;
    }
  }

  async putState(roomId: string, type: string, content: Record<string, unknown>, stateKey = ''): Promise<void> {
    await this.#request('PUT', `/rooms/${encodeURIComponent(roomId)}/state/${encodeURIComponent(type)}/${encodeURIComponent(stateKey)}`, content);
  }

  async setDirectoryVisibility(roomId: string, visibility: 'public' | 'private'): Promise<void> {
    await this.#request('PUT', `/directory/list/room/${encodeURIComponent(roomId)}`, { visibility });
  }

  async joinedMembers(roomId: string): Promise<string[]> {
    const payload = await this.#request<{ joined?: Record<string, unknown> }>('GET', `/rooms/${encodeURIComponent(roomId)}/joined_members`);
    return Object.keys(payload.joined ?? {});
  }

  async joinedRooms(): Promise<string[]> {
    const payload = await this.#request<{ joined_rooms?: string[] }>('GET', '/joined_rooms');
    return payload.joined_rooms ?? [];
  }

  /** A room's whole current state in one call. */
  async roomState(roomId: string): Promise<MatrixEvent[]> {
    const payload = await this.#request<unknown>('GET', `/rooms/${encodeURIComponent(roomId)}/state`);
    return Array.isArray(payload) ? payload as MatrixEvent[] : [];
  }

  async sync(options: { since?: string; timeoutMs: number; filter: Record<string, unknown>; signal?: AbortSignal }): Promise<SyncResponse> {
    const query = new URLSearchParams({
      timeout: String(options.timeoutMs),
      filter: JSON.stringify(options.filter),
      ...(options.since ? { since: options.since } : {}),
    });
    return this.#request('GET', `/sync?${query}`, undefined, {
      timeoutMs: options.timeoutMs + 30_000,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  /** Send a message marked as the bridge's own; returns its event id. */
  async sendMessage(roomId: string, content: Record<string, unknown>): Promise<string> {
    const txnId = `bridge-${Date.now()}-${randomBytes(4).toString('hex')}`;
    const payload = await this.#request<{ event_id?: string }>(
      'PUT',
      `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
      { ...content, [BRIDGE_MARKER]: true },
    );
    if (!payload.event_id) throw new Error('tchap_send_failed:no_event_id');
    return payload.event_id;
  }

  async kick(roomId: string, userId: string, reason: string): Promise<void> {
    await this.#request('POST', `/rooms/${encodeURIComponent(roomId)}/kick`, { user_id: userId, reason });
  }

  async ban(roomId: string, userId: string, reason: string): Promise<void> {
    await this.#request('POST', `/rooms/${encodeURIComponent(roomId)}/ban`, { user_id: userId, reason });
  }

  async unban(roomId: string, userId: string): Promise<void> {
    await this.#request('POST', `/rooms/${encodeURIComponent(roomId)}/unban`, { user_id: userId });
  }

  async invite(roomId: string, userId: string): Promise<void> {
    await this.#request('POST', `/rooms/${encodeURIComponent(roomId)}/invite`, { user_id: userId });
  }

  /** A member's current membership (`join`, `ban`, `invite`, `leave`…), or undefined. */
  async membership(roomId: string, userId: string): Promise<string | undefined> {
    const content = await this.getState(roomId, 'm.room.member', userId);
    return typeof content?.membership === 'string' ? content.membership : undefined;
  }

  async #request<T = Record<string, unknown>>(
    method: string,
    pathAndQuery: string,
    body?: unknown,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    const call = async (force: boolean) => {
      const token = await this.#token(force);
      const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000);
      try {
        return await this.#fetch(`${this.homeserver}/_matrix/client/v3${pathAndQuery}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout,
        });
      } catch (error) {
        if (options.signal?.aborted) throw error;
        throw new Error(`tchap_unreachable:${errorCode(error)}`);
      }
    };
    let response = await call(false);
    // One renewal on an expired token, then the refusal is real.
    if (response.status === 401) response = await call(true);
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      const errcode = typeof payload.errcode === 'string' ? payload.errcode : '';
      throw new MatrixError('tchap_request_failed', response.status, errcode);
    }
    return payload as T;
  }
}
