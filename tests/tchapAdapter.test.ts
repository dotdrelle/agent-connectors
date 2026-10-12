import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { InboundMessage } from '../src/bridge/types.ts';
import { TchapAdapter } from '../src/tchap/adapter.ts';
import { BRIDGE_MARKER, MatrixClient, type MatrixEvent } from '../src/tchap/matrix.ts';
import { setupRoom } from '../src/tchap/roomSetup.ts';

const HS = 'https://matrix.agent.example';
const ROOM = '!room:agent.example';
const OWNER = '@owner:agent.example';
const STRANGER = '@stranger:agent.example';

type Call = { method: string; path: string; body?: Record<string, unknown> };

/** A fake homeserver: scripted /sync batches, room state, members, bans. */
function fakeHomeserver(options: {
  members?: string[];
  state?: Record<string, Record<string, unknown> | undefined>;
  syncBatches?: MatrixEvent[][];
  forbidJoinRule?: boolean;
  firstTokenRejected?: boolean;
} = {}) {
  const calls: Call[] = [];
  let members = [...(options.members ?? [OWNER])];
  const batches = [...(options.syncBatches ?? [])];
  let batch = 0;
  let rejectNext = options.firstTokenRejected ?? false;
  const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status });
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const path = decodeURIComponent(url.pathname.replace('/_matrix/client/v3', ''));
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ method, path, ...(body ? { body } : {}) });
    if (rejectNext) {
      rejectNext = false;
      return json(401, { errcode: 'M_UNKNOWN_TOKEN' });
    }
    if (path === '/directory/room/#forum:agent.example') return json(200, { room_id: ROOM });
    if (path === `/rooms/${ROOM}/joined_members`) return json(200, { joined: Object.fromEntries(members.map((user) => [user, {}])) });
    if (path === `/rooms/${ROOM}/state` && method === 'GET') {
      return json(200, [
        ...Object.entries(options.state ?? {}).filter(([, content]) => content).map(([type, content]) => ({ type, state_key: '', content })),
        ...members.map((user) => ({ type: 'm.room.member', state_key: user, sender: user, content: { membership: 'join' } })),
      ]);
    }
    if (path.startsWith(`/rooms/${ROOM}/state/`)) {
      const type = path.split('/')[4] ?? '';
      if (method === 'PUT') {
        if (type === 'm.room.join_rules' && options.forbidJoinRule) return json(403, { errcode: 'M_FORBIDDEN' });
        return json(200, { event_id: '$state' });
      }
      const content = options.state?.[type];
      return content ? json(200, content) : json(404, { errcode: 'M_NOT_FOUND' });
    }
    if (path === `/directory/list/room/${ROOM}`) return json(200, {});
    if (path === `/rooms/${ROOM}/ban`) {
      members = members.filter((user) => user !== body?.user_id);
      return json(200, {});
    }
    if (path.startsWith(`/rooms/${ROOM}/send/m.room.message/`)) return json(200, { event_id: `$out${calls.length}` });
    if (path === `/rooms/${ROOM}/unban` || path === `/rooms/${ROOM}/invite`) return json(200, {});
    if (path === '/sync') {
      if (!url.searchParams.get('since')) return json(200, { next_batch: 'b0' });
      const events = batches.shift();
      if (!events) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return json(200, { next_batch: `b${batch}` });
      }
      batch += 1;
      if (events.some((event) => event.type === 'm.room.member' && event.content?.membership === 'join')) {
        members = [...new Set([...members, ...events.filter((event) => event.type === 'm.room.member').map((event) => event.state_key ?? event.sender)])];
      }
      return json(200, { next_batch: `b${batch}`, rooms: { join: { [ROOM]: { timeline: { events } } } } });
    }
    return json(404, { errcode: 'M_UNRECOGNIZED' });
  };
  return { fetchImpl, calls };
}

function client(fetchImpl: typeof fetch, tokens: string[] = []) {
  return new MatrixClient({
    homeserver: HS,
    token: async (force) => { tokens.push(force ? 'forced' : 'normal'); return force ? 'renewed' : 'current'; },
    fetch: fetchImpl,
  });
}

