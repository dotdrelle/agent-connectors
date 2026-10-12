import { randomBytes } from 'node:crypto';
import path from 'node:path';

import { errorCode } from '../bridge/errors.ts';
import { readJsonFile, removeFile, writeJsonFile } from '../bridge/jsonFile.ts';

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

export type TchapSession = {
  server: string;
  homeserver: string;
  issuer: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  clientId: string;
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  userId: string;
  deviceId: string;
};

export type DeviceFlow = {
  server: string;
  homeserver: string;
  issuer: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  clientId: string;
  deviceId: string;
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
  | { state: 'failed'; reason: string };

type Discovery = {
  homeserver: string;
  issuer: string;
  registrationEndpoint: string;
  deviceEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
};

/** Renew when less than this is left (tokens live 30 min): a request never races the expiry, and a short network outage still finds a valid token. */
const REFRESH_MARGIN_MS = 15 * 60_000;
const SERVER_PATTERN = /^[a-z0-9.-]+\.[a-z]{2,}$/i;

export class TchapAuth {
  readonly #dataDir: string;
  readonly #fetch: typeof fetch;
  readonly #clientUri: string;
  readonly #now: () => number;
  /** One refresh at a time: two concurrent ones would burn the rotating token. */
  #refreshing: Promise<TchapSession> | undefined;

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
    return readJsonFile<TchapSession>(this.sessionPath());
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
    const payload = await this.#postForm(discovery.deviceEndpoint, { client_id: clientId, scope }, 'tchap_device_request_failed');
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
    const response = await this.#fetch(flow.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: flow.deviceCode,
        client_id: flow.clientId,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    const error = stringField(payload, 'error');
    if (error === 'authorization_pending') return { state: 'pending' };
    if (error === 'slow_down') return { state: 'slow_down' };
    if (error || !response.ok) return { state: 'failed', reason: `tchap_device_${error || response.status}` };
    const accessToken = stringField(payload, 'access_token');
    if (!accessToken) return { state: 'failed', reason: 'tchap_token_response_invalid' };
    const whoami = await this.#whoami(flow.homeserver, accessToken);
    const session: TchapSession = {
      server: flow.server,
      homeserver: flow.homeserver,
      issuer: flow.issuer,
      tokenEndpoint: flow.tokenEndpoint,
      ...(flow.revocationEndpoint ? { revocationEndpoint: flow.revocationEndpoint } : {}),
      clientId: flow.clientId,
      accessToken,
      ...(stringField(payload, 'refresh_token') ? { refreshToken: stringField(payload, 'refresh_token') } : {}),
      expiresAt: this.#now() + (numberField(payload, 'expires_in') ?? 300) * 1000,
      userId: whoami.userId,
      deviceId: whoami.deviceId ?? flow.deviceId,
    };
    writeJsonFile(this.sessionPath(), session);
    return { state: 'approved', session };
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
    if (!options.force && session.expiresAt - this.#now() > REFRESH_MARGIN_MS) return session.accessToken;
    const refresh = this.#refresh(session).finally(() => { this.#refreshing = undefined; });
    this.#refreshing = refresh;
    return (await refresh).accessToken;
  }

  /** Revoke server-side (best effort, said when it fails) and forget locally. */
  async revoke(): Promise<{ revoked: boolean; reason?: string }> {
    const session = this.readSession();
    if (!session) return { revoked: false, reason: 'tchap_not_connected' };
    let result: { revoked: boolean; reason?: string } = { revoked: false, reason: 'tchap_revocation_unsupported' };
    if (session.revocationEndpoint) {
      try {
        const response = await this.#fetch(session.revocationEndpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: session.accessToken, client_id: session.clientId }),
          signal: AbortSignal.timeout(20_000),
        });
        result = response.ok ? { revoked: true } : { revoked: false, reason: `tchap_revocation_failed:${response.status}` };
      } catch (error) {
        result = { revoked: false, reason: `tchap_revocation_failed:${errorCode(error)}` };
      }
    }
    removeFile(this.sessionPath());
    return result;
  }

  async #refresh(session: TchapSession): Promise<TchapSession> {
    if (!session.refreshToken) throw new Error('tchap_reauthorization_required');
    const response = await this.#fetch(session.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: session.refreshToken,
        client_id: session.clientId,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    const accessToken = stringField(payload, 'access_token');
    if (!response.ok || !accessToken) {
      // invalid_grant: revoked from the account, expired by inactivity, or a
      // rotated token reused. Only a new device code repairs it.
      if (response.status === 400 || response.status === 401) throw new Error('tchap_reauthorization_required');
      throw new Error(`tchap_token_refresh_failed:${response.status}`);
    }
    const next: TchapSession = {
      ...session,
      accessToken,
      refreshToken: stringField(payload, 'refresh_token') || session.refreshToken,
      expiresAt: this.#now() + (numberField(payload, 'expires_in') ?? 300) * 1000,
    };
    writeJsonFile(this.sessionPath(), next);
    return next;
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
    const response = await this.#fetch(discovery.registrationEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'wikiLLM Donna bridge',
        client_uri: this.#clientUri,
        application_type: 'native',
        grant_types: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
        response_types: [],
        token_endpoint_auth_method: 'none',
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    const clientId = stringField(payload, 'client_id');
    if (!response.ok || !clientId) throw new Error(`tchap_client_registration_refused:${response.status}`);
    writeJsonFile(clientsPath, { ...(readJsonFile<Record<string, string>>(clientsPath) ?? {}), [discovery.issuer]: clientId });
    return clientId;
  }

  async #whoami(homeserver: string, accessToken: string): Promise<{ userId: string; deviceId?: string }> {
    const response = await this.#fetch(`${homeserver}/_matrix/client/v3/account/whoami`, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(20_000),
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    const userId = stringField(payload, 'user_id');
    if (!response.ok || !userId) throw new Error(`tchap_whoami_failed:${response.status}`);
    return { userId, ...(stringField(payload, 'device_id') ? { deviceId: stringField(payload, 'device_id') } : {}) };
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

  async #postForm(url: string, form: Record<string, string>, errorPrefix: string): Promise<Record<string, unknown>> {
    const response = await this.#fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(20_000),
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(`${errorPrefix}:${stringField(payload, 'error') || response.status}`);
    return payload;
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
