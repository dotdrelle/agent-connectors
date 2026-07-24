import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  GMAIL_READONLY_SCOPE,
  GoogleTokenProvider,
} from '../src/googleTokens.ts';

test('Google tokens are isolated per workspace/instance and stored with mode 0600', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'connectors-tokens-'));
  const provider = new GoogleTokenProvider({ dataDir });
  provider.write('alpha', 'google-1', {
    accessToken: 'alpha-access',
    refreshToken: 'alpha-refresh',
    scopes: [GMAIL_READONLY_SCOPE],
  });
  provider.write('beta', 'google-1', {
    accessToken: 'beta-access',
    scopes: [GMAIL_READONLY_SCOPE],
  });

  assert.equal(provider.read('alpha', 'google-1').accessToken, 'alpha-access');
  assert.equal(provider.read('beta', 'google-1').accessToken, 'beta-access');
  assert.throws(() => provider.read('alpha', '../google-1'), /safe identifier/);

  const tokenPath = path.join(dataDir, 'alpha', 'google-1', 'tokens.json');
  const metadata = await stat(tokenPath);
  assert.equal(metadata.mode & 0o777, 0o600);
  const raw = await readFile(tokenPath, 'utf8');
  assert.match(raw, /alpha-refresh/);
  assert.doesNotMatch(raw, /beta-access/);
});

test('expired Google tokens are refreshed and atomically persisted', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'connectors-tokens-'));
  const now = Date.parse('2026-07-24T10:00:00.000Z');
  let refreshCalls = 0;
  const provider = new GoogleTokenProvider({
    dataDir,
    clientId: 'client-id',
    now: () => now,
    fetch: async (_input, init) => {
      refreshCalls += 1;
      assert.equal(init?.method, 'POST');
      const body = init?.body as URLSearchParams;
      assert.equal(body.get('grant_type'), 'refresh_token');
      assert.equal(body.get('refresh_token'), 'old-refresh');
      assert.equal(body.get('client_secret'), null);
      return Response.json({
        access_token: 'new-access',
        expires_in: 3600,
        token_type: 'Bearer',
      });
    },
  });
  provider.write('demo', 'google-1', {
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    expiresAt: '2026-07-24T09:59:00.000Z',
    scopes: [GMAIL_READONLY_SCOPE],
  });

  assert.equal(await provider.getAccessToken('demo', 'google-1'), 'new-access');
  assert.equal(refreshCalls, 1);
  const persisted = provider.read('demo', 'google-1');
  assert.equal(persisted.accessToken, 'new-access');
  assert.equal(persisted.refreshToken, 'old-refresh');
  assert.equal(persisted.expiresAt, '2026-07-24T11:00:00.000Z');
});

test('configured token scopes must include gmail.readonly', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'connectors-tokens-'));
  const provider = new GoogleTokenProvider({ dataDir });
  provider.write('demo', 'google-1', {
    accessToken: 'access',
    scopes: ['https://www.googleapis.com/auth/gmail.modify'],
  });
  assert.throws(
    () => provider.read('demo', 'google-1'),
    /gmail_readonly_scope_missing/,
  );
  provider.write('missing', 'google-1', {
    accessToken: 'access',
  });
  assert.throws(
    () => provider.read('missing', 'google-1'),
    /gmail_readonly_scope_missing/,
  );
});
