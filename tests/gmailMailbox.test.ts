import assert from 'node:assert/strict';
import test from 'node:test';

import { GmailMailbox } from '../src/gmailMailbox.ts';
import type { GoogleTokenProvider } from '../src/googleTokens.ts';

function tokenProvider(grants: string[]) {
  return {
    async getAccessToken(
      _workspace: string,
      _instanceId: string,
      options: { requiredGrants?: string[] } = {},
    ) {
      for (const grant of options.requiredGrants ?? []) {
        if (!grants.includes(grant)) throw new Error(`missing:${grant}`);
      }
      return 'access-token';
    },
  } as unknown as GoogleTokenProvider;
}

function response(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

test('Gmail mailbox summary reports totals and unread estimates without importing', async () => {
  const urls: string[] = [];
  const mailbox = new GmailMailbox({
    tokens: tokenProvider(['read']),
    fetch: async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith('/profile')) {
        return response({ emailAddress: 'me@example.test', messagesTotal: 42, threadsTotal: 30 });
      }
      return response({ resultSizeEstimate: url.includes('in%3Ainbox') ? 3 : 7 });
    },
  });

  const result = await mailbox.summary({ workspace: 'docs', instanceId: 'google-1' });
  assert.deepEqual(result, {
    emailAddress: 'me@example.test',
    messagesTotal: 42,
    threadsTotal: 30,
    unread: 7,
    inboxUnread: 3,
  });
  assert.equal(urls.length, 3);
});

test('Gmail mailbox search returns compact message metadata and provider labels', async () => {
  const mailbox = new GmailMailbox({
    tokens: tokenProvider(['read']),
    fetch: async (input) => {
      const url = String(input);
      if (url.includes('/messages?')) {
        return response({ messages: [{ id: 'm1' }], resultSizeEstimate: 1 });
      }
      return response({
        id: 'm1',
        threadId: 't1',
        labelIds: ['INBOX', 'UNREAD'],
        snippet: 'Hello',
        payload: { headers: [{ name: 'Subject', value: 'Test' }, { name: 'From', value: 'a@example.test' }] },
      });
    },
  });

  const result = await mailbox.search(
    { workspace: 'docs', instanceId: 'google-1' },
    { query: 'is:unread', maxMessages: 10 },
  ) as { messages: Array<Record<string, unknown>> };
  assert.equal(result.messages[0]?.subject, 'Test');
  assert.deepEqual(result.messages[0]?.labelIds, ['INBOX', 'UNREAD']);
});

test('Gmail mailbox mutations require modify and map actions to label changes', async () => {
  let request: RequestInit | undefined;
  const mailbox = new GmailMailbox({
    tokens: tokenProvider(['modify']),
    fetch: async (_input, init) => {
      request = init;
      return response({ id: 'm1', labelIds: ['INBOX'] });
    },
  });

  const result = await mailbox.modify(
    { workspace: 'docs', instanceId: 'google-1' },
    'm1',
    'mark_read',
  );
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(String(request?.body)), { removeLabelIds: ['UNREAD'] });
});

test('Gmail mailbox read returns one message in full, bounded and framed as untrusted', async () => {
  const b64 = (text: string) => Buffer.from(text).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
  const urls: string[] = [];
  const mailbox = new GmailMailbox({
    tokens: tokenProvider(['read']),
    fetch: async (input) => {
      urls.push(String(input));
      return response({
        id: 'm1',
        threadId: 't1',
        labelIds: ['INBOX'],
        payload: {
          mimeType: 'multipart/mixed',
          headers: [
            { name: 'From', value: 'Alice <alice@example.test>' },
            { name: 'Subject', value: 'Budget 2027' },
            { name: 'Date', value: 'Sat, 3 Oct 2026 12:02:00 +0200' },
          ],
          parts: [
            { mimeType: 'text/plain', body: { data: b64('Bonjour,\n\n' + 'x'.repeat(2000)) } },
            { mimeType: 'application/pdf', filename: 'budget.pdf', body: {} },
          ],
        },
      });
    },
  });

  const message = await mailbox.read({ workspace: 'demo', instanceId: 'google-1' }, { messageId: 'm1', maxChars: 500 });
  assert.match(urls[0], /\/messages\/m1\?format=full$/);
  assert.equal(message.subject, 'Budget 2027');
  assert.equal(message.from, 'Alice <alice@example.test>');
  assert.deepEqual(message.attachments, ['budget.pdf']);
  assert.match(String(message.body), /^Bonjour,/);
  assert.equal(String(message.body).length, 500);
  assert.equal(message.truncated, true);
  assert.match(String(message.note), /untrusted/);
  await assert.rejects(
    new GmailMailbox({ tokens: tokenProvider([]), fetch: async () => response({}) })
      .read({ workspace: 'demo', instanceId: 'google-1' }, { messageId: 'm1' }),
    /missing:read/,
  );
});
