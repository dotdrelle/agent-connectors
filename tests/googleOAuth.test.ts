import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from '../src/config.ts';
import { GoogleOAuthService } from '../src/googleOAuth.ts';
import {
  GMAIL_READONLY_SCOPE,
  GMAIL_SEND_SCOPE,
  GoogleTokenProvider,
} from '../src/googleTokens.ts';

const STATE_SECRET = '0123456789abcdef0123456789abcdef';
const CALLBACK = 'https://connectors.example.test/oauth/google/callback';

test('Google OAuth start uses PKCE S256, signed state and durable pending storage', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'connectors-oauth-'));
  const tokens = new GoogleTokenProvider({ dataDir });
  const now = Date.parse('2026-07-24T10:00:00.000Z');
  const oauth = new GoogleOAuthService({
    dataDir,
    clientId: 'client-id',
    clientSecret: 'client-secret',
    callbackUrl: CALLBACK,
    stateSecret: STATE_SECRET,
    tokens,
    now: () => now,
    randomBytes: (size) => Buffer.alloc(size, 7),
  });
  const started = oauth.start('demo', 'google-1');
  const url = new URL(started.authorizationUrl);
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('client_id'), 'client-id');
  assert.equal(url.searchParams.get('redirect_uri'), CALLBACK);
  assert.equal(url.searchParams.get('scope'), GMAIL_READONLY_SCOPE);
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  const verifier = Buffer.alloc(32, 7).toString('base64url');
  assert.equal(
    url.searchParams.get('code_challenge'),
    createHash('sha256').update(verifier).digest('base64url'),
  );
  assert.match(url.searchParams.get('state') ?? '', /^[^.]+\.[^.]+$/);
  assert.equal(started.expiresAt, '2026-07-24T10:10:00.000Z');

  const nonce = Buffer.alloc(24, 7).toString('base64url');
  const pendingPath = path.join(
    dataDir,
    'demo',
    'google-1',
    'oauth',
    'pending',
    `${nonce}.json`,
  );
  assert.equal((await stat(pendingPath)).mode & 0o777, 0o600);
});

test('OAuth callback survives restart, exchanges code once and stores scoped tokens', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'connectors-oauth-'));
  const tokens = new GoogleTokenProvider({ dataDir });
  const now = Date.parse('2026-07-24T10:00:00.000Z');
  let exchanges = 0;
  const makeService = () =>
    new GoogleOAuthService({
      dataDir,
      clientId: 'client-id',
      callbackUrl: CALLBACK,
      stateSecret: STATE_SECRET,
      tokens,
      now: () => now,
      randomBytes: (size) => Buffer.alloc(size, 11),
      fetch: async (_input, init) => {
        exchanges += 1;
        const body = init?.body as URLSearchParams;
        assert.equal(body.get('code'), 'authorization-code');
        assert.equal(body.get('code_verifier'), Buffer.alloc(32, 11).toString('base64url'));
        assert.equal(body.get('redirect_uri'), CALLBACK);
        assert.equal(body.get('client_secret'), null);
        return Response.json({
          access_token: 'oauth-access',
          refresh_token: 'oauth-refresh',
          expires_in: 1800,
          token_type: 'Bearer',
          scope: GMAIL_READONLY_SCOPE,
        });
      },
    });
  const started = makeService().start('demo', 'google-1');
  const state = new URL(started.authorizationUrl).searchParams.get('state')!;

  const completed = await makeService().complete({
    state,
    code: 'authorization-code',
  });
  assert.deepEqual(completed, {
    workspace: 'demo',
    instanceId: 'google-1',
    grants: ['read'],
    returnTo: null,
  });
  assert.equal(exchanges, 1);
  assert.deepEqual(tokens.read('demo', 'google-1'), {
    accessToken: 'oauth-access',
    refreshToken: 'oauth-refresh',
    expiresAt: '2026-07-24T10:30:00.000Z',
    tokenType: 'Bearer',
    scopes: [GMAIL_READONLY_SCOPE],
    scopeSource: 'token-response',
  });

  await assert.rejects(
    makeService().complete({ state, code: 'authorization-code' }),
    /already_used_or_unknown/,
  );
  assert.equal(exchanges, 1);
});

test('concurrent callbacks atomically claim pending state and exchange only once', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'connectors-oauth-'));
  const tokens = new GoogleTokenProvider({ dataDir });
  let exchanges = 0;
  const oauth = new GoogleOAuthService({
    dataDir,
    clientId: 'client-id',
    clientSecret: 'client-secret',
    callbackUrl: CALLBACK,
    stateSecret: STATE_SECRET,
    tokens,
    fetch: async () => {
      exchanges += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return Response.json({
        access_token: 'access',
        refresh_token: 'refresh',
        scope: GMAIL_READONLY_SCOPE,
      });
    },
  });
  const state = new URL(
    oauth.start('demo', 'google-1').authorizationUrl,
  ).searchParams.get('state')!;
  const outcomes = await Promise.allSettled([
    oauth.complete({ state, code: 'same-code' }),
    oauth.complete({ state, code: 'same-code' }),
  ]);
  assert.equal(
    outcomes.filter((outcome) => outcome.status === 'fulfilled').length,
    1,
  );
  const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
  assert.match(String(rejected && rejected.status === 'rejected' && rejected.reason), /already_used/);
  assert.equal(exchanges, 1);
});

