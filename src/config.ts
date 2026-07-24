import path from 'node:path';

/**
 * Runtime configuration for the connectors agent.
 *
 * All values are resolved once from the environment. The manager injects the
 * active workspace on every orchestrated call, so the agent only needs to know
 * where the workspaces root lives and how much parallelism it advertises.
 */
export type AgentConfig = {
  /** Stable identity published in agent_describe.agentInstanceId. */
  agentInstanceId: string;
  /** Human label surfaced in the orchestrator UIs. */
  displayName: string;
  /** Filesystem root under which every workspace lives (manager mount). */
  workspacesRoot: string;
  /** Persistent agent state root, isolated from workspace source files. */
  dataDir: string;
  /** Concurrency the agent recommends to the orchestrator. */
  recommendedConcurrency: number;
  /** Hard ceiling the orchestrator must never exceed for this agent. */
  maxConcurrency: number;
  /** HTTP port for the Streamable HTTP MCP endpoint. */
  port: number;
  /** Google OAuth public client ID and optional confidential-client secret. */
  googleClientId?: string;
  googleClientSecret?: string;
  /** Durable callback URL and HMAC secret for OAuth state. */
  googleOAuthCallbackUrl?: string;
  oauthStateSecret?: string;
  oauthStartToken?: string;
  oauthStateTtlSeconds: number;
  /** Optional bearer protecting the MCP endpoint. */
  mcpAuthToken?: string;
};

function intFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Environment variable ${name} must be a non-negative integer.`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const recommendedConcurrency = intFromEnv(
    env,
    'CONNECTORS_RECOMMENDED_CONCURRENCY',
    2,
  );
  const maxConcurrency = intFromEnv(env, 'CONNECTORS_MAX_CONCURRENCY', 4);
  if (maxConcurrency < 1) {
    throw new Error('CONNECTORS_MAX_CONCURRENCY must be at least 1.');
  }
  const oauthStartToken = env.OAUTH_START_TOKEN?.trim();
  if (oauthStartToken && Buffer.byteLength(oauthStartToken, 'utf8') < 32) {
    throw new Error('OAUTH_START_TOKEN must contain at least 32 bytes.');
  }
  const mcpAuthToken = env.MCP_AUTH_TOKEN?.trim();
  const googleClientId =
    env.GOOGLE_CLIENT_ID?.trim() ||
    env.GOOGLE_OAUTH_CLIENT_ID?.trim() ||
    env.WIKILLM_GOOGLE_OAUTH_CLIENT_ID?.trim();
  const googleClientSecret =
    env.GOOGLE_CLIENT_SECRET?.trim() || env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  return {
    agentInstanceId: env.AGENT_INSTANCE_ID?.trim() || 'connectors',
    displayName: env.CONNECTORS_DISPLAY_NAME?.trim() || 'Connectors',
    workspacesRoot: path.resolve(env.WORKSPACES_ROOT?.trim() || '/workspaces'),
    dataDir: path.resolve(env.AGENT_DATA_DIR?.trim() || '/data'),
    recommendedConcurrency: Math.min(recommendedConcurrency, maxConcurrency),
    maxConcurrency,
    port: intFromEnv(env, 'CONNECTORS_PORT', 3338),
    ...(googleClientId ? { googleClientId } : {}),
    ...(googleClientSecret ? { googleClientSecret } : {}),
    ...(env.GOOGLE_OAUTH_CALLBACK_URL?.trim()
      ? { googleOAuthCallbackUrl: env.GOOGLE_OAUTH_CALLBACK_URL.trim() }
      : {}),
    ...(env.OAUTH_STATE_SECRET?.trim()
      ? { oauthStateSecret: env.OAUTH_STATE_SECRET.trim() }
      : {}),
    ...(oauthStartToken ? { oauthStartToken } : {}),
    oauthStateTtlSeconds: intFromEnv(env, 'OAUTH_STATE_TTL_SECONDS', 600),
    ...(mcpAuthToken ? { mcpAuthToken } : {}),
  };
}
