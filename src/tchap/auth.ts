import { randomBytes } from 'node:crypto';
import path from 'node:path';

import { readJsonFile, removeFile, writeJsonFile } from '../bridge/jsonFile.ts';
import { errorCode, errorMessage } from '../bridge/util.ts';
import { MatrixClient } from './matrix.ts';

/**
 * Tchap sign-in for the bridge, by OAuth 2.0 device authorization (RFC 8628)
 * against the server's delegated authentication service (MAS).
 *
 * Measured on agent.dev-durable (2026-10-12): the homeserver announces its
 * issuer in `/.well-known/matrix/client`, the issuer offers dynamic client
 * registration and the device_code grant, access tokens live 30 minutes and
 * the refresh token ROTATES — the previous one is refused (400) as soon as the
 * next one exists. Everything here is outbound: the bridge asks for a code,
 * the user validates it on their phone, the bridge polls for the tokens.
 */

/** What a sign-in is bound to: the server, its sign-in service, our client and the bridge's device. */
type Grant = {
  server: string;
  homeserver: string;
  issuer: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  clientId: string;
  deviceId: string;
};

export type TchapSession = Grant & {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  /** Lifetime the server granted to the current access token, in ms: the renewal margin is a share of it. */
  lifetimeMs?: number;
  userId: string;
};

export type DeviceFlow = Grant & {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  intervalSeconds: number;
  /** Epoch milliseconds. */
  expiresAt: number;
};

export type PollResult =
  | { state: 'pending' }
  | { state: 'slow_down' }
  | { state: 'approved'; session: TchapSession }
  | { state: 'failed'; reason: string }
  /** A network or server hiccup: the code may still be confirmed, poll again. */
  | { state: 'retry'; reason: string };

type Discovery = {
  homeserver: string;
  issuer: string;
  registrationEndpoint: string;
  deviceEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
};

type Answer = { status: number; ok: boolean; payload: Record<string, unknown> };

/** Renew when less than this is left (tokens live 30 min): a request never races the expiry, and a short network outage still finds a valid token. */
const REFRESH_MARGIN_MS = 15 * 60_000;

/**
 * 15 minutes before expiry for the 30-minute tokens measured on Tchap, but
 * never more than half the lifetime: a short-lived token (or a missing
 * `expires_in`) would otherwise be renewed — and its refresh token rotated —
 * on every single request.
 */
function renewalMargin(session: TchapSession): number {
  const lifetime = session.lifetimeMs ?? 30 * 60_000;
  return Math.min(REFRESH_MARGIN_MS, lifetime / 2);
}

const SERVER_PATTERN = /^[a-z0-9.-]+\.[a-z]{2,}$/i;

export class TchapAuth {
  readonly #dataDir: string;
  readonly #fetch: typeof fetch;
  readonly #clientUri: string;
  readonly #now: () => number;
  /** One refresh at a time: two concurrent ones would burn the rotating token. */
  #refreshing: Promise<TchapSession> | undefined;
  /** The session file, parsed once (`null`: none) — every Matrix request asks for the token. */
  #session: TchapSession | null | undefined;

  constructor(options: {
    dataDir: string;
    fetch?: typeof fetch;
    clientUri?: string;
    now?: () => number;
  }) {
    this.#dataDir = options.dataDir;
    this.#fetch = options.fetch ?? fetch;
    this.#clientUri = options.clientUri ?? 'https://github.com/dotdrelle';
    this.#now = options.now ?? Date.now;
  }