test('missing token-response scope records the authorization-request fallback', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'connectors-oauth-'));
  const tokens = new GoogleTokenProvider({ dataDir });
  const oauth = new GoogleOAuthService({
    dataDir,
    clientId: 'client-id',
    clientSecret: 'client-secret',
    callbackUrl: CALLBACK,
    stateSecret: STATE_SECRET,
    tokens,
    fetch: async () =>
      Response.json({
        access_token: 'access-with-implicit-scope',
        refresh_token: 'refresh',
      }),
  });
  const state = new URL(
    oauth.start('demo', 'google-1').authorizationUrl,
  ).searchParams.get('state')!;
  await oauth.complete({ state, code: 'code' });
  const stored = tokens.read('demo', 'google-1');
  assert.deepEqual(stored.scopes, [GMAIL_READONLY_SCOPE]);
  assert.equal(stored.scopeSource, 'authorization-request-default');
});

test('OAuth rejects tampered, expired and incorrectly scoped callbacks', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'connectors-oauth-'));
  const tokens = new GoogleTokenProvider({ dataDir });
  let now = Date.parse('2026-07-24T10:00:00.000Z');
  const oauth = new GoogleOAuthService({
    dataDir,
    clientId: 'client-id',
    clientSecret: 'client-secret',
    callbackUrl: CALLBACK,
    stateSecret: STATE_SECRET,
    tokens,
    stateTtlSeconds: 60,
    now: () => now,
    fetch: async () =>
      Response.json({
        access_token: 'wrong-scope',
        scope: 'https://www.googleapis.com/auth/gmail.modify',
      }),
  });
  const firstState = new URL(
    oauth.start('demo', 'google-1').authorizationUrl,
  ).searchParams.get('state')!;
  // A tampered signature is reported as a signature mismatch, not as a generic
  // "invalid state": the same code is what an operator sees when
  // OAUTH_STATE_SECRET changed between start and callback.
  await assert.rejects(
    oauth.complete({ state: `${firstState.slice(0, -1)}x`, code: 'code' }),
    /oauth_state_signature_mismatch/,
  );
  await assert.rejects(
    oauth.complete({ state: 'not-a-signed-state', code: 'code' }),
    /oauth_state_malformed/,
  );

  const expiringState = new URL(
    oauth.start('demo', 'google-1').authorizationUrl,
  ).searchParams.get('state')!;
  now += 61_000;
  await assert.rejects(
    oauth.complete({ state: expiringState, code: 'code' }),
    /oauth_state_expired/,
  );

  // `gmail.modify` contient la lecture : ce retour SATISFAIT désormais le
  // droit `read` demandé, au lieu d'être rejeté. C'est ce qui permet de ne
  // demander que deux scopes pour trois droits, donc une case de moins à
  // cocher chez Google.
  now = Date.parse('2026-07-24T10:02:00.000Z');
  const broaderScopeState = new URL(
    oauth.start('demo', 'google-1').authorizationUrl,
  ).searchParams.get('state')!;
  await oauth.complete({ state: broaderScopeState, code: 'code' });
  assert.deepEqual(tokens.read('demo', 'google-1').scopes, [
    'https://www.googleapis.com/auth/gmail.modify',
  ]);
});

test('a callback that grants none of the requested scopes is rejected', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'connectors-oauth-'));
  const tokens = new GoogleTokenProvider({ dataDir });
  const oauth = new GoogleOAuthService({
    dataDir,
    clientId: 'client-id',
    clientSecret: 'client-secret',
    callbackUrl: CALLBACK,
    stateSecret: STATE_SECRET,
    tokens,
    // L'utilisateur a décoché l'envoi sur l'écran de consentement : la lecture
    // est accordée, l'envoi non. Le droit manquant doit être nommé.
    fetch: async () =>
      Response.json({
        access_token: 'partial',
        scope: 'https://www.googleapis.com/auth/gmail.readonly',
      }),
  });
  const state = new URL(
    oauth.start('demo', 'google-1', { grants: ['read', 'send'] }).authorizationUrl,
  ).searchParams.get('state')!;
  await assert.rejects(
    oauth.complete({ state, code: 'code' }),
    /gmail_send_scope_missing/,
  );
  assert.throws(() => tokens.read('demo', 'google-1'), /google_not_configured/);
});