function message(id: string, sender: string, body: string, extra: Record<string, unknown> = {}): MatrixEvent {
  return { event_id: id, type: 'm.room.message', sender, origin_server_ts: Date.now(), content: { msgtype: 'm.text', body, ...extra } };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !predicate(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
}

test('room setup closes an unencrypted forum the owner administers and reports a refused join rule', async () => {
  const server = fakeHomeserver({
    state: { 'm.room.power_levels': { users: { [OWNER]: 100 } }, 'm.room.name': { name: 'Donna-demo' } },
    forbidJoinRule: true,
  });
  const report = await setupRoom(client(server.fetchImpl), { roomId: ROOM, owner: OWNER });
  assert.deepEqual(report, { roomId: ROOM, name: 'Donna-demo', directory: 'private', inviteOnly: false, members: [OWNER] });
  assert.ok(server.calls.some((call) => call.method === 'PUT' && call.path.endsWith('m.room.history_visibility/') && call.body?.history_visibility === 'joined'));
});

test('room setup refuses an encrypted room, a room the owner does not own, a room with other members', async () => {
  const encrypted = fakeHomeserver({ state: { 'm.room.encryption': { algorithm: 'm.megolm.v1.aes-sha2' }, 'm.room.power_levels': { users: { [OWNER]: 100 } } } });
  await assert.rejects(setupRoom(client(encrypted.fetchImpl), { roomId: ROOM, owner: OWNER }), /tchap_room_encrypted/);

  const foreign = fakeHomeserver({ state: { 'm.room.power_levels': { users: { '@attacker:x': 100 } } } });
  await assert.rejects(setupRoom(client(foreign.fetchImpl), { roomId: ROOM, owner: OWNER }), /tchap_room_not_owned/);

  const crowded = fakeHomeserver({ members: [OWNER, STRANGER], state: { 'm.room.power_levels': { users: { [OWNER]: 100 } } } });
  await assert.rejects(setupRoom(client(crowded.fetchImpl), { roomId: ROOM, owner: OWNER }), /tchap_room_has_other_members:@stranger/);
});

test('a refused token is renewed once and the request retried', async () => {
  const server = fakeHomeserver({ firstTokenRejected: true });
  const tokens: string[] = [];
  assert.deepEqual(await client(server.fetchImpl, tokens).joinedMembers(ROOM), [OWNER]);
  assert.deepEqual(tokens, ['normal', 'forced']);
});

test('the adapter relays user messages only: not its own echoes, not edits, not notices', async () => {
  const server = fakeHomeserver({
    syncBatches: [[
      message('$1', OWNER, 'bonjour Donna'),
      message('$2', OWNER, 'echo of the bridge', { [BRIDGE_MARKER]: true }),
      message('$3', OWNER, '* edited', { 'm.relates_to': { rel_type: 'm.replace', event_id: '$1' } }),
      { event_id: '$4', type: 'm.room.message', sender: OWNER, content: { msgtype: 'm.notice', body: 'notice' } },
    ]],
  });
  let cursor: string | undefined;
  const received: InboundMessage[] = [];
  const adapter = new TchapAdapter({
    client: client(server.fetchImpl),
    roomId: ROOM,
    members: () => ({ owner: OWNER, allowedUsers: [OWNER] }),
    cursor: { read: () => cursor, write: (next) => { cursor = next; } },
    log: () => {},
  });
  await adapter.start({ message: (m) => received.push(m), members: () => {}, failure: () => {} });
  await until(() => received.length > 0 && cursor === 'b1');
  await adapter.stop();
  assert.deepEqual(received.map((m) => m.text), ['bonjour Donna']);
  assert.equal(cursor, 'b1', 'the cursor advances past the handled batch');
});

test('a member who is not allowed is banned on sight and reported until gone', async () => {
  const server = fakeHomeserver({
    syncBatches: [[{ event_id: '$m', type: 'm.room.member', sender: STRANGER, state_key: STRANGER, content: { membership: 'join' } }]],
  });
  let cursor: string | undefined;
  const reports: string[][] = [];
  const adapter = new TchapAdapter({
    client: client(server.fetchImpl),
    roomId: ROOM,
    members: () => ({ owner: OWNER, allowedUsers: [OWNER] }),
    cursor: { read: () => cursor, write: (next) => { cursor = next; } },
    log: () => {},
  });
  await adapter.start({ message: () => {}, members: ({ intruders }) => reports.push(intruders), failure: () => {} });
  await until(() => reports.length >= 3);
  await adapter.stop();
  assert.deepEqual(reports, [[], [STRANGER], []]);
  assert.ok(server.calls.some((call) => call.path === `/rooms/${ROOM}/ban` && call.body?.user_id === STRANGER));
});

test('sent messages carry the marker, HTML, and edits use m.replace', async () => {
  const server = fakeHomeserver();
  let cursor: string | undefined = 'b0';
  const adapter = new TchapAdapter({
    client: client(server.fetchImpl),
    roomId: ROOM,
    members: () => ({ owner: OWNER, allowedUsers: [OWNER] }),
    cursor: { read: () => cursor, write: (next) => { cursor = next; } },
    log: () => {},
  });
  await adapter.start({ message: () => {}, members: () => {}, failure: () => {} });
  const id = await adapter.send('**ok**');
  await adapter.edit(id, 'done');
  await adapter.stop();
  const sends = server.calls.filter((call) => call.path.includes('/send/m.room.message/'));
  assert.equal(sends[0]?.body?.[BRIDGE_MARKER], true);
  assert.equal(sends[0]?.body?.formatted_body, '<strong>ok</strong>');
  assert.deepEqual(sends[1]?.body?.['m.relates_to'], { rel_type: 'm.replace', event_id: id });
  assert.equal(sends[1]?.body?.[BRIDGE_MARKER], true);
});

test('listForums keeps the unencrypted rooms the owner administers, with their members', async () => {
  const rooms: Record<string, unknown[]> = {
    '!usable:x': [
      { type: 'm.room.power_levels', state_key: '', content: { users: { [OWNER]: 100 } } },
      { type: 'm.room.name', state_key: '', content: { name: 'Donna-demo' } },
      { type: 'm.room.canonical_alias', state_key: '', content: { alias: '#Donna-demo:x' } },
      { type: 'm.room.member', state_key: OWNER, sender: OWNER, content: { membership: 'join' } },
    ],
    '!encrypted:x': [
      { type: 'm.room.power_levels', state_key: '', content: { users: { [OWNER]: 100 } } },
      { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
    ],
    '!foreign:x': [{ type: 'm.room.power_levels', state_key: '', content: { users: { '@else:x': 100 } } }],
  };
  const fetchImpl: typeof fetch = async (input) => {
    const path = decodeURIComponent(new URL(String(input)).pathname.replace('/_matrix/client/v3', ''));
    if (path === '/joined_rooms') return new Response(JSON.stringify({ joined_rooms: Object.keys(rooms) }));
    const room = /^\/rooms\/(.+)\/state$/.exec(path)?.[1];
    return new Response(JSON.stringify(room ? rooms[room] : {}), { status: room ? 200 : 404 });
  };
  const { listForums } = await import('../src/tchap/roomSetup.ts');
  const listed = await listForums(client(fetchImpl), OWNER);
  assert.deepEqual(listed, { forums: [{ roomId: '!usable:x', alias: '#Donna-demo:x', name: 'Donna-demo', members: [OWNER] }], skipped: 0 });
});


test('in one batch, a stranger joining is handled before the messages of that batch', async () => {
  const server = fakeHomeserver({
    syncBatches: [[
      { event_id: '$j', type: 'm.room.member', sender: STRANGER, state_key: STRANGER, content: { membership: 'join' } },
      message('$q', OWNER, '/approve'),
    ]],
  });
  let cursor: string | undefined;
  const order: string[] = [];
  const adapter = new TchapAdapter({
    client: client(server.fetchImpl),
    roomId: ROOM,
    members: () => ({ owner: OWNER, allowedUsers: [OWNER] }),
    cursor: { read: () => cursor, write: (next) => { cursor = next; } },
    log: () => {},
  });
  await adapter.start({
    message: (m) => order.push(`message:${m.text}`),
    members: ({ intruders }) => order.push(`members:${intruders.join(',')}`),
    failure: () => {},
  });
  await until(() => order.some((entry) => entry.startsWith('message:')));
  await adapter.stop();
  assert.deepEqual(order, ['members:', `members:${STRANGER}`, 'members:', 'message:/approve']);
});

test('a batch replayed after a failed sync never dispatches the same message twice', async () => {
  const repeated = message('$dup', OWNER, 'lance /wiki-ingest');
  const server = fakeHomeserver({ syncBatches: [[repeated], [repeated]] });
  let cursor: string | undefined;
  const received: string[] = [];
  const adapter = new TchapAdapter({
    client: client(server.fetchImpl),
    roomId: ROOM,
    members: () => ({ owner: OWNER, allowedUsers: [OWNER] }),
    cursor: { read: () => cursor, write: (next) => { cursor = next; } },
    log: () => {},
  });
  await adapter.start({ message: (m) => received.push(m.id), members: () => {}, failure: () => {} });
  await until(() => cursor === 'b2');
  await adapter.stop();
  assert.deepEqual(received, ['$dup']);
});

test('admit lifts a ban before inviting', async () => {
  const server = fakeHomeserver({ state: { 'm.room.member': { membership: 'ban' } } });
  let cursor: string | undefined = 'b0';
  const adapter = new TchapAdapter({
    client: client(server.fetchImpl),
    roomId: ROOM,
    members: () => ({ owner: OWNER, allowedUsers: [OWNER, STRANGER] }),
    cursor: { read: () => cursor, write: (next) => { cursor = next; } },
    log: () => {},
  });
  assert.match(await adapter.admit(STRANGER), /invited/);
  const paths = server.calls.map((call) => `${call.method} ${call.path}`);
  assert.ok(paths.indexOf(`POST /rooms/${ROOM}/unban`) >= 0);
  assert.ok(paths.indexOf(`POST /rooms/${ROOM}/unban`) < paths.indexOf(`POST /rooms/${ROOM}/invite`));
});
