import { readFileSync } from 'node:fs';

/**
 * OAuth application baked into the image, read from a file.
 *
 * It used to live in an `ARG`/`ENV` pair in the Dockerfile, which BuildKit
 * rightly flags (`SecretsUsedInArgOrEnv`): an `ENV` stays recorded in the image
 * metadata, visible through `docker inspect` and through any later layer. A
 * file copied into the image, read-only and owned by the runtime user, carries
 * the same value without publishing it into the container configuration.
 *
 * This is not encryption and does not pretend to be: the distributed Google
 * client is a Desktop/public type, those two values are not a security
 * boundary. The point is to stop exposing them where tools expect to find
 * nothing but configuration.
 *
 * This is a DEFAULT: `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`,
 * when the operator sets them in the manager `.env`, take precedence.
 */
export const DEFAULT_OAUTH_CLIENT_FILE = '/app/.oauth-client.json';

export type BakedOAuthClient = {
  clientId?: string;
  clientSecret?: string;
};

/**
 * @param filePath file to read; `GOOGLE_OAUTH_CLIENT_FILE` overrides it, which
 *   allows mounting another application without rebuilding the image.
 * @returns the values found, or an empty object. A missing file is the NORMAL
 *   case (image built without credentials) and must never prevent the agent
 *   from starting: only Google authorization becomes unavailable, and
 *   `index.ts` says so at startup.
 */
export function readBakedOAuthClient(filePath = DEFAULT_OAUTH_CLIENT_FILE): BakedOAuthClient {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // An unreadable file is a build error, not a runtime failure:
    // report it without bringing the agent down.
    console.warn(`agent-connectors: ${filePath} is not valid JSON — ignoring the baked OAuth client.`);
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const record = parsed as Record<string, unknown>;
  const clientId = typeof record.clientId === 'string' ? record.clientId.trim() : '';
  const clientSecret = typeof record.clientSecret === 'string' ? record.clientSecret.trim() : '';
  return {
    ...(clientId ? { clientId } : {}),
    ...(clientSecret ? { clientSecret } : {}),
  };
}