test('OAuth configuration requires a strong state secret and HTTPS except explicit localhost', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'connectors-oauth-'));
  const tokens = new GoogleTokenProvider({ dataDir });
  const base = {
    dataDir,
    clientId: 'client',
    clientSecret: 'secret',
    tokens,
    stateSecret: STATE_SECRET,
  };
  assert.throws(
    () =>
      new GoogleOAuthService({
        ...base,
        callbackUrl: 'http://connectors.example.test/oauth/google/callback',
      }),
    /must use HTTPS/,
  );
  assert.throws(
    () =>
      new GoogleOAuthService({
        ...base,
        callbackUrl: CALLBACK,
        stateSecret: 'too-short',
      }),
    /at least 32 bytes/,
  );
  assert.doesNotThrow(
    () =>
      new GoogleOAuthService({
        ...base,
        callbackUrl: 'http://127.0.0.1:3337/oauth/google/callback',
      }),
  );
  assert.throws(
    () => loadConfig({ OAUTH_START_TOKEN: 'too-short' }),
    /at least 32 bytes/,
  );
  const aliased = loadConfig({
    GOOGLE_OAUTH_CLIENT_ID: 'aliased-client',
    GOOGLE_OAUTH_CLIENT_SECRET: 'aliased-secret',
  });
  assert.equal(aliased.googleClientId, 'aliased-client');
  assert.equal(aliased.googleClientSecret, 'aliased-secret');
  assert.equal(
    loadConfig({ GOOGLE_OAUTH_CLIENT_ID: 'packaged-client' }).googleClientId,
    'packaged-client',
  );
  assert.equal(
    loadConfig({ GOOGLE_OAUTH_CLIENT_SECRET: 'packaged-secret' }).googleClientSecret,
    'packaged-secret',
  );
});

test('requesting the send grant is incremental and never narrows an existing one', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'connectors-oauth-grants-'));
  const tokens = new GoogleTokenProvider({ dataDir });
  tokens.write('demo', 'google-1', {
    accessToken: 'old-access',
    refreshToken: 'kept-refresh',
    scopes: [GMAIL_READONLY_SCOPE],
  });
  const oauth = new GoogleOAuthService({
    dataDir,
    clientId: 'client-id',
    callbackUrl: CALLBACK,
    stateSecret: STATE_SECRET,
    tokens,
    randomBytes: (size) => Buffer.alloc(size, 9),
    // The token response omits `scope`, the case where a naive implementation
    // would overwrite the stored scopes with only what it just asked for.
    fetch: async () => Response.json({ access_token: 'new-access', expires_in: 3600 }),
  });

  const started = oauth.start('demo', 'google-1', { grants: ['send'] });
  const url = new URL(started.authorizationUrl);
  assert.equal(url.searchParams.get('scope'), GMAIL_SEND_SCOPE);
  assert.equal(url.searchParams.get('include_granted_scopes'), 'true');
  assert.deepEqual(started.grants, ['send']);

  const state = url.searchParams.get('state')!;
  const completed = await oauth.complete({ state, code: 'authorization-code' });
  assert.deepEqual(completed.grants, ['send']);
  const stored = tokens.read('demo', 'google-1', { requiredGrants: ['read', 'send'] });
  assert.deepEqual(stored.scopes, [GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE]);
  assert.equal(stored.refreshToken, 'kept-refresh');
});

test('a returnTo URL rides the signed state to the callback, invalid schemes are dropped', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'connectors-oauth-'));
  const tokens = new GoogleTokenProvider({ dataDir });
  let exchanges = 0;
  const makeService = () =>
    new GoogleOAuthService({
      dataDir,
      clientId: 'client-id',
      callbackUrl: CALLBACK,
      stateSecret: STATE_SECRET,
      tokens,
      randomBytes: (size) => Buffer.alloc(size, 13),
      fetch: async () => {
        exchanges += 1;
        return Response.json({ access_token: 'access', refresh_token: 'refresh', scope: `${GMAIL_READONLY_SCOPE} ${GMAIL_SEND_SCOPE}` });
      },
    });
  const started = makeService().start('demo', 'google-1', {
    grants: ['read', 'send'],
    returnTo: 'https://wiki.example.test/',
  });
  assert.equal(started.returnTo, 'https://wiki.example.test/');
  const state = new URL(started.authorizationUrl).searchParams.get('state')!;
  const completed = await makeService().complete({ state, code: 'authorization-code' });
  assert.equal(completed.returnTo, 'https://wiki.example.test/');

  // javascript: / ftp: / oversized URLs never reach the signed state.
  assert.equal(makeService().start('demo', 'google-1', { returnTo: 'javascript:alert(1)' }).returnTo, null);
  assert.equal(makeService().start('demo', 'google-1', { returnTo: 'ftp://files.example/' }).returnTo, null);
  assert.equal(makeService().start('demo', 'google-1', { returnTo: `https://x.test/${'a'.repeat(600)}` }).returnTo, null);
});
