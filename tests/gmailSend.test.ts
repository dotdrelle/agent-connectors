import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ConnectorsAgent } from '../src/agent.ts';
import { loadConfig } from '../src/config.ts';
import { buildMimeMessage, deterministicMessageId, GmailSender } from '../src/gmailSend.ts';
import {
  GMAIL_READONLY_SCOPE,
  GMAIL_SEND_SCOPE,
  GoogleTokenProvider,
} from '../src/googleTokens.ts';
import { parseSendRequest, type SendRequest } from '../src/sender.ts';

const LIMITS = { maxRecipients: 25, maxBodyBytes: 262_144, allowedRecipients: [] };

function request(overrides: Partial<SendRequest> = {}): SendRequest {
  return {
    to: ['dest@example.com'],
    cc: [],
    bcc: [],
    subject: 'Hello',
    body: 'Body text',
    dryRun: false,
    ...overrides,
  };
}

async function makeAgent(options: {
  scopes?: string[];
  fetch?: typeof fetch;
  env?: Record<string, string>;
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'connectors-send-'));
  const dataDir = path.join(root, 'data');
  await mkdir(path.join(root, 'demo', 'raw', 'untracked'), { recursive: true });
  const tokens = new GoogleTokenProvider({ dataDir });
  if (options.scopes) {
    tokens.write('demo', 'google-1', { accessToken: 'access', scopes: options.scopes });
  }
  const sender = new GmailSender({
    tokens,
    fetch:
      options.fetch ??
      (async () => {
        throw new Error('HTTP must not be called');
      }),
  });
  const agent = new ConnectorsAgent(
    loadConfig({ WORKSPACES_ROOT: root, AGENT_DATA_DIR: dataDir, ...options.env }),
    { senders: [sender] },
  );
  return { agent, root };
}

async function runToTerminal(agent: ConnectorsAgent, jobId: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const status = agent.status(jobId) as Record<string, unknown>;
    if (status.terminal === true) return status;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('job did not reach a terminal status in time');
}

test('the MIME message is RFC 5322 with no From header and base64 UTF-8 body', () => {
  const mime = buildMimeMessage(
    request({
      to: ['Ada Lovelace <ada@example.com>', 'b@example.com'],
      cc: ['c@example.com'],
      subject: 'Rapport hebdomadaire — été',
      body: 'Bonjour,\nvoici le résumé.',
      replyTo: 'reply@example.com',
    }),
  );
  const [rawHeaders, rawBody] = mime.split('\r\n\r\n');
  const headers = rawHeaders!.replace(/\r\n[ \t]/g, ' ');

  // Gmail stamps the authenticated mailbox itself: never let a task choose it.
  assert.doesNotMatch(headers, /^From:/m);
  assert.match(headers, /^To: Ada Lovelace <ada@example\.com>, b@example\.com$/m);
  assert.match(headers, /^Cc: c@example\.com$/m);
  assert.match(headers, /^Reply-To: reply@example\.com$/m);
  assert.match(headers, /^Content-Type: text\/plain; charset="UTF-8"$/m);
  assert.match(headers, /^Content-Transfer-Encoding: base64$/m);

  const subject = /^Subject: (.*)$/m.exec(headers)![1]!;
  assert.match(subject, /^=\?UTF-8\?B\?/);
  const decodedSubject = subject
    .split(/\s+/)
    .map((word) => Buffer.from(word.slice('=?UTF-8?B?'.length, -2), 'base64').toString('utf8'))
    .join('');
  assert.equal(decodedSubject, 'Rapport hebdomadaire — été');
  assert.equal(
    Buffer.from(rawBody!.replace(/\r\n/g, ''), 'base64').toString('utf8'),
    'Bonjour,\nvoici le résumé.',
  );
});

test('encoded words never split a multi-byte character', () => {
  const subject = 'é'.repeat(60);
  const mime = buildMimeMessage(request({ subject }));
  const value = /^Subject: ([\s\S]*?)\r\n[A-Z]/m.exec(mime)![1]!;
  const decoded = value
    .split(/\r\n\s|\s/)
    .filter(Boolean)
    .map((word) => Buffer.from(word.slice('=?UTF-8?B?'.length, -2), 'base64').toString('utf8'))
    .join('');
  assert.equal(decoded, subject);
  for (const line of mime.split('\r\n')) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 998, 'no line may exceed 998 octets');
  }
});

test('header injection and malformed addresses are rejected before any send', () => {
  assert.throws(
    () => parseSendRequest({ to: 'a@example.com\r\nBcc: evil@example.com', subject: 's', body: 'b' }, LIMITS),
    /to_header_injection/,
  );
  assert.throws(
    () => parseSendRequest({ to: 'not-an-address', subject: 's', body: 'b' }, LIMITS),
    /to_invalid_address/,
  );
  assert.throws(
    () => parseSendRequest({ to: 'a@example.com', subject: 'x\nBcc: y@z.com', body: 'b' }, LIMITS),
    /subject_header_injection/,
  );
  assert.throws(
    () => parseSendRequest({ to: 'a@example.com', subject: 's', body: '  ' }, LIMITS),
    /body_required/,
  );
  // An unknown field is refused rather than dropped: the message that gets
  // sent must be the message that was approved.
  assert.throws(
    () => parseSendRequest({ to: 'a@example.com', subject: 's', body: 'b', html: '<b>x</b>' }, LIMITS),
    /unsupported_field:html/,
  );
  // "a@x, b@y" in one string is two recipients, both validated.
  assert.deepEqual(
    parseSendRequest({ to: 'a@example.com, b@example.com', subject: 's', body: 'b' }, LIMITS).to,
    ['a@example.com', 'b@example.com'],
  );
});