  /**
   * Agent-wide, like CME's Confluence credentials: ONE Tchap sign-in serves
   * every workspace. Workspaces stay apart by their forum (state.json under
   * `<dataDir>/<workspace>/tchap/`), never by their identity.
   */
  sessionPath(): string {
    return path.join(this.#dataDir, 'tchap-session.json');
  }

  /**
   * Agent-wide, like CME's credentials: one client registration per Tchap
   * sign-in service, shared by every workspace of this agent.
   */
  #clientsPath(): string {
    return path.join(this.#dataDir, 'tchap-clients.json');
  }

  readSession(): TchapSession | undefined {
    if (this.#session === undefined) this.#session = readJsonFile<TchapSession>(this.sessionPath()) ?? null;
    return this.#session ?? undefined;
  }

  #saveSession(session: TchapSession): TchapSession {
    writeJsonFile(this.sessionPath(), session);
    this.#session = session;
    return session;
  }

  /** Drop the session locally, without telling the server (it already refused it). */
  forget(): void {
    removeFile(this.sessionPath());
    this.#session = null;
  }

  async startDeviceFlow(server: string): Promise<DeviceFlow> {
    if (!SERVER_PATTERN.test(server)) throw new Error('tchap_server_invalid');
    const discovery = await this.#discover(server);
    const clientId = await this.#ensureClient(discovery);
    const deviceId = randomDeviceId();
    const scope = [
      'openid',
      'urn:matrix:org.matrix.msc2967.client:api:*',
      `urn:matrix:org.matrix.msc2967.client:device:${deviceId}`,
    ].join(' ');
    const { ok, status, payload } = await this.#post(discovery.deviceEndpoint, { client_id: clientId, scope });
    if (!ok) throw new Error(`tchap_device_request_failed:${stringField(payload, 'error') || status}`);
    const deviceCode = stringField(payload, 'device_code');
    const userCode = stringField(payload, 'user_code');
    const verificationUri = stringField(payload, 'verification_uri');
    if (!deviceCode || !userCode || !verificationUri) throw new Error('tchap_device_response_invalid');
    return {
      server,
      homeserver: discovery.homeserver,
      issuer: discovery.issuer,
      tokenEndpoint: discovery.tokenEndpoint,
      ...(discovery.revocationEndpoint ? { revocationEndpoint: discovery.revocationEndpoint } : {}),
      clientId,
      deviceId,
      deviceCode,
      userCode,
      verificationUri,
      ...(stringField(payload, 'verification_uri_complete')
        ? { verificationUriComplete: stringField(payload, 'verification_uri_complete') }
        : {}),
      intervalSeconds: Math.max(2, numberField(payload, 'interval') ?? 5),
      expiresAt: this.#now() + (numberField(payload, 'expires_in') ?? 600) * 1000,
    };
  }

  /** One poll of the token endpoint. The caller owns the loop and its interval. */
  async pollDeviceFlow(flow: DeviceFlow): Promise<PollResult> {
    if (this.#now() > flow.expiresAt) return { state: 'failed', reason: 'tchap_device_code_expired' };
    let answer: Answer;
    try {
      answer = await this.#post(flow.tokenEndpoint, {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: flow.deviceCode,
        client_id: flow.clientId,
      });
    } catch (error) {
      // A proxy blip while the user is confirming on their phone must not end
      // the sign-in: the code stays valid, the next poll can still collect it.
      return { state: 'retry', reason: errorMessage(error) };
    }
    const { ok, status, payload } = answer;
    const error = stringField(payload, 'error');
    if (error === 'authorization_pending') return { state: 'pending' };
    if (error === 'slow_down') return { state: 'slow_down' };
    if (!error && status >= 500) return { state: 'retry', reason: `tchap_device_${status}` };
    if (error || !ok) return { state: 'failed', reason: `tchap_device_${error || status}` };
    const accessToken = stringField(payload, 'access_token');
    if (!accessToken) return { state: 'failed', reason: 'tchap_token_response_invalid' };
    const lifetimeMs = (numberField(payload, 'expires_in') ?? 300) * 1000;
    const { server, homeserver, issuer, tokenEndpoint, revocationEndpoint, clientId, deviceId } = flow;
    // The device code is spent the moment the tokens come back: keep them
    // FIRST, so a failing identity lookup cannot throw the sign-in away.
    const session = this.#saveSession({
      server, homeserver, issuer, tokenEndpoint, ...(revocationEndpoint ? { revocationEndpoint } : {}), clientId, deviceId,
      accessToken,
      ...(stringField(payload, 'refresh_token') ? { refreshToken: stringField(payload, 'refresh_token') } : {}),
      expiresAt: this.#now() + lifetimeMs,
      lifetimeMs,
      userId: '',
    });
    return { state: 'approved', session: await this.identity().catch(() => session) };
  }

  /**
   * The signed-in account, looked up once and kept in the session. A lookup
   * that failed right after sign-in is retried here, by whoever needs it.
   */
  async identity(): Promise<TchapSession> {
    const session = this.readSession();
    if (!session) throw new Error('tchap_not_connected');
    if (session.userId) return session;
    const client = new MatrixClient({ homeserver: session.homeserver, token: (force) => this.accessToken({ force }), fetch: this.#fetch });
    const whoami = await client.whoami();
    const current = this.readSession() ?? session;
    return this.#saveSession({ ...current, userId: whoami.user_id, deviceId: whoami.device_id ?? current.deviceId });
  }

  /**
   * A valid access token, renewed first when it is about to expire (or when
   * `force` says the server just refused it). The new pair is WRITTEN before
   * it is returned: the old refresh token is dead the moment the new one
   * exists, so a crash between the two would otherwise lose the session.
   */
  async accessToken(options: { force?: boolean } = {}): Promise<string> {
    if (this.#refreshing) return (await this.#refreshing).accessToken;
    const session = this.readSession();
    if (!session) throw new Error('tchap_not_connected');
    if (!options.force && session.expiresAt - this.#now() > renewalMargin(session)) return session.accessToken;
    const refresh = this.#refresh(session).finally(() => { this.#refreshing = undefined; });
    this.#refreshing = refresh;
    return (await refresh).accessToken;
  }

  /**
   * Revoke server-side and forget locally. Both tokens are revoked: RFC 7009
   * leaves it to the server whether revoking the access token ends the
   * session, and the rotating refresh token is what could mint new ones.
   * Best effort, and said when it fails.
   */
  async revoke(): Promise<{ revoked: boolean; reason?: string }> {
    const session = this.readSession();
    if (!session) return { revoked: false, reason: 'tchap_not_connected' };
    let result: { revoked: boolean; reason?: string } = { revoked: false, reason: 'tchap_revocation_unsupported' };
    const endpoint = session.revocationEndpoint;
    if (endpoint) {
      const tokens: Array<[string, string]> = [
        ...(session.refreshToken ? [[session.refreshToken, 'refresh_token'] as [string, string]] : []),
        [session.accessToken, 'access_token'],
      ];
      const failures = (await Promise.all(tokens.map(async ([token, hint]) => {
        try {
          const { ok, status } = await this.#post(endpoint, { token, token_type_hint: hint, client_id: session.clientId });
          return ok ? '' : `${hint}:${status}`;
        } catch (error) {
          return `${hint}:${errorMessage(error)}`;
        }
      }))).filter(Boolean);
      result = failures.length === 0 ? { revoked: true } : { revoked: false, reason: `tchap_revocation_failed:${failures.join(',')}` };
    }
    this.forget();
    return result;
  }

  async #refresh(session: TchapSession): Promise<TchapSession> {
    if (!session.refreshToken) throw new Error('tchap_reauthorization_required');
    const { ok, status, payload } = await this.#post(session.tokenEndpoint, {
      grant_type: 'refresh_token',
      refresh_token: session.refreshToken,
      client_id: session.clientId,
    });
    const accessToken = stringField(payload, 'access_token');
    if (!ok || !accessToken) {
      // invalid_grant: revoked from the account, expired by inactivity, or a
      // rotated token reused. Only a new device code repairs it.
      if (status === 400 || status === 401) throw new Error('tchap_reauthorization_required');
      throw new Error(`tchap_token_refresh_failed:${status}`);
    }
    const lifetimeMs = (numberField(payload, 'expires_in') ?? 300) * 1000;
    return this.#saveSession({
      ...session,
      accessToken,
      refreshToken: stringField(payload, 'refresh_token') || session.refreshToken,
      expiresAt: this.#now() + lifetimeMs,
      lifetimeMs,
    });
  }

  async #discover(server: string): Promise<Discovery> {
    const wellKnown = await this.#getJson(`https://${server}/.well-known/matrix/client`, 'tchap_discovery_failed');
    const homeserver = String((wellKnown['m.homeserver'] as Record<string, unknown> | undefined)?.base_url ?? '').replace(/\/+$/, '');
    const auth = (wellKnown['m.authentication'] ?? wellKnown['org.matrix.msc2965.authentication']) as Record<string, unknown> | undefined;
    const issuer = String(auth?.issuer ?? '').replace(/\/+$/, '');
    if (!homeserver) throw new Error('tchap_discovery_failed:no_homeserver');
    if (!issuer) throw new Error('tchap_delegated_auth_unavailable');
    const openid = await this.#getJson(`${issuer}/.well-known/openid-configuration`, 'tchap_discovery_failed');
    const registrationEndpoint = stringField(openid, 'registration_endpoint');
    const deviceEndpoint = stringField(openid, 'device_authorization_endpoint');
    const tokenEndpoint = stringField(openid, 'token_endpoint');
    if (!registrationEndpoint || !deviceEndpoint || !tokenEndpoint) throw new Error('tchap_device_code_unavailable');
    return {
      homeserver,
      issuer,
      registrationEndpoint,
      deviceEndpoint,
      tokenEndpoint,
      ...(stringField(openid, 'revocation_endpoint') ? { revocationEndpoint: stringField(openid, 'revocation_endpoint') } : {}),
    };
  }

  /** Register once per sign-in service, for all workspaces: re-registering on every connect would litter the server. */
  async #ensureClient(discovery: Discovery): Promise<string> {
    const clientsPath = this.#clientsPath();
    const clients = readJsonFile<Record<string, string>>(clientsPath) ?? {};
    const known = clients[discovery.issuer];
    if (known) return known;
    const { ok, status, payload } = await this.#post(discovery.registrationEndpoint, {
      json: {
        client_name: 'wikiLLM Donna bridge',
        client_uri: this.#clientUri,
        application_type: 'native',
        grant_types: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
        response_types: [],
        token_endpoint_auth_method: 'none',
      },
    });
    const clientId = stringField(payload, 'client_id');
    if (!ok || !clientId) throw new Error(`tchap_client_registration_refused:${status}`);
    writeJsonFile(clientsPath, { ...clients, [discovery.issuer]: clientId });
    return clientId;
  }

  async #getJson(url: string, errorPrefix: string): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.#fetch(url, { signal: AbortSignal.timeout(20_000) });
    } catch (error) {
      throw new Error(`${errorPrefix}:${errorCode(error)}`);
    }
    if (!response.ok) throw new Error(`${errorPrefix}:${response.status}`);
    return await response.json() as Record<string, unknown>;
  }

  /**
   * One POST to the sign-in service — a form, or `{ json }`. Any HTTP answer
   * comes back with its parsed body; a network failure throws
   * `tchap_unreachable:<code>`.
   */
  async #post(url: string, body: Record<string, string> | { json: unknown }): Promise<Answer> {
    const json = 'json' in body;
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: 'POST',
        headers: { 'content-type': json ? 'application/json' : 'application/x-www-form-urlencoded' },
        body: json ? JSON.stringify(body.json) : new URLSearchParams(body as Record<string, string>),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw new Error(`tchap_unreachable:${errorCode(error)}`);
    }
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    return { status: response.status, ok: response.ok, payload };
  }
}

function randomDeviceId(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  return [...randomBytes(10)].map((byte) => alphabet[byte % alphabet.length]).join('');
}

function stringField(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === 'string' ? value : '';
}

function numberField(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
