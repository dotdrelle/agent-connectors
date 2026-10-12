import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { TchapAuth } from '../src/tchap/auth.ts';

const SERVER = 'agent.example.tchap.gouv.fr';
const HS = `https://matrix.${SERVER}`;
const ISSUER = `https://auth.${SERVER}`;

type Call = { url: string; method: string; body: string };

/** A fake Tchap: well-known, MAS discovery, registration, device code, token (rotating refresh), whoami, revoke. */
function fakeTchap(options: { approveAfter?: number; refreshStatus?: number } = {}) {
  const calls: Call[] = [];
  let polls = 0;
  let refreshCount = 0;
  let validRefresh = 'refresh-0';
  const json = (status: number, payload: unknown) =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    const body = init.body ? String(init.body) : '';
    calls.push({ url, method: init.method ?? 'GET', body });
    if (url === `https://${SERVER}/.well-known/matrix/client`) {
      return json(200, { 'm.homeserver': { base_url: HS }, 'm.authentication': { issuer: ISSUER } });
    }
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return json(200, {
        registration_endpoint: `${ISSUER}/oauth2/registration`,
        device_authorization_endpoint: `${ISSUER}/oauth2/device`,
        token_endpoint: `${ISSUER}/oauth2/token`,
        revocation_endpoint: `${ISSUER}/oauth2/revoke`,
      });
    }
    if (url === `${ISSUER}/oauth2/registration`) return json(201, { client_id: 'CLIENT1' });
    if (url === `${ISSUER}/oauth2/device`) {
      return json(200, {
        device_code: 'DEV', user_code: 'ABCD-EFGH', verification_uri: `${ISSUER}/link`,
        verification_uri_complete: `${ISSUER}/link?code=ABCD-EFGH`, interval: 5, expires_in: 1200,
      });
    }
    if (url === `${ISSUER}/oauth2/token`) {
      const form = new URLSearchParams(body);
      if (form.get('grant_type') === 'refresh_token') {
        if (options.refreshStatus) return json(options.refreshStatus, { error: 'invalid_grant' });
        if (form.get('refresh_token') !== validRefresh) return json(400, { error: 'invalid_grant' });
        refreshCount += 1;
        validRefresh = `refresh-${refreshCount}`;
        return json(200, { access_token: `access-${refreshCount}`, refresh_token: validRefresh, expires_in: 1800 });
      }
      polls += 1;
      if (polls <= (options.approveAfter ?? 1)) return json(400, { error: 'authorization_pending' });
      return json(200, { access_token: 'access-0', refresh_token: 'refresh-0', expires_in: 1800 });
    }
    if (url === `${HS}/_matrix/client/v3/account/whoami`) return json(200, { user_id: '@me:example', device_id: 'DEVICEID' });
    if (url === `${ISSUER}/oauth2/revoke`) return json(200, {});
    return json(404, {});
  };
  return { fetchImpl, calls };
}

test('device flow: discovery, one registration per issuer, pending then approved, session written 0600', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'tchap-auth-'));
  const tchap = fakeTchap({ approveAfter: 1 });
  const auth = new TchapAuth({ dataDir, fetch: tchap.fetchImpl });

  const flow = await auth.startDeviceFlow(SERVER);
  assert.equal(flow.userCode, 'ABCD-EFGH');
  assert.equal(flow.homeserver, HS);
  assert.match(new URLSearchParams(tchap.calls.find((call) => call.url.endsWith('/oauth2/device'))!.body).get('scope')!, /client:device:[A-Z]{10}/);

  assert.deepEqual(await auth.pollDeviceFlow(flow), { state: 'pending' });
  const approved = await auth.pollDeviceFlow(flow);
  assert.equal(approved.state, 'approved');
  const session = auth.readSession()!;
  assert.equal(session.userId, '@me:example');
  assert.equal(session.deviceId, 'DEVICEID');
  assert.equal(statSync(auth.sessionPath()).mode & 0o777, 0o600);

  await auth.startDeviceFlow(SERVER);
  assert.equal(tchap.calls.filter((call) => call.url.endsWith('/oauth2/registration')).length, 1, 'the client is registered once and reused');
  assert.equal(auth.sessionPath(), path.join(dataDir, 'tchap-session.json'), 'one sign-in for every workspace, like CME credentials');
  assert.deepEqual(JSON.parse(readFileSync(path.join(dataDir, 'tchap-clients.json'), 'utf8')), { [ISSUER]: 'CLIENT1' });
  await auth.startDeviceFlow(SERVER);
  assert.equal(tchap.calls.filter((call) => call.url.endsWith('/oauth2/registration')).length, 1, 'the registration is reused');
});

test('refresh rotates the refresh token and writes it before returning the access token', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'tchap-auth-'));
  const tchap = fakeTchap({ approveAfter: 0 });
  let now = 1_000_000;
  const auth = new TchapAuth({ dataDir, fetch: tchap.fetchImpl, now: () => now });
  await auth.pollDeviceFlow(await auth.startDeviceFlow(SERVER));

  assert.equal(await auth.accessToken(), 'access-0', 'a fresh token is used as is');
  now += 16 * 60_000; // inside the 15-minute renewal margin of a 30-minute token
  assert.equal(await auth.accessToken(), 'access-1');
  const stored = JSON.parse(readFileSync(auth.sessionPath(), 'utf8'));
  assert.equal(stored.refreshToken, 'refresh-1', 'the rotated refresh token is persisted');
  assert.equal(await auth.accessToken({ force: true }), 'access-2', 'a forced renewal uses the persisted rotated token');
});

test('concurrent renewals share one refresh: the rotating token is never spent twice', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'tchap-auth-'));
  const tchap = fakeTchap({ approveAfter: 0 });
  const auth = new TchapAuth({ dataDir, fetch: tchap.fetchImpl });
  await auth.pollDeviceFlow(await auth.startDeviceFlow(SERVER));
  const tokens = await Promise.all([auth.accessToken({ force: true }), auth.accessToken({ force: true })]);
  assert.deepEqual(tokens, ['access-1', 'access-1']);
});

test('a refused refresh asks for a new sign-in', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'tchap-auth-'));
  const tchap = fakeTchap({ approveAfter: 0, refreshStatus: 400 });
  const auth = new TchapAuth({ dataDir, fetch: tchap.fetchImpl });
  await auth.pollDeviceFlow(await auth.startDeviceFlow(SERVER));
  await assert.rejects(auth.accessToken({ force: true }), /tchap_reauthorization_required/);
});

test('revoke calls the revocation endpoint and forgets the session', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'tchap-auth-'));
  const tchap = fakeTchap({ approveAfter: 0 });
  const auth = new TchapAuth({ dataDir, fetch: tchap.fetchImpl });
  await auth.pollDeviceFlow(await auth.startDeviceFlow(SERVER));
  assert.deepEqual(await auth.revoke(), { revoked: true });
  assert.equal(auth.readSession(), undefined);
});

test('an invalid server name is refused before any request', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'tchap-auth-'));
  const tchap = fakeTchap();
  const auth = new TchapAuth({ dataDir, fetch: tchap.fetchImpl });
  await assert.rejects(auth.startDeviceFlow('localhost:8008/evil'), /tchap_server_invalid/);
  assert.equal(tchap.calls.length, 0);
});
