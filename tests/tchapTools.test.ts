import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { ConnectorsAgent } from '../src/agent.ts';
import { BridgeManager } from '../src/bridge/manager.ts';
import { RuntimeClient } from '../src/bridge/runtimeClient.ts';
import { loadConfig } from '../src/config.ts';
import { createMcpServer } from '../src/server.ts';
import { TchapAuth } from '../src/tchap/auth.ts';

const SERVER = 'agent.example.tchap.gouv.fr';
const ISSUER = `https://auth.${SERVER}`;

function fakeTchapDiscovery(): typeof fetch {
  const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status });
  return async (input) => {
    const url = String(input);
    if (url.endsWith('/.well-known/matrix/client')) return json(200, { 'm.homeserver': { base_url: `https://matrix.${SERVER}` }, 'm.authentication': { issuer: ISSUER } });
    if (url.endsWith('/openid-configuration')) {
      return json(200, {
        registration_endpoint: `${ISSUER}/oauth2/registration`,
        device_authorization_endpoint: `${ISSUER}/oauth2/device`,
        token_endpoint: `${ISSUER}/oauth2/token`,
      });
    }
    if (url.endsWith('/oauth2/registration')) return json(201, { client_id: 'C' });
    if (url.endsWith('/oauth2/device')) return json(200, { device_code: 'D', user_code: 'WXYZ-1234', verification_uri: `${ISSUER}/link`, interval: 3600, expires_in: 600 });
    if (url.endsWith('/oauth2/token')) return json(400, { error: 'authorization_pending' });
    return json(404, {});
  };
}

function workspaceRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'connectors-tchap-'));
  mkdirSync(path.join(root, 'demo', 'raw', 'untracked'), { recursive: true });
  return root;
}

async function connect(server: ReturnType<typeof createMcpServer>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  return JSON.parse((result.content as Array<{ text?: string }>)[0]?.text ?? '{}') as Record<string, unknown>;
}

function manager(root: string, options: { enabled?: boolean; runtime?: boolean } = {}) {
  const fetchImpl = fakeTchapDiscovery();
  return new BridgeManager({
    dataDir: path.join(root, 'data'),
    enabled: options.enabled ?? true,
    maxAgeMs: 600_000,
    ...(options.runtime === false ? {} : { runtime: new RuntimeClient({ baseUrl: 'http://runtime.invalid' }) }),
    auth: new TchapAuth({ dataDir: path.join(root, 'data'), fetch: fetchImpl }),
    fetch: fetchImpl,
    log: () => {},
  });
}

test('the Tchap tools are listed, status is read-only and reports a workspace not yet connected', async () => {
  const root = workspaceRoot();
  const agent = new ConnectorsAgent(loadConfig({ WORKSPACES_ROOT: root, AGENT_DATA_DIR: root }));
  const client = await connect(createMcpServer(agent, { workspacesRoot: root, bridges: manager(root) }));
  const tools = (await client.listTools()).tools;
  const status = tools.find((tool) => tool.name === 'connectors_tchap_status');
  assert.equal(status?.annotations?.readOnlyHint, true, 'status must be readable from chat mode');
  assert.equal(tools.find((tool) => tool.name === 'connectors_tchap_connect')?.annotations?.readOnlyHint, false);
  assert.ok(tools.some((tool) => tool.name === 'connectors_tchap_disconnect'));
  assert.equal(tools.find((tool) => tool.name === 'connectors_tchap_forums')?.annotations?.readOnlyHint, true);
  assert.equal(tools.find((tool) => tool.name === 'connectors_tchap_signout')?.annotations?.destructiveHint, true);
  const result = await call(client, 'connectors_tchap_status', { workspace: 'demo' });
  assert.equal(result.ok, true);
  assert.equal(result.connected, false);
  assert.equal(result.running, false);
});

test('connect without a session returns the sign-in URL and code, and status shows them pending', async () => {
  const root = workspaceRoot();
  const agent = new ConnectorsAgent(loadConfig({ WORKSPACES_ROOT: root, AGENT_DATA_DIR: root }));
  const bridges = manager(root);
  const client = await connect(createMcpServer(agent, { workspacesRoot: root, bridges }));
  const result = await call(client, 'connectors_tchap_connect', { workspace: 'demo', room: `#Donna-demo:${SERVER}` });
  assert.equal(result.ok, true);
  assert.equal(result.pending, true);
  assert.equal(result.userCode, 'WXYZ-1234');
  assert.equal(result.verificationUri, `${ISSUER}/link`);
  const status = await call(client, 'connectors_tchap_status', { workspace: 'demo' });
  assert.deepEqual(status.pending, { userCode: 'WXYZ-1234', verificationUri: `${ISSUER}/link`, forum: `#Donna-demo:${SERVER}` });
  // A second workspace asking meanwhile shares the same code: one sign-in for the agent.
  mkdirSync(path.join(root, 'other', 'raw'), { recursive: true });
  const second = await call(client, 'connectors_tchap_connect', { workspace: 'other', room: `#Donna-other:${SERVER}` });
  assert.equal(second.userCode, 'WXYZ-1234');
  await call(client, 'connectors_tchap_disconnect', { workspace: 'other' });
  await call(client, 'connectors_tchap_disconnect', { workspace: 'demo' });
  assert.equal((await call(client, 'connectors_tchap_status', { workspace: 'demo' })).pending, undefined);
});

test('connect refuses a malformed room, a missing runtime and an unknown workspace', async () => {
  const root = workspaceRoot();
  const agent = new ConnectorsAgent(loadConfig({ WORKSPACES_ROOT: root, AGENT_DATA_DIR: root }));
  const client = await connect(createMcpServer(agent, { workspacesRoot: root, bridges: manager(root) }));
  assert.equal((await call(client, 'connectors_tchap_connect', { workspace: 'demo', room: 'Donna-demo' })).error, 'tchap_room_invalid');
  assert.match(String((await call(client, 'connectors_tchap_connect', { workspace: '../etc', room: `#a:${SERVER}` })).error), /workspace/);

  const noRuntime = await connect(createMcpServer(agent, { workspacesRoot: root, bridges: manager(root, { runtime: false }) }));
  assert.equal((await call(noRuntime, 'connectors_tchap_connect', { workspace: 'demo', room: `#a:${SERVER}` })).error, 'runtime_not_configured');
});

test('with the bridge disabled for the deployment, no Tchap tool is offered', async () => {
  const root = workspaceRoot();
  const agent = new ConnectorsAgent(loadConfig({ WORKSPACES_ROOT: root, AGENT_DATA_DIR: root }));
  const client = await connect(createMcpServer(agent, { workspacesRoot: root, bridges: manager(root, { enabled: false }) }));
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  assert.ok(!names.some((name) => name.startsWith('connectors_tchap_')));
});

test('configuration: bridge on by default, prohibited by CONNECTORS_BRIDGE_ENABLED=false, runtime from the manager variables', () => {
  assert.equal(loadConfig({}).bridgeEnabled, true);
  assert.equal(loadConfig({ CONNECTORS_BRIDGE_ENABLED: 'false' }).bridgeEnabled, false);
  assert.equal(loadConfig({}).bridgeMaxAgeSeconds, 600);
  const config = loadConfig({ WIKI_MANAGER_RUNTIME_URL: 'http://host.docker.internal:7788', WIKI_MANAGER_RUNTIME_TOKEN: 'tok' });
  assert.equal(config.runtimeUrl, 'http://host.docker.internal:7788');
  assert.equal(config.runtimeToken, 'tok');
});
