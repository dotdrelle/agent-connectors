import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { AUTH_PROVIDERS } from './authProviders.ts';
import {
  GMAIL_READONLY_SCOPE,
  type GoogleTokens,
  GoogleTokenProvider,
} from './googleTokens.ts';

const SAFE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62})?$/i;

type StatePayload = {
  version: 1;
  provider: 'google';
  workspace: string;
  instanceId: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
};

type PendingAuthorization = {
  version: 1;
  payload: StatePayload;
  codeVerifier: string;
  redirectUri: string;
};

export type GoogleOAuthServiceOptions = {
  dataDir: string;
  clientId: string;
  clientSecret?: string;
  callbackUrl: string;
  stateSecret: string;
  tokens: GoogleTokenProvider;
  stateTtlSeconds?: number;
  fetch?: typeof fetch;
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
};

export class GoogleOAuthService {
  readonly #dataDir: string;
  readonly #clientId: string;
  readonly #clientSecret?: string;
  readonly #callbackUrl: string;
  readonly #stateSecret: string;
  readonly #tokens: GoogleTokenProvider;
  readonly #stateTtlMs: number;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #randomBytes: (size: number) => Buffer;

  constructor(options: GoogleOAuthServiceOptions) {
    this.#dataDir = path.resolve(options.dataDir);
    this.#clientId = required(options.clientId, 'GOOGLE_CLIENT_ID');
    this.#clientSecret = optional(options.clientSecret);
    this.#callbackUrl = validateCallbackUrl(options.callbackUrl);
    this.#stateSecret = required(options.stateSecret, 'OAUTH_STATE_SECRET');
    if (Buffer.byteLength(this.#stateSecret, 'utf8') < 32) {
      throw new Error('OAUTH_STATE_SECRET must contain at least 32 bytes.');
    }
    this.#tokens = options.tokens;
    const ttlSeconds = options.stateTtlSeconds ?? 600;
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 3_600) {
      throw new Error('OAuth state TTL must be between 60 and 3600 seconds.');
    }
    this.#stateTtlMs = ttlSeconds * 1_000;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#randomBytes = options.randomBytes ?? randomBytes;
  }

