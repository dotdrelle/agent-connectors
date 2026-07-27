import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const SAFE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62})?$/i;
const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

/**
 * A *grant* is the user-facing unit of authorization: `read` powers
 * `external-source.collect`, `send` powers `communication.send-email`. Scopes
 * stay an implementation detail of the provider, so a capability never has to
 * name a Google URL, and a workspace can hold one grant without the other.
 */
export type GoogleGrant = 'read' | 'send';

export const GOOGLE_GRANTS: readonly GoogleGrant[] = ['read', 'send'];

export const GRANT_SCOPES: Readonly<Record<GoogleGrant, string>> = {
  read: GMAIL_READONLY_SCOPE,
  send: GMAIL_SEND_SCOPE,
};

/**
 * Distinct error codes per grant: the orchestrator surfaces them verbatim, and
 * "you never authorized sending" must not read as "your connection is broken".
 */
export const MISSING_GRANT_ERROR: Readonly<Record<GoogleGrant, string>> = {
  read: 'gmail_readonly_scope_missing',
  send: 'gmail_send_scope_missing',
};

/** Grants actually covered by a stored scope list. */
export function grantsFromScopes(scopes: readonly string[]): GoogleGrant[] {
  return GOOGLE_GRANTS.filter((grant) => scopes.includes(GRANT_SCOPES[grant]));
}

export function scopesForGrants(grants: readonly GoogleGrant[]): string[] {
  const unique = new Set(grants.map((grant) => GRANT_SCOPES[grant]));
  return [...unique];
}

export function normalizeGrants(value: unknown, fallback: GoogleGrant[] = ['read']): GoogleGrant[] {
  if (value === undefined) return [...fallback];
  const raw = Array.isArray(value) ? value : [value];
  const grants = raw.map((entry) => {
    if (typeof entry !== 'string' || !GOOGLE_GRANTS.includes(entry as GoogleGrant)) {
      throw new Error('grants must contain only "read" or "send".');
    }
    return entry as GoogleGrant;
  });
  return grants.length === 0 ? [...fallback] : [...new Set(grants)];
}

export type GoogleTokens = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  tokenType?: string;
  scopes?: string[];
  scopeSource?: 'token-response' | 'authorization-request-default';
};

export type GoogleTokenProviderOptions = {
  dataDir: string;
  clientId?: string;
  clientSecret?: string;
  tokenUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
};

export class GoogleTokenProvider {
  readonly #dataDir: string;
  readonly #clientId?: string;
  readonly #clientSecret?: string;
  readonly #tokenUrl: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;

  constructor(options: GoogleTokenProviderOptions) {
    this.#dataDir = path.resolve(options.dataDir);
    this.#clientId = clean(options.clientId);
    this.#clientSecret = clean(options.clientSecret);
    this.#tokenUrl = options.tokenUrl ?? 'https://oauth2.googleapis.com/token';
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Read the stored tokens, asserting the grants the caller needs. The default
   * is `['read']` so every existing collect call keeps its exact semantics;
   * `communication.send-email` asks for `['send']` and fails with its own code
   * when the workspace was only ever authorized for reading.
   */
  read(
    workspace: string,
    instanceId: string,
    options: { requiredGrants?: readonly GoogleGrant[] } = {},
  ): GoogleTokens {
    const filePath = this.#tokenPath(workspace, instanceId);
    if (!existsSync(filePath)) throw new Error('google_not_configured');
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<GoogleTokens>;
    if (!clean(parsed.accessToken)) throw new Error('google_tokens_invalid');
    const scopes = Array.isArray(parsed.scopes)
      ? parsed.scopes.filter((scope): scope is string => typeof scope === 'string')
      : [];
    for (const grant of options.requiredGrants ?? ['read']) {
      if (!scopes.includes(GRANT_SCOPES[grant])) {
        throw new Error(MISSING_GRANT_ERROR[grant]);
      }
    }
    return {
      accessToken: parsed.accessToken!.trim(),
      ...(clean(parsed.refreshToken) ? { refreshToken: parsed.refreshToken!.trim() } : {}),
      ...(clean(parsed.expiresAt) ? { expiresAt: parsed.expiresAt!.trim() } : {}),
      ...(clean(parsed.tokenType) ? { tokenType: parsed.tokenType!.trim() } : {}),
      ...(scopes.length > 0 ? { scopes } : {}),
      ...(parsed.scopeSource === 'token-response' ||
      parsed.scopeSource === 'authorization-request-default'
        ? { scopeSource: parsed.scopeSource }
        : {}),
    };
  }

  write(workspace: string, instanceId: string, tokens: GoogleTokens): void {
    if (!clean(tokens.accessToken)) throw new Error('google_tokens_invalid');
    const filePath = this.#tokenPath(workspace, instanceId);
    mkdirSync(path.dirname(filePath), { recursive: true });
    atomicWriteJson(filePath, tokens);
  }

  async getAccessToken(
    workspace: string,
    instanceId: string,
    options: { forceRefresh?: boolean; requiredGrants?: readonly GoogleGrant[] } = {},
  ): Promise<string> {
    const tokens = this.read(workspace, instanceId, {
      ...(options.requiredGrants ? { requiredGrants: options.requiredGrants } : {}),
    });
    const expiresAt = tokens.expiresAt ? Date.parse(tokens.expiresAt) : Number.POSITIVE_INFINITY;
    const expiring = Number.isFinite(expiresAt) && expiresAt <= this.#now() + 60_000;
    if (!options.forceRefresh && !expiring) return tokens.accessToken;
    return (await this.#refresh(workspace, instanceId, tokens)).accessToken;
  }

  #tokenPath(workspace: string, instanceId: string): string {
    validateId(workspace, 'workspace');
    validateId(instanceId, 'instanceId');
    return path.join(this.#dataDir, workspace, instanceId, 'tokens.json');
  }

  async #refresh(
    workspace: string,
    instanceId: string,
    current: GoogleTokens,
  ): Promise<GoogleTokens> {
    if (!current.refreshToken) throw new Error('google_refresh_token_missing');
    if (!this.#clientId) {
      throw new Error('google_oauth_client_not_configured');
    }
    const refreshRequest = new URLSearchParams({
      client_id: this.#clientId,
      grant_type: 'refresh_token',
      refresh_token: current.refreshToken,
    });
    if (this.#clientSecret) refreshRequest.set('client_secret', this.#clientSecret);
    const response = await this.#fetch(this.#tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: refreshRequest,
    });
    if (!response.ok) throw new Error(`google_token_refresh_failed:${response.status}`);
    const payload = (await response.json()) as Record<string, unknown>;
    const accessToken = clean(payload.access_token);
    if (!accessToken) throw new Error('google_token_refresh_invalid_response');
    const expiresIn =
      typeof payload.expires_in === 'number' && Number.isFinite(payload.expires_in)
        ? Math.max(0, payload.expires_in)
        : 3_600;
    const next: GoogleTokens = {
      ...current,
      accessToken,
      expiresAt: new Date(this.#now() + expiresIn * 1_000).toISOString(),
      tokenType: clean(payload.token_type) ?? current.tokenType ?? 'Bearer',
      refreshToken: clean(payload.refresh_token) ?? current.refreshToken,
    };
    this.write(workspace, instanceId, next);
    return next;
  }
}

export { GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE };

function clean(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function validateId(value: string, label: string): void {
  if (!SAFE_ID.test(value) || value === '.' || value === '..') {
    throw new Error(`${label} must be a safe identifier`);
  }
}

function atomicWriteJson(filePath: string, payload: GoogleTokens): void {
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
