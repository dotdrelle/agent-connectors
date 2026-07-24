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
import { GoogleOAuthService } from './googleOAuth.ts';
import { GoogleTokenProvider } from './googleTokens.ts';
import { resolveWorkspacePath } from './workspace.ts';

export const CONNECTORS_VERSION = '0.14.21';

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
  } = {},
): McpServer {
  const server = new McpServer({ name: 'agent-connectors', version: CONNECTORS_VERSION });

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
      description: 'Execute an external-source.collect task and write OKF Markdown.',
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
      description: 'Report whether Gmail read-only authorization is configured for the active workspace.',
      inputSchema: {
        workspace: z.string(),
        instanceId: z.string().optional(),
      },
    },
    async (args) => {
      if (!options.tokens || !options.workspacesRoot) {
        return jsonResult({ ok: false, status: 'not_configured' });
      }
      const instanceId = args.instanceId?.trim() || 'google-1';
      try {
        const workspace = await resolveWorkspacePath(
          { name: args.workspace },
          options.workspacesRoot,
        );
        options.tokens.read(workspace.name, instanceId);
        return jsonResult({ ok: true, status: 'configured', instanceId });
      } catch {
        return jsonResult({ ok: true, status: 'not_configured', instanceId });
      }
    },
  );

  server.registerTool(
    'connectors_google_oauth_start',
    {
      description: 'Start Gmail read-only OAuth for the active workspace and return the Google authorization URL.',
      inputSchema: {
        workspace: z.string(),
        instanceId: z.string().optional(),
      },
    },
    async (args) => {
      if (!options.oauth || !options.workspacesRoot) {
        return jsonResult({ ok: false, error: 'oauth_not_configured' });
      }
      const instanceId = args.instanceId?.trim() || 'google-1';
      try {
        const workspace = await resolveWorkspacePath(
          { name: args.workspace },
          options.workspacesRoot,
        );
        return jsonResult({
          ok: true,
          ...options.oauth.start(workspace.name, instanceId),
          instanceId,
        });
      } catch {
        return jsonResult({ ok: false, error: 'oauth_start_rejected' });
      }
    },
  );

  return server;
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
      const workspace = await resolveWorkspacePath(
        { name: workspaceName },
        options.workspacesRoot,
      );
      const started = options.oauth.start(workspace.name, instanceId);
      writeJson(res, 200, { ok: true, ...started });
    } catch {
      writeJson(res, 400, { ok: false, error: 'oauth_start_rejected' });
    }
    return;
  }
  if (requestUrl.pathname === '/oauth/google/callback' && req.method === 'GET') {
    const providerError = requestUrl.searchParams.get('error');
    const state = requestUrl.searchParams.get('state') ?? '';
    const code = requestUrl.searchParams.get('code') ?? '';
    if (providerError || !state || !code) {
      writeOAuthHtml(res, 400, false);
      return;
    }
    try {
      await options.oauth.complete({ state, code });
      writeOAuthHtml(res, 200, true);
    } catch {
      writeOAuthHtml(res, 400, false);
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

function writeOAuthHtml(res: ServerResponse, status: number, success: boolean): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(
    '<!doctype html><meta charset="utf-8">' +
      `<title>${success ? 'Google connected' : 'Authorization failed'}</title>` +
      '<style>body{font:16px system-ui;max-width:42rem;margin:4rem auto;padding:0 1rem}</style>' +
      `<h1>${success ? 'Google connected' : 'Authorization failed'}</h1>` +
      `<p>${success ? 'You can close this window and return to wikiLLM.' : 'Return to wikiLLM and start authorization again.'}</p>`,
  );
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
