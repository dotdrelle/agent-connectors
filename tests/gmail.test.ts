import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ConnectorsAgent } from '../src/agent.ts';
import { loadConfig } from '../src/config.ts';
import { GmailCollector, renderGmailMessage } from '../src/gmail.ts';
import {
  GMAIL_READONLY_SCOPE,
  GoogleTokenProvider,
} from '../src/googleTokens.ts';

function encoded(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

test('Gmail collector refreshes once on 401, paginates and renders messages', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'connectors-gmail-'));
  let tokenCalls = 0;
  let staleApiCalls = 0;
  const requestedPages: string[] = [];
  const mockFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'oauth2.googleapis.com') {
      tokenCalls += 1;
      return Response.json({ access_token: 'fresh-access', expires_in: 3600 });
    }
    const authorization = new Headers(init?.headers).get('authorization');
    if (authorization === 'Bearer stale-access') {
      staleApiCalls += 1;
      return new Response('unauthorized', { status: 401 });
    }
    assert.equal(authorization, 'Bearer fresh-access');
    if (url.pathname.endsWith('/messages')) {
      requestedPages.push(url.searchParams.get('pageToken') ?? 'first');
      assert.equal(url.searchParams.get('q'), 'newer_than:1d');
      if (!url.searchParams.has('pageToken')) {
        return Response.json({
          messages: [{ id: 'm1' }],
          nextPageToken: 'page-2',
        });
      }
      return Response.json({ messages: [{ id: 'm2' }] });
    }
    const id = url.pathname.split('/').at(-1);
    return Response.json({
      id,
      threadId: `thread-${id}`,
      internalDate: '1784887200000',
      snippet: `Snippet ${id}`,
      payload: {
        headers: [
          { name: 'Subject', value: `Subject ${id}` },
          { name: 'From', value: 'Alice <alice@example.test>' },
          { name: 'To', value: 'Bob <bob@example.test>' },
          { name: 'Date', value: 'Fri, 24 Jul 2026 10:00:00 +0000' },
        ],
        mimeType: 'text/plain',
        body: { data: encoded(`Hello from ${id}`) },
      },
    });
  };
  const tokens = new GoogleTokenProvider({
    dataDir,
    clientId: 'client',
    clientSecret: 'secret',
    fetch: mockFetch,
  });
  tokens.write('demo', 'google-1', {
    accessToken: 'stale-access',
    refreshToken: 'refresh',
    scopes: [GMAIL_READONLY_SCOPE],
  });
  const collector = new GmailCollector({
    tokens,
    fetch: mockFetch,
    defaultMaxMessages: 2,
  });

  const items = await collector.collect(
    { query: 'newer_than:1d', maxMessages: 2 },
    {
      workspace: { name: 'demo', path: '/unused' },
      instanceId: 'google-1',
    },
  );
  assert.equal(tokenCalls, 1);
  assert.equal(staleApiCalls, 1);
  assert.deepEqual(requestedPages, ['first', 'page-2']);
  assert.equal(items.length, 2);
  assert.equal(items[0]?.logicalName, 'm1');
  assert.equal(items[0]?.okf.type, 'Email');
  assert.equal(items[0]?.okf['source-connector'], 'google-1');
  assert.match(items[0]?.body ?? '', /Hello from m1/);
  assert.equal(tokens.read('demo', 'google-1').accessToken, 'fresh-access');
});

test('Gmail HTML fallback removes active markup and decodes entities', () => {
  const item = renderGmailMessage(
    {
      id: 'html-1',
      snippet: 'HTML message',
      payload: {
        headers: [{ name: 'Subject', value: 'HTML test' }],
        mimeType: 'text/html',
        body: {
          data: encoded(
            '<style>.secret{display:none}</style><p>Hello&nbsp;&amp; welcome</p>' +
              '<script>steal()</script><br>Next',
          ),
        },
      },
    },
    'google-1',
  );
  assert.match(item.body, /Hello & welcome/);
  assert.match(item.body, /Next/);
  assert.doesNotMatch(item.body, /<script|steal\(\)|display:none|<p>/);
});