test('the recipient allow-list is enforced on To, Cc and Bcc', () => {
  const limits = { ...LIMITS, allowedRecipients: ['@corp.example', 'boss@other.example'] };
  assert.ok(parseSendRequest({ to: 'a@corp.example', subject: 's', body: 'b' }, limits));
  assert.ok(parseSendRequest({ to: 'boss@other.example', subject: 's', body: 'b' }, limits));
  assert.throws(
    () => parseSendRequest({ to: 'a@corp.example', bcc: 'leak@elsewhere.example', subject: 's', body: 'b' }, limits),
    /recipient_not_allowed/,
  );
});

test('a send without the send grant fails on authorization, not on the network', async () => {
  const { agent } = await makeAgent({ scopes: [GMAIL_READONLY_SCOPE] });
  const accepted = await agent.execute({
    operation: 'send',
    workspace: { name: 'demo' },
    arguments: { to: 'dest@example.com', subject: 'Hi', body: 'Body' },
  });
  assert.equal(accepted.accepted, true);
  const terminal = await runToTerminal(agent, accepted.jobId!);
  assert.equal(terminal.status, 'failed');
  // A read-only workspace must be told to re-authorize, not to retry.
  assert.equal((terminal.result as { error?: string }).error, 'authorization_required:send');
});

test('a valid send posts the message once and reports the provider ids', async () => {
  let calls = 0;
  let rawSent = '';
  const { agent } = await makeAgent({
    scopes: [GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE],
    fetch: async (input, init) => {
      calls += 1;
      const url = new URL(String(input));
      assert.ok(url.pathname.endsWith('/gmail/v1/users/me/messages/send'));
      assert.equal(init?.method, 'POST');
      rawSent = Buffer.from(
        (JSON.parse(String(init?.body)) as { raw: string }).raw,
        'base64url',
      ).toString('utf8');
      return Response.json({ id: 'sent-1', threadId: 'thread-1' });
    },
  });

  const accepted = await agent.execute({
    idempotencyKey: 'send-key-1',
    operation: 'send',
    workspace: { name: 'demo' },
    arguments: { to: 'dest@example.com', subject: 'Hi', body: 'Body' },
  });
  const terminal = await runToTerminal(agent, accepted.jobId!);
  assert.equal(terminal.status, 'succeeded');
  assert.deepEqual((terminal.result as { sent?: unknown }).sent, {
    recipients: 1,
    bytes: Buffer.byteLength(rawSent, 'utf8'),
    messageId: 'sent-1',
    threadId: 'thread-1',
  });
  assert.match(rawSent, new RegExp(`^Message-ID: ${deterministicMessageId('send-key-1')}`));

  // Replaying the key returns the first outcome instead of sending again.
  const replay = await agent.execute({
    idempotencyKey: 'send-key-1',
    operation: 'send',
    workspace: { name: 'demo' },
    arguments: { to: 'dest@example.com', subject: 'Hi', body: 'Body' },
  });
  assert.equal(replay.idempotent, true);
  assert.equal(replay.jobId, accepted.jobId);
  assert.equal(calls, 1);
});

test('dryRun builds the message and contacts no provider', async () => {
  const { agent } = await makeAgent({ scopes: [GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE] });
  const accepted = await agent.execute({
    operation: 'send',
    workspace: { name: 'demo' },
    arguments: { to: 'dest@example.com', subject: 'Hi', body: 'Body', dryRun: true },
  });
  const terminal = await runToTerminal(agent, accepted.jobId!);
  assert.equal(terminal.status, 'succeeded');
  assert.equal((terminal.result as { sent: { dryRun: boolean } }).sent.dryRun, true);
});

test('a provider 4xx on send is terminal, a 429 is a rate limit', async () => {
  for (const [status, expected] of [
    [400, 'send_rejected'],
    [429, 'provider_rate_limited'],
    [503, 'provider_unavailable'],
  ] as const) {
    const { agent } = await makeAgent({
      scopes: [GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE],
      fetch: async () => new Response('provider detail', { status }),
    });
    const accepted = await agent.execute({
      operation: 'send',
      workspace: { name: 'demo' },
      arguments: { to: 'dest@example.com', subject: 'Hi', body: 'Body' },
    });
    const terminal = await runToTerminal(agent, accepted.jobId!);
    const error = (terminal.result as { error?: string }).error;
    assert.equal(error, expected);
    // The provider body may echo the message; it must never be persisted.
    assert.doesNotMatch(String(error), /provider detail/);
  }
});

test('malformed send arguments are rejected synchronously, without creating a job', async () => {
  const { agent } = await makeAgent({ scopes: [GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE] });
  const rejected = await agent.execute({
    operation: 'send',
    workspace: { name: 'demo' },
    arguments: { to: 'nope', subject: 'Hi', body: 'Body' },
  });
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.jobId, undefined);
  assert.match(String(rejected.error), /invalid_arguments:to_invalid_address/);
});

test('CONNECTORS_SEND_ENABLED=false removes the capability and refuses the operation', async () => {
  const { agent } = await makeAgent({
    scopes: [GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE],
    env: { CONNECTORS_SEND_ENABLED: 'false' },
  });
  const description = agent.describe() as { capabilities: Array<{ id: string }> };
  assert.equal(
    description.capabilities.some((c) => c.id === 'communication.send-email'),
    false,
  );
  const refused = await agent.execute({
    operation: 'send',
    workspace: { name: 'demo' },
    arguments: { to: 'dest@example.com', subject: 'Hi', body: 'Body' },
  });
  assert.equal(refused.accepted, false);
  assert.match(String(refused.error), /capability_disabled/);
});
