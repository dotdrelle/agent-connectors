import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { ConnectorsAgent } from '../src/agent.ts';
import { loadConfig } from '../src/config.ts';
import { GoogleTokenProvider } from '../src/googleTokens.ts';
import { createMcpServer } from '../src/server.ts';

// The LLM surfaces call optional tool parameters with an explicit `null`
// (cme_export_status(job_id=null), connectors_google_status(instanceId=null)
// …). The zod schemas must accept that null instead of failing the whole call
// with an MCP validation error: a validation failure is a dead end for the
// model, a tool answer is something it can act on.

async function connect(server: ReturnType<typeof createMcpServer>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function callTool(client: Client, name: string, arguments_: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: arguments_ });
  const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
  return JSON.parse(text) as Record<string, unknown>;
}

test('connectors_google_status accepts a null instanceId and reports not_configured', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'connectors-tools-'));
  mkdirSync(path.join(root, 'demo', 'raw', 'untracked'), { recursive: true });
  const agent = new ConnectorsAgent(loadConfig({ WORKSPACES_ROOT: root, AGENT_DATA_DIR: root }));
  const server = createMcpServer(agent, {
    workspacesRoot: root,
    tokens: new GoogleTokenProvider({ dataDir: path.join(root, 'agent-data') }),
  });
  const client = await connect(server);

  const result = await callTool(client, 'connectors_google_status', {
    workspace: 'demo',
    instanceId: null,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'not_configured');
  assert.equal(result.instanceId, 'google-1', 'null instanceId falls back to the default instance');
});

test('connectors_google_status accepts an omitted instanceId', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'connectors-tools-'));
  mkdirSync(path.join(root, 'demo', 'raw', 'untracked'), { recursive: true });
  const agent = new ConnectorsAgent(loadConfig({ WORKSPACES_ROOT: root, AGENT_DATA_DIR: root }));
  const server = createMcpServer(agent, {
    workspacesRoot: root,
    tokens: new GoogleTokenProvider({ dataDir: path.join(root, 'agent-data') }),
  });
  const client = await connect(server);

  const result = await callTool(client, 'connectors_google_status', { workspace: 'demo' });

  assert.equal(result.ok, true);
  assert.equal(result.instanceId, 'google-1');
});

test('agent_status accepts a null jobId and returns capability status', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'connectors-tools-'));
  const agent = new ConnectorsAgent(loadConfig({ WORKSPACES_ROOT: root, AGENT_DATA_DIR: root }));
  const server = createMcpServer(agent, {});
  const client = await connect(server);

  const result = await callTool(client, 'agent_status', { jobId: null });

  assert.equal(result.capability, 'external-source.collect');
  assert.equal(result.available, true);
});

test('connectors_gmail_search accepts null optional parameters', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'connectors-tools-'));
  const agent = new ConnectorsAgent(loadConfig({ WORKSPACES_ROOT: root, AGENT_DATA_DIR: root }));
  const server = createMcpServer(agent, { workspacesRoot: root });
  const client = await connect(server);

  // No mailbox tokens: the handler reports gmail_not_configured — reaching the
  // handler at all proves the schema accepted the nulls instead of rejecting
  // the call with a validation error.
  const result = await callTool(client, 'connectors_gmail_search', {
    workspace: 'demo',
    instanceId: null,
    query: null,
    maxMessages: null,
    includeSpamTrash: null,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'gmail_not_configured');
});