test('Gmail HTML fallback strips every script/style variant, including malformed ones', () => {
  const item = renderGmailMessage(
    {
      id: 'evil-1',
      payload: {
        headers: [{ name: 'Subject', value: 'Malformed markup' }],
        mimeType: 'text/html',
        body: {
          data: encoded(
            '<p>Kept</p>'
            + '<SCRIPT>upper()</SCRIPT>'                       // uppercase
            + '<script type="text/javascript">attr()</script >' // attrs + space in close
            + '<style media="print">.x{color:red!important}</style>'
            + '<script>unclosed(); document.cookie', // unclosed, runs to EOF
          ),
        },
      },
    },
    'google-1',
  );
  assert.match(item.body, /Kept/);
  assert.doesNotMatch(
    item.body,
    /upper\(\)|attr\(\)|unclosed\(\)|document\.cookie|color:red|<script|<style/i,
  );
});

test('Gmail prefers the HTML alternative when text/plain contains generated markup and CSS', () => {
  const item = renderGmailMessage(
    {
      id: 'newsletter-1',
      payload: {
        headers: [{ name: 'Subject', value: 'Newsletter' }],
        mimeType: 'multipart/alternative',
        parts: [
          {
            mimeType: 'text/plain',
            body: {
              data: encoded(
                '96 @media only screen and (min-width:720px) {.u-row{width:700px!important}} ' +
                '.u-col{display:block!important}.v-button{color:red!important}' +
                '<a href="https://example.test">Visible offer</a>',
              ),
            },
          },
          {
            mimeType: 'text/html',
            body: {
              data: encoded(
                '<html><head><style>@media (min-width:720px){.u-row{width:700px!important}}</style></head>' +
                '<body><p>Visible offer</p><script>steal()</script></body></html>',
              ),
            },
          },
        ],
      },
    },
    'google-1',
  );
  assert.match(item.body, /Visible offer/);
  assert.doesNotMatch(item.body, /@media|!important|<a|steal\(\)/);
});

test('Gmail HTML fallback never turns encoded tags into active Markdown HTML', () => {
  const item = renderGmailMessage(
    {
      id: 'encoded-html-1',
      payload: {
        headers: [{ name: 'Subject', value: 'Untrusted HTML' }],
        mimeType: 'text/html',
        body: {
          data: encoded(
            '<p>Visible</p>&lt;img src=x onerror=alert(1)&gt;' +
              '&lt;script&gt;alert(2)&lt;/script&gt;',
          ),
        },
      },
    },
    'google-1',
  );
  assert.match(item.body, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(item.body, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
  assert.doesNotMatch(item.body, /<img|<script/);
});

test('Gmail HTML fallback removes table indentation and decodes safe numeric entities', () => {
  const item = renderGmailMessage(
    {
      id: 'table-html-1',
      payload: {
        headers: [{ name: 'Subject', value: 'Payment receipt' }],
        mimeType: 'text/html',
        body: {
          data: encoded(
            '<table><tr><td>    Merci d&#x27;avoir payé.</td></tr>' +
              '<tr><td>        Numéro de transaction</td></tr></table>',
          ),
        },
      },
    },
    'google-1',
  );
  assert.match(item.body, /Merci d'avoir payé\./);
  assert.match(item.body, /Numéro de transaction/);
  assert.doesNotMatch(item.body, /\n {4,}\S/);
});

test('Gmail pagination stops when a page is empty even with a nextPageToken', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'connectors-gmail-'));
  const tokens = new GoogleTokenProvider({ dataDir });
  tokens.write('demo', 'google-1', {
    accessToken: 'access',
    scopes: [GMAIL_READONLY_SCOPE],
  });
  let calls = 0;
  const collector = new GmailCollector({
    tokens,
    fetch: async () => {
      calls += 1;
      return Response.json({ messages: [], nextPageToken: 'should-not-be-used' });
    },
  });
  const items = await collector.collect(
    { maxMessages: 10 },
    {
      workspace: { name: 'demo', path: '/unused' },
      instanceId: 'google-1',
    },
  );
  assert.deepEqual(items, []);
  assert.equal(calls, 1);
});

