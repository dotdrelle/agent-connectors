import { randomUUID, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { ConnectorsAgent, type ExecuteRequest } from './agent.ts';
import { loadConfig } from './config.ts';
import { GmailCollector } from './gmail.ts';
import { GmailMailbox } from './gmailMailbox.ts';
import { GmailSender } from './gmailSend.ts';
import { GoogleOAuthService } from './googleOAuth.ts';
import {
  GOOGLE_GRANTS,
  type GoogleGrant,
  GoogleTokenProvider,
  grantsFromScopes,
  normalizeGrants,
} from './googleTokens.ts';
import { resolveWorkspacePath } from './workspace.ts';

export const CONNECTORS_VERSION = '0.15.66';

function jsonResult(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

/**
 * Register the five orchestration tools on a fresh MCP server, all delegating
 * to the shared, framework-agnostic ConnectorsAgent. A new server is created
 * per Streamable HTTP session; the agent (and its job store) is shared.
 */
export function createMcpServer(
  agent: ConnectorsAgent,
  options: {
    oauth?: GoogleOAuthService;
    tokens?: GoogleTokenProvider;
    workspacesRoot?: string;
    sendEnabled?: boolean;
  } = {},
): McpServer {
  const server = new McpServer({ name: 'agent-connectors', version: CONNECTORS_VERSION });
  const mailbox = options.tokens ? new GmailMailbox({ tokens: options.tokens }) : null;

  server.registerTool(
    'agent_describe',
    { description: "Return this agent's generic multi-agent orchestration contract." },
    async () => jsonResult(agent.describe()),
  );

  server.registerTool(
    'agent_plan',
    { description: 'Executor-only agent: planning is delegated to the orchestrator.' },
    async () => jsonResult({ ok: false, error: 'not_a_planner', canPlan: false }),
  );

  server.registerTool(
    'agent_execute',
    {
      description:
        'Execute an orchestrated task: "collect" writes OKF Markdown into the ' +
        'workspace, "send" sends one plain-text email from the connected mailbox.',
      inputSchema: {
        taskId: z.string().optional(),
        idempotencyKey: z.string().optional(),
        operation: z.string().optional(),
        workspace: z.union([z.string(), z.object({ name: z.string().optional(), path: z.string().optional() })]).optional(),
        arguments: z.record(z.string(), z.unknown()).optional(),
        constraints: z.object({ requireApprovalForMutations: z.boolean().optional() }).optional(),
      },
    },
    async (args) => jsonResult(await agent.execute(args as ExecuteRequest)),
  );

  server.registerTool(
    'agent_status',
    {
      description: 'Report task status by jobId, or capability status when no jobId is given.',
      inputSchema: {
        jobId: z.string().optional(),
        capability: z.string().optional(),
        operation: z.string().optional(),
      },
    },
    async (args) => {
      const jobId = typeof args.jobId === 'string' ? args.jobId.trim() : '';
      if (jobId) return jsonResult(agent.status(jobId));
      return jsonResult(agent.capabilityStatus(args));
    },
  );

  server.registerTool(
    'agent_cancel',
    {
      description: 'Request cancellation of a running external-source.collect job.',
      inputSchema: { jobId: z.string() },
    },
    async (args) => jsonResult(agent.cancel(String(args.jobId))),
  );

  server.registerTool(
    'connectors_google_status',
    {
      description:
        'Report which Gmail authorization grants ("read", "send", "modify") the active ' +
        'workspace holds for a connector instance.',
      inputSchema: {
        workspace: z.string(),
        instanceId: z.string().optional(),
      },
    },
    async (args) => {
      if (!options.tokens || !options.workspacesRoot) {
        return jsonResult({ ok: false, status: 'not_configured', grants: [] });
      }
      const instanceId = args.instanceId?.trim() || 'google-1';
      try {
        const workspace = await resolveWorkspacePath(
          { name: args.workspace },
          options.workspacesRoot,
        );
        // No required grant: we are reporting what exists, so a read-only
        // workspace must answer "configured, grants: [read]" — not throw.
        const tokens = options.tokens.read(workspace.name, instanceId, {
          requiredGrants: [],
        });
        const grants = grantsFromScopes(tokens.scopes ?? []);
        return jsonResult({
          ok: true,
          status: grants.length > 0 ? 'configured' : 'not_configured',
          instanceId,
          grants,
          missingGrants: GOOGLE_GRANTS.filter((grant) => !grants.includes(grant)),
          sendEnabled: options.sendEnabled ?? false,
        });
      } catch {
        return jsonResult({
          ok: true,
          status: 'not_configured',
          instanceId,
          grants: [],
          missingGrants: [...GOOGLE_GRANTS],
          sendEnabled: options.sendEnabled ?? false,
        });
      }
    },
  );

  server.registerTool(
    'connectors_google_oauth_start',
    {
      description:
        'Start Gmail OAuth for the active workspace and return the Google ' +
        'authorization URL. Grants default to ["read"]; pass ["read","send"] to ' +
        'also authorize sending, and add "modify" for labels, read state, archive, ' +
        'trash and stars. Authorization is incremental: new grants do not revoke existing ones.',
      inputSchema: {
        workspace: z.string(),
        instanceId: z.string().optional(),
        grants: z.array(z.enum(['read', 'send', 'modify'])).optional(),
      },
    },
    async (args) => {
      if (!options.oauth || !options.workspacesRoot) {
        return jsonResult({ ok: false, error: 'oauth_not_configured' });
      }
      const instanceId = args.instanceId?.trim() || 'google-1';
      try {
        const grants = normalizeGrants(args.grants);
        if (grants.includes('send') && options.sendEnabled === false) {
          return jsonResult({ ok: false, error: 'send_capability_disabled' });
        }
        const workspace = await resolveWorkspacePath(
          { name: args.workspace },
          options.workspacesRoot,
        );
        return jsonResult({
          ok: true,
          ...options.oauth.start(workspace.name, instanceId, { grants }),
          instanceId,
        });
      } catch {
        return jsonResult({ ok: false, error: 'oauth_start_rejected' });
      }
    },
  );

  server.registerTool(
    'connectors_gmail_summary',
    {
      description: 'Read Gmail mailbox totals and unread counts without importing messages.',
      inputSchema: { workspace: z.string(), instanceId: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async (args) => jsonResult(await withMailbox(options, mailbox, args, (client, context) =>
      client.summary(context))),
  );

  server.registerTool(
    'connectors_gmail_search',
    {
      description:
        'Search Gmail without importing messages. Returns message IDs, labels and compact metadata; query uses Gmail search syntax.',
      inputSchema: {
        workspace: z.string(),
        instanceId: z.string().optional(),
        query: z.string().optional(),
        maxMessages: z.number().int().min(1).max(100).optional(),
        includeSpamTrash: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => jsonResult(await withMailbox(options, mailbox, args, (client, context) =>
      client.search(context, args))),
  );

  server.registerTool(
    'connectors_gmail_labels',
    {
      description: 'List Gmail system and user labels available in the connected mailbox.',
      inputSchema: { workspace: z.string(), instanceId: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async (args) => jsonResult(await withMailbox(options, mailbox, args, (client, context) =>
      client.labels(context))),
  );

  server.registerTool(
    'connectors_gmail_modify',
    {
      description:
        'Modify one Gmail message: mark read/unread, archive, move to inbox, trash/untrash, star/unstar, or add/remove label IDs. Requires the modify OAuth grant and explicit approval.',
      inputSchema: {
        workspace: z.string(),
        instanceId: z.string().optional(),
        messageId: z.string(),
        action: z.enum([
          'mark_read', 'mark_unread', 'archive', 'move_to_inbox',
          'trash', 'untrash', 'star', 'unstar', 'add_labels', 'remove_labels',
        ]),
        labelIds: z.array(z.string()).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args) => jsonResult(await withMailbox(options, mailbox, args, (client, context) =>
      client.modify(context, args.messageId, args.action, args.labelIds))),
  );

  return server;
}

async function withMailbox<T>(
  options: { workspacesRoot?: string },
  mailbox: GmailMailbox | null,
  args: { workspace: string; instanceId?: string },
  run: (mailbox: GmailMailbox, context: { workspace: string; instanceId: string }) => Promise<T>,
): Promise<T | { ok: false; error: string }> {
  if (!mailbox || !options.workspacesRoot) return { ok: false, error: 'gmail_not_configured' };
  try {
    const workspace = await resolveWorkspacePath({ name: args.workspace }, options.workspacesRoot);
    return await run(mailbox, {
      workspace: workspace.name,
      instanceId: args.instanceId?.trim() || 'google-1',
    });
  } catch (error) {
    const value = error instanceof Error ? error.message : String(error);
    return { ok: false, error: value };
  }
}

/**
 * Start the Streamable HTTP MCP endpoint. Sessions are tracked by id so the
 * shared agent and persistent job store survive across polling requests.
 */
export async function startServer(): Promise<{ close: () => Promise<void>; port: number }> {
  const config = loadConfig();
  const tokens = new GoogleTokenProvider({
    dataDir: config.dataDir,
    clientId: config.googleClientId,
    clientSecret: config.googleClientSecret,
  });
  const agent = new ConnectorsAgent(config, {
    collectors: [new GmailCollector({ tokens })],
    // The sender is only constructed when sending is enabled: with the kill
    // switch off there is no code path from a task to the Gmail send endpoint,
    // not merely a hidden capability entry.
    senders: config.sendEnabled ? [new GmailSender({ tokens })] : [],
  });
  const oauth =
    config.googleClientId &&
    config.googleOAuthCallbackUrl &&
    config.oauthStateSecret &&
    config.oauthStartToken
      ? new GoogleOAuthService({
          dataDir: config.dataDir,
          clientId: config.googleClientId,
          clientSecret: config.googleClientSecret,
          callbackUrl: config.googleOAuthCallbackUrl,
          stateSecret: config.oauthStateSecret,
          stateTtlSeconds: config.oauthStateTtlSeconds,
          tokens,
        })
      : undefined;
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createServer((req, res) => {
    void handle(req, res).catch((error) => {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'internal_error',
          ...(process.env.NODE_ENV === 'test' ? { detail: String(error) } : {}),
        }),
      );
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.url?.startsWith('/oauth/google/')) {
      await handleGoogleOAuth(req, res, {
        oauth,
        workspacesRoot: config.workspacesRoot,
        oauthStartToken: config.oauthStartToken,
        sendEnabled: config.sendEnabled,
      });
      return;
    }
    if (!req.url?.startsWith('/mcp')) {
      res.writeHead(404).end();
      return;
    }
    if (
      config.mcpAuthToken &&
      !matchesBearer(req.headers.authorization, config.mcpAuthToken)
    ) {
      writeJson(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    const sessionId = req.headers['mcp-session-id'];
    const existing = typeof sessionId === 'string' ? transports.get(sessionId) : undefined;

    if (req.method === 'POST') {
      const body = await readJson(req);
      let transport = existing;
      if (!transport) {
        if (!isInitializeRequest(body)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'No valid session' }, id: null }));
          return;
        }
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports.set(id, transport!);
          },
        });
        transport.onclose = () => {
          if (transport!.sessionId) transports.delete(transport!.sessionId);
        };
        await createMcpServer(agent, {
          oauth,
          tokens,
          workspacesRoot: config.workspacesRoot,
          sendEnabled: config.sendEnabled,
        }).connect(transport);
      }
      await transport.handleRequest(req, res, body);
      return;
    }

    if ((req.method === 'GET' || req.method === 'DELETE') && existing) {
      await existing.handleRequest(req, res);
      return;
    }
    res.writeHead(400).end();
  }

  httpServer.listen(config.port);
  await once(httpServer, 'listening');
  return {
    port: config.port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

export async function handleGoogleOAuth(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    oauth?: GoogleOAuthService;
    workspacesRoot: string;
    oauthStartToken?: string;
    sendEnabled?: boolean;
  },
): Promise<void> {
  const requestUrl = new URL(req.url ?? '/', 'http://agent-connectors.local');
  res.setHeader('Cache-Control', 'no-store');
  if (!options.oauth) {
    writeJson(res, 503, { ok: false, error: 'oauth_not_configured' });
    return;
  }
  if (requestUrl.pathname === '/oauth/google/start' && req.method === 'POST') {
    if (
      !options.oauthStartToken ||
      !matchesBearer(req.headers.authorization, options.oauthStartToken)
    ) {
      writeJson(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    const body = (await readJson(req, 16_384)) as Record<string, unknown> | undefined;
    const workspaceName =
      typeof body?.workspace === 'string'
        ? body.workspace
        : typeof body?.workspace === 'object' &&
            body.workspace !== null &&
            typeof (body.workspace as Record<string, unknown>).name === 'string'
          ? String((body.workspace as Record<string, unknown>).name)
          : '';
    const instanceId =
      typeof body?.instanceId === 'string' ? body.instanceId.trim() : 'google-1';
    try {
      const grants: GoogleGrant[] = normalizeGrants(body?.grants);
      if (grants.includes('send') && options.sendEnabled === false) {
        writeJson(res, 409, { ok: false, error: 'send_capability_disabled' });
        return;
      }
      const workspace = await resolveWorkspacePath(
        { name: workspaceName },
        options.workspacesRoot,
      );
      const started = options.oauth.start(workspace.name, instanceId, { grants });
      writeJson(res, 200, { ok: true, ...started });
    } catch (error) {
      const reason = oauthFailureReason(error);
      logOAuthFailure('start', reason);
      writeJson(res, 400, { ok: false, error: 'oauth_start_rejected', reason });
    }
    return;
  }
  if (requestUrl.pathname === '/oauth/google/callback' && req.method === 'GET') {
    const providerError = requestUrl.searchParams.get('error');
    const state = requestUrl.searchParams.get('state') ?? '';
    const code = requestUrl.searchParams.get('code') ?? '';
    if (providerError || !state || !code) {
      // The provider's own error code is a documented, non-secret value
      // (access_denied, invalid_scope…). Reporting it is what separates
      // "the user declined" from "our exchange broke".
      const reason = providerError
        ? `provider_error:${sanitizeReason(providerError)}`
        : !state
          ? 'callback_missing_state'
          : 'callback_missing_code';
      logOAuthFailure('callback', reason);
      writeOAuthHtml(res, 400, false, reason);
      return;
    }
    try {
      await options.oauth.complete({ state, code });
      writeOAuthHtml(res, 200, true);
    } catch (error) {
      // Every failure mode used to collapse into one opaque page with no log,
      // so an operator could not tell an expired state from a redirect_uri
      // mismatch. Reasons are non-secret codes (never the state, code, or
      // token payload) — same contract as the collector's failure reasons.
      const reason = oauthFailureReason(error);
      logOAuthFailure('callback', reason);
      writeOAuthHtml(res, 400, false, reason);
    }
    return;
  }
  res.writeHead(404).end();
}

function matchesBearer(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const provided = Buffer.from(header.slice('Bearer '.length), 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  return provided.length === wanted.length && timingSafeEqual(provided, wanted);
}

function writeJson(
  res: ServerResponse,
  status: number,
  payload: Record<string, unknown>,
): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(`${JSON.stringify(payload)}\n`);
}

function writeOAuthHtml(
  res: ServerResponse,
  status: number,
  success: boolean,
  reason?: string,
): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    'X-Content-Type-Options': 'nosniff',
  });
  const safeReason = reason ? sanitizeReason(reason) : '';
  res.end(
    '<!doctype html><meta charset="utf-8">' +
      `<title>${success ? 'Google connected' : 'Authorization failed'}</title>` +
      '<style>body{font:16px system-ui;max-width:42rem;margin:4rem auto;padding:0 1rem}' +
      'code{font:14px ui-monospace,monospace}</style>' +
      `<h1>${success ? 'Google connected' : 'Authorization failed'}</h1>` +
      `<p>${success ? 'You can close this window and return to wikiLLM.' : 'Return to wikiLLM and start authorization again.'}</p>` +
      (safeReason ? `<p>Reason: <code>${safeReason}</code></p>` : ''),
  );
}

// Failure reasons are short machine codes the operator needs in order to tell
// an expired state from a redirect_uri mismatch. They are built from our own
// thrown Error messages and the provider's documented error codes — never from
// the state, the authorization code, or a token payload. Sanitizing to a
// conservative charset keeps an unexpected message from reaching the HTML.
function sanitizeReason(value: string): string {
  return value.replace(/[^a-zA-Z0-9_:.-]/g, '').slice(0, 80);
}

function oauthFailureReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const reason = sanitizeReason(raw);
  return reason || 'oauth_failed';
}

function logOAuthFailure(stage: 'start' | 'callback', reason: string): void {
  // stderr, not the HTTP response: the operator reads container logs. The page
  // shows the same code so a user can quote it without digging.
  console.error(`agent-connectors oauth ${stage} failed: ${reason}`);
}

function readJson(req: IncomingMessage, maxBytes = 2_097_152): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      total += chunk.length;
      if (total > maxBytes) {
        failed = true;
        reject(new Error('request_body_too_large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}
