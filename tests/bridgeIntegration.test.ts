import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { BridgeManager } from '../src/bridge/manager.ts';
import { RuntimeClient } from '../src/bridge/runtimeClient.ts';
import { TchapAuth } from '../src/tchap/auth.ts';
import { BRIDGE_MARKER } from '../src/tchap/matrix.ts';

const SERVER = 'agent.example.tchap.gouv.fr';
const HS = `https://matrix.${SERVER}`;
const ISSUER = `https://auth.${SERVER}`;
const OWNER = `@owner:${SERVER}`;
const ROOM = `!forum:${SERVER}`;
const RUNTIME = 'http://runtime.test';

/**
 * End to end with every remote faked at the fetch level: Tchap sign-in, the
 * Matrix room, and the manager runtime. Proves the wiring the unit tests do
 * not: device code → room setup → bridge awaiting /activate → a message
 * typed in the forum reaches /turn → Donna's answer comes back to the forum.
 */
test('connect, activate from the forum, relay a request and its answer', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'bridge-e2e-'));
  const inbox: Array<Record<string, unknown>> = [];
  const sent: Array<Record<string, unknown>> = [];
  const turns: Array<Record<string, unknown>> = [];
  let pushEvent: ((event: Record<string, unknown>) => void) | undefined;
  const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status });

  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? init.body : init.body ? String(init.body) : '';
    // Tchap sign-in
    if (url.href === `https://${SERVER}/.well-known/matrix/client`) return json(200, { 'm.homeserver': { base_url: HS }, 'm.authentication': { issuer: ISSUER } });
    if (url.href === `${ISSUER}/.well-known/openid-configuration`) {
      return json(200, { registration_endpoint: `${ISSUER}/reg`, device_authorization_endpoint: `${ISSUER}/device`, token_endpoint: `${ISSUER}/token` });
    }
    if (url.href === `${ISSUER}/reg`) return json(201, { client_id: 'C' });
    if (url.href === `${ISSUER}/device`) return json(200, { device_code: 'D', user_code: 'CODE-0001', verification_uri: `${ISSUER}/link`, interval: 1, expires_in: 600 });
    if (url.href === `${ISSUER}/token`) return json(200, { access_token: 'A', refresh_token: 'R', expires_in: 1800 });
    // Matrix
    const matrixPath = decodeURIComponent(url.pathname.replace('/_matrix/client/v3', ''));
    if (url.origin === HS) {
      if (matrixPath === '/account/whoami') return json(200, { user_id: OWNER, device_id: 'BRIDGE' });
      if (matrixPath === `/directory/room/#Donna-demo:${SERVER}`) return json(200, { room_id: ROOM });
      if (matrixPath === `/rooms/${ROOM}/joined_members`) return json(200, { joined: { [OWNER]: {} } });
      if (matrixPath === `/rooms/${ROOM}/state/m.room.power_levels/`) return json(200, { users: { [OWNER]: 100 } });
      if (matrixPath === `/rooms/${ROOM}/state/m.room.name/`) return json(200, { name: 'Donna-demo' });
      if (matrixPath.startsWith(`/rooms/${ROOM}/state/`) && method === 'GET') return json(404, { errcode: 'M_NOT_FOUND' });
      if (matrixPath === `/rooms/${ROOM}/state/m.room.join_rules/`) return json(403, { errcode: 'M_FORBIDDEN' });
      if (matrixPath.startsWith(`/rooms/${ROOM}/state/`) || matrixPath.startsWith('/directory/list/room/')) return json(200, {});
      if (matrixPath.startsWith(`/rooms/${ROOM}/send/`)) {
        sent.push(JSON.parse(body) as Record<string, unknown>);
        return json(200, { event_id: `$out${sent.length}` });
      }
      if (matrixPath === '/sync') {
        if (!url.searchParams.get('since')) return json(200, { next_batch: 's0' });
        const events = inbox.splice(0);
        if (events.length === 0) {
          await new Promise((resolve) => setTimeout(resolve, 15));
          return json(200, { next_batch: url.searchParams.get('since') });
        }
        return json(200, { next_batch: `s${Date.now()}`, rooms: { join: { [ROOM]: { timeline: { events } } } } });
      }
    }
    // Manager runtime
    if (url.origin === RUNTIME && url.pathname === '/turn') {
      const turn = JSON.parse(body) as Record<string, unknown>;
      turns.push(turn);
      setTimeout(() => pushEvent?.({ type: 'assistant_message', workspace: 'demo', conversationId: turn.conversationId, payload: { content: 'Le workspace est à jour.' } }), 5);
      return json(202, { accepted: true, kind: 'turn' });
    }
    if (url.origin === RUNTIME && url.pathname === '/events/stream') {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          pushEvent = (event) => controller.enqueue(encoder.encode(`event: agent_event\ndata: ${JSON.stringify(event)}\n\n`));
          init.signal?.addEventListener('abort', () => { try { controller.close(); } catch { /* closed */ } }, { once: true });
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return json(404, {});
  };

  const bridges = new BridgeManager({
    dataDir,
    enabled: true,
    maxAgeMs: 600_000,
    runtime: new RuntimeClient({ baseUrl: RUNTIME, token: 't', fetch: fetchImpl }),
    auth: new TchapAuth({ dataDir, fetch: fetchImpl }),
    fetch: fetchImpl,
    log: () => {},
  });

  const started = await bridges.connect('demo', `#Donna-demo:${SERVER}`);
  assert.equal(started.ok && started.pending && started.userCode, 'CODE-0001');

  const waitFor = async (predicate: () => boolean, label: string) => {
    for (let i = 0; i < 400 && !predicate(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(predicate(), `timed out waiting for ${label}`);
  };
  await waitFor(() => bridges.status('demo').running === true, 'the bridge to start after sign-in');
  assert.equal(bridges.status('demo').bridge, 'awaiting_activation');
  await waitFor(() => sent.some((content) => String(content.body).includes('/activate')), 'the activation prompt');
  assert.ok(sent.every((content) => content[BRIDGE_MARKER] === true));

  const typed = (id: string, text: string) => ({ event_id: id, type: 'm.room.message', sender: OWNER, origin_server_ts: Date.now(), content: { msgtype: 'm.text', body: text } });
  inbox.push(typed('$a', 'bonjour avant activation'));
  inbox.push(typed('$b', '/activate'));
  await waitFor(() => bridges.status('demo').bridge === 'active', 'activation');
  assert.equal(turns.length, 0, 'nothing typed before /activate reached Donna');

  inbox.push(typed('$c', 'où en est le workspace ?'));
  await waitFor(() => sent.some((content) => content.body === 'Le workspace est à jour.'), "Donna's answer in the forum");
  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.input, 'où en est le workspace ?');
  assert.equal(turns[0]?.workspace, 'demo');

  // Detaching the forum stops this workspace only; the shared sign-in stays.
  await bridges.disconnect('demo');
  assert.equal(bridges.status('demo').connected, true);
  assert.equal(bridges.status('demo').forum, undefined);
  assert.equal(bridges.status('demo').running, false);

  // A forum belongs to one workspace: another workspace cannot take it.
  await bridges.connect('demo', `#Donna-demo:${SERVER}`);
  const taken = await bridges.connect('other', `#Donna-demo:${SERVER}`);
  assert.deepEqual(taken, { ok: false, error: 'tchap_room_used_by_workspace:demo' });

  // Signing out stops every bridge but keeps the forums for the next sign-in.
  const signedOut = await bridges.signOut();
  assert.deepEqual(signedOut.stopped, ['demo']);
  assert.equal(bridges.status('demo').connected, false);
  assert.equal(bridges.status('demo').running, false);
  assert.equal(bridges.status('demo').bridge, 'awaiting_activation', 'the forum is kept');
});