test('Gmail collection limits are bounded before any API call', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'connectors-gmail-'));
  const tokens = new GoogleTokenProvider({ dataDir });
  tokens.write('demo', 'google-1', {
    accessToken: 'access',
    scopes: [GMAIL_READONLY_SCOPE],
  });
  let calls = 0;
  const collector = new GmailCollector({
    tokens,
    fetch: async () => {
      calls += 1;
      return Response.json({});
    },
  });
  await assert.rejects(
    collector.collect(
      { maxMessages: 501 },
      {
        workspace: { name: 'demo', path: '/unused' },
        instanceId: 'google-1',
      },
    ),
    /between 1 and 500/,
  );
  assert.equal(calls, 0);
});

test('agent routes connectorId google through GmailCollector into the real sink', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'connectors-gmail-agent-'));
  const workspace = path.join(root, 'demo');
  const dataDir = path.join(root, 'data');
  await mkdir(path.join(workspace, 'raw', 'untracked'), { recursive: true });
  const mockFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/messages')) {
      return Response.json({ messages: [{ id: 'agent-message' }] });
    }
    return Response.json({
      id: 'agent-message',
      snippet: 'From the agent path',
      payload: {
        headers: [{ name: 'Subject', value: 'Agent integration' }],
        mimeType: 'text/plain',
        body: { data: encoded('Collected through GmailCollector.') },
      },
    });
  };
  const tokens = new GoogleTokenProvider({ dataDir });
  tokens.write('demo', 'google-1', {
    accessToken: 'access',
    scopes: [GMAIL_READONLY_SCOPE],
  });
  const agent = new ConnectorsAgent(
    loadConfig({ WORKSPACES_ROOT: root, AGENT_DATA_DIR: dataDir }),
    { collectors: [new GmailCollector({ tokens, fetch: mockFetch })] },
  );
  const accepted = await agent.execute({
    idempotencyKey: 'gmail-agent-test',
    operation: 'collect',
    workspace: { name: 'demo' },
    arguments: {
      connectorId: 'google',
      instanceId: 'google-1',
      maxMessages: 1,
    },
  });
  assert.equal(accepted.accepted, true);
  assert.ok(accepted.jobId);
  let terminal: Record<string, unknown> | undefined;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    terminal = agent.status(accepted.jobId!);
    if (terminal.terminal === true) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(terminal?.status, 'succeeded');
  const files = await readdir(
    path.join(workspace, 'raw', 'untracked', 'connectors', 'google-1'),
  );
  assert.equal(files.length, 1);
});

test('agent exposes a non-secret authentication_required reason when tokens are absent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'connectors-gmail-agent-'));
  const workspace = path.join(root, 'demo');
  const dataDir = path.join(root, 'data');
  await mkdir(path.join(workspace, 'raw', 'untracked'), { recursive: true });
  const tokens = new GoogleTokenProvider({ dataDir });
  const agent = new ConnectorsAgent(
    loadConfig({ WORKSPACES_ROOT: root, AGENT_DATA_DIR: dataDir }),
    {
      collectors: [
        new GmailCollector({
          tokens,
          fetch: async () => {
            throw new Error('HTTP must not be called without tokens');
          },
        }),
      ],
    },
  );
  const accepted = await agent.execute({
    operation: 'collect',
    workspace: { name: 'demo' },
    arguments: { connectorId: 'google', instanceId: 'google-1' },
  });
  assert.ok(accepted.jobId);
  let status: Record<string, any> = {};
  for (let attempt = 0; attempt < 50; attempt += 1) {
    status = agent.status(accepted.jobId!);
    if (status.terminal === true) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(status.status, 'failed');
  assert.equal(status.result?.error, 'authentication_required');
  assert.doesNotMatch(JSON.stringify(status), /google_not_configured|tokens\.json/);
});