  start(workspace: string, instanceId: string): {
    authorizationUrl: string;
    expiresAt: string;
  } {
    validateId(workspace, 'workspace');
    validateId(instanceId, 'instanceId');
    if (instanceId !== 'google' && !instanceId.startsWith('google-')) {
      throw new Error('instanceId must identify a Google connector.');
    }
    const now = this.#now();
    const payload: StatePayload = {
      version: 1,
      provider: 'google',
      workspace,
      instanceId,
      nonce: this.#randomBytes(24).toString('base64url'),
      issuedAt: now,
      expiresAt: now + this.#stateTtlMs,
    };
    const codeVerifier = this.#randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');
    const pending: PendingAuthorization = {
      version: 1,
      payload,
      codeVerifier,
      redirectUri: this.#callbackUrl,
    };
    const pendingPath = this.#pendingPath(payload);
    mkdirSync(path.dirname(pendingPath), { recursive: true });
    atomicWriteJson(pendingPath, pending);

    const provider = AUTH_PROVIDERS.google;
    const url = new URL(provider.authorizationUrl);
    url.searchParams.set('client_id', this.#clientId);
    url.searchParams.set('redirect_uri', this.#callbackUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', provider.scopes.join(' '));
    url.searchParams.set('state', this.#sign(payload));
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    for (const [key, value] of Object.entries(provider.authorizationParams)) {
      url.searchParams.set(key, value);
    }
    return {
      authorizationUrl: url.toString(),
      expiresAt: new Date(payload.expiresAt).toISOString(),
    };
  }

  async complete(input: { state: string; code: string }): Promise<{
    workspace: string;
    instanceId: string;
  }> {
    const payload = this.#verify(input.state);
    const pendingPath = this.#pendingPath(payload);
    const claimedPath = `${pendingPath}.consuming-${randomUUID()}`;
    try {
      // Atomic claim: exactly one concurrent callback can move the pending
      // file. Every loser observes ENOENT and gets a stable already-used code.
      renameSync(pendingPath, claimedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error('oauth_state_already_used_or_unknown');
      }
      throw error;
    }
    let pending: PendingAuthorization;
    try {
      pending = JSON.parse(readFileSync(claimedPath, 'utf8')) as PendingAuthorization;
    } finally {
      // Consume before the network call. A timeout has an ambiguous outcome
      // and must require a fresh authorization attempt rather than code replay.
      rmSync(claimedPath, { force: true });
    }
    if (
      pending.version !== 1 ||
      JSON.stringify(pending.payload) !== JSON.stringify(payload) ||
      pending.redirectUri !== this.#callbackUrl ||
      typeof pending.codeVerifier !== 'string'
    ) {
      throw new Error('oauth_pending_state_invalid');
    }
    const code = required(input.code, 'OAuth code');
    const provider = AUTH_PROVIDERS.google;
    const tokenRequest = new URLSearchParams({
      client_id: this.#clientId,
      code,
      code_verifier: pending.codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: pending.redirectUri,
    });
    if (this.#clientSecret) tokenRequest.set('client_secret', this.#clientSecret);
    const response = await this.#fetch(provider.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: tokenRequest,
    });
    if (!response.ok) throw new Error(`oauth_code_exchange_failed:${response.status}`);
    const tokenPayload = (await response.json()) as Record<string, unknown>;
    const accessToken = optional(tokenPayload.access_token);
    if (!accessToken) throw new Error('oauth_code_exchange_invalid_response');
    const returnedScopes = optional(tokenPayload.scope)?.split(/\s+/).filter(Boolean);
    if (returnedScopes && !returnedScopes.includes(GMAIL_READONLY_SCOPE)) {
      throw new Error('gmail_readonly_scope_missing');
    }
    let previousRefreshToken: string | undefined;
    try {
      previousRefreshToken = this.#tokens.read(
        payload.workspace,
        payload.instanceId,
      ).refreshToken;
    } catch {
      // First authorization has no previous token to preserve.
    }
    const expiresIn =
      typeof tokenPayload.expires_in === 'number' &&
      Number.isFinite(tokenPayload.expires_in)
        ? Math.max(0, tokenPayload.expires_in)
        : 3_600;
    const tokens: GoogleTokens = {
      accessToken,
      refreshToken: optional(tokenPayload.refresh_token) ?? previousRefreshToken,
      expiresAt: new Date(this.#now() + expiresIn * 1_000).toISOString(),
      tokenType: optional(tokenPayload.token_type) ?? 'Bearer',
      // OAuth token responses may omit `scope` when it is identical to the
      // authorization request. Preserve that distinction for auditability.
      scopes: returnedScopes ?? [...AUTH_PROVIDERS.google.scopes],
      scopeSource: returnedScopes
        ? 'token-response'
        : 'authorization-request-default',
    };
    this.#tokens.write(payload.workspace, payload.instanceId, tokens);
    return { workspace: payload.workspace, instanceId: payload.instanceId };
  }

  #sign(payload: StatePayload): string {
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const signature = createHmac('sha256', this.#stateSecret)
      .update(encoded)
      .digest('base64url');
    return `${encoded}.${signature}`;
  }

  #verify(state: string): StatePayload {
    const [encoded, signature, extra] = state.split('.');
    if (!encoded || !signature || extra) throw new Error('oauth_state_invalid');
    const expected = createHmac('sha256', this.#stateSecret).update(encoded).digest();
    let provided: Buffer;
    try {
      provided = Buffer.from(signature, 'base64url');
    } catch {
      throw new Error('oauth_state_invalid');
    }
    if (
      provided.toString('base64url') !== signature ||
      provided.length !== expected.length ||
      !timingSafeEqual(provided, expected)
    ) {
      throw new Error('oauth_state_invalid');
    }
    let payload: StatePayload;
    try {
      payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    } catch {
      throw new Error('oauth_state_invalid');
    }
    if (
      payload.version !== 1 ||
      payload.provider !== 'google' ||
      !Number.isSafeInteger(payload.issuedAt) ||
      !Number.isSafeInteger(payload.expiresAt)
    ) {
      throw new Error('oauth_state_invalid');
    }
    validateId(payload.workspace, 'workspace');
    validateId(payload.instanceId, 'instanceId');
    if (!/^[a-zA-Z0-9_-]{32}$/.test(payload.nonce)) {
      throw new Error('oauth_state_invalid');
    }
    const now = this.#now();
    if (payload.expiresAt <= now || payload.issuedAt > now + 30_000) {
      throw new Error('oauth_state_expired');
    }
    return payload;
  }

  #pendingPath(payload: StatePayload): string {
    return path.join(
      this.#dataDir,
      payload.workspace,
      payload.instanceId,
      'oauth',
      'pending',
      `${payload.nonce}.json`,
    );
  }
}

function required(value: unknown, label: string): string {
  const clean = optional(value);
  if (!clean) throw new Error(`${label} is required.`);
  return clean;
}

function optional(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function validateId(value: string, label: string): void {
  if (!SAFE_ID.test(value) || value === '.' || value === '..') {
    throw new Error(`${label} must be a safe identifier.`);
  }
}

function validateCallbackUrl(value: string): string {
  const url = new URL(required(value, 'GOOGLE_OAUTH_CALLBACK_URL'));
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error(
      'GOOGLE_OAUTH_CALLBACK_URL must use HTTPS, except explicit localhost mode.',
    );
  }
  return url.toString();
}

function atomicWriteJson(filePath: string, payload: PendingAuthorization): void {
  const tempPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  let fd: number | undefined;
  try {
    fd = openSync(tempPath, 'wx', 0o600);
    writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tempPath, filePath);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    rmSync(tempPath, { force: true });
    throw error;
  }
}
