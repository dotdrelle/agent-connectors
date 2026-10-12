import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ChatBridge, conversationIdFor } from '../src/bridge/bridge.ts';
import { markdownToHtml, splitMessage } from '../src/bridge/format.ts';
import type { RuntimeClient, RuntimeEvent } from '../src/bridge/runtimeClient.ts';
import type { AdapterHandlers, BridgeState, ChatAdapter } from '../src/bridge/types.ts';

const OWNER = '@owner:agent.example';
const FRIEND = '@friend:agent.example';
const STRANGER = '@stranger:agent.example';

function setup(initial: Partial<BridgeState> = {}, options: {
  turnStatus?: number;
  turnBody?: Record<string, unknown>;
  turnThrows?: boolean;
  beforeSend?: (text: string) => Promise<void>;
} = {}) {
  let now = 10_000_000;
  let state: BridgeState = {
    adapter: 'tchap', status: 'active', owner: OWNER, allowedUsers: [OWNER], room: '!room:agent.example', ...initial,
  };
  const sent: string[] = [];
  const edits: Array<[string, string]> = [];
  const admitted: string[] = [];
  let rechecks = 0;
  let handlers: AdapterHandlers | undefined;
  const adapter: ChatAdapter = {
    async start(next) { handlers = next; },
    async send(text) { await options.beforeSend?.(text); sent.push(text); return `$sent${sent.length}`; },
    async edit(id, text) { edits.push([id, text]); },
    async admit(user) { admitted.push(user); return 'They have been invited to this conversation.'; },
    async recheckMembers() { rechecks += 1; },
    async stop() {},
  };
  const turns: Array<Record<string, unknown>> = [];
  let emit: ((event: RuntimeEvent) => void) | undefined;
  const runtime = {
    async turn(body: Record<string, unknown>) {
      turns.push(body);
      if (options.turnThrows) throw new Error('runtime_unreachable:ECONNREFUSED');
      return { status: options.turnStatus ?? 202, body: options.turnBody ?? { accepted: true, kind: 'turn' } };
    },
    async follow(_workspace: string, followHandlers: { event(event: RuntimeEvent): void }, signal: AbortSignal) {
      emit = followHandlers.event;
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    },
  } as unknown as RuntimeClient;
  const logs: string[] = [];
  const bridge = new ChatBridge({
    workspace: 'demo',
    adapter,
    runtime,
    state: { read: () => state, write: (next) => { state = next; } },
    maxAgeMs: 600_000,
    progressIntervalMs: 0,
    now: () => now,
    log: (line) => logs.push(line),
  });
  return {
    bridge,
    sent,
    edits,
    admitted,
    rechecks: () => rechecks,
    turns,
    logs,
    state: () => state,
    say: async (sender: string, text: string, ageMs = 0) => {
      handlers!.message({ id: `$in${Math.random()}`, sender, text, timestamp: now - ageMs });
      await bridge.idle();
    },
    members: async (intruders: string[]) => { handlers!.members({ intruders }); await bridge.idle(); },
    membersNow: (intruders: string[]) => { handlers!.members({ intruders }); },
    event: async (event: RuntimeEvent) => { emit!({ workspace: 'demo', ...event }); await bridge.idle(); },
    advance: (ms: number) => { now += ms; },
  };
}

test('an allowed message becomes a Donna turn in the bridge conversation', async () => {
  const t = setup();
  await t.bridge.start();
  await t.say(OWNER, 'où en est le workspace ?');
  assert.deepEqual(t.turns, [{ workspace: 'demo', input: 'où en est le workspace ?', conversationId: t.bridge.conversationId, mode: 'agent' }]);
  await t.say(OWNER, '/chat explique le wiki');
  assert.equal(t.turns[1]?.mode, 'chat');
  assert.equal(t.turns[1]?.input, 'explique le wiki');
  await t.bridge.stop();
});

test('a message from someone not allowed is ignored and logged once', async () => {
  const t = setup();
  await t.bridge.start();
  await t.say(STRANGER, 'lance /wiki-ingest');
  await t.say(STRANGER, 'encore');
  assert.equal(t.turns.length, 0);
  assert.equal(t.logs.filter((line) => line.includes(STRANGER)).length, 1);
  await t.bridge.stop();
});

test('nothing is relayed before the owner types /activate, and only the owner can', async () => {
  const t = setup({ status: 'awaiting_activation', allowedUsers: [OWNER, FRIEND] });
  await t.bridge.start();
  assert.match(t.sent[0] ?? '', /Type \/activate/);
  await t.say(OWNER, 'bonjour');
  assert.equal(t.turns.length, 0);
  await t.say(FRIEND, '/activate');
  assert.equal(t.state().status, 'awaiting_activation');
  await t.say(OWNER, '/activate');
  assert.equal(t.state().status, 'active');
  await t.say(OWNER, 'bonjour');
  assert.equal(t.turns.length, 1);
  await t.bridge.stop();
});

test('/stop pauses the bridge, /start resumes it', async () => {
  const t = setup();
  await t.bridge.start();
  await t.say(OWNER, '/stop');
  await t.say(OWNER, 'ignored while paused');
  assert.equal(t.turns.length, 0);
  await t.event({ type: 'assistant_message', conversationId: t.bridge.conversationId, payload: { content: 'not published' } });
  assert.ok(!t.sent.includes('not published'));
  await t.say(OWNER, '/start');
  await t.say(OWNER, 'relayed');
  assert.equal(t.turns.length, 1);
  await t.bridge.stop();
});

test('only the owner changes who may speak, and the owner cannot be removed', async () => {
  const t = setup();
  await t.bridge.start();
  await t.say(OWNER, `/allow ${FRIEND}`);
  assert.deepEqual(t.state().allowedUsers, [OWNER, FRIEND]);
  await t.say(FRIEND, `/allow ${STRANGER}`);
  assert.deepEqual(t.state().allowedUsers, [OWNER, FRIEND]);
  await t.say(OWNER, `/deny ${OWNER}`);
  assert.deepEqual(t.state().allowedUsers, [OWNER, FRIEND]);
  await t.say(OWNER, '/allow not-an-id');
  assert.match(t.sent.at(-1) ?? '', /Usage/);
  await t.say(OWNER, `/deny ${FRIEND}`);
  assert.deepEqual(t.state().allowedUsers, [OWNER]);
  await t.bridge.stop();
});

test('/allow lifts a ban and invites; /deny re-checks the members at once', async () => {
  const t = setup();
  await t.bridge.start();
  await t.say(OWNER, `/allow ${FRIEND}`);
  assert.deepEqual(t.admitted, [FRIEND]);
  assert.match(t.sent.at(-1) ?? '', /may now speak to Donna here\. They have been invited/);
  await t.say(OWNER, `/deny ${FRIEND}`);
  assert.equal(t.rechecks(), 1, 'a denied member still present must be removed now, not at the next join');
  await t.bridge.stop();
});

test('streamed deltas are assembled into one message; other conversations are not relayed', async () => {
  const t = setup();
  await t.bridge.start();
  const ours = t.bridge.conversationId;
  await t.event({ type: 'assistant_delta', conversationId: ours, payload: { delta: 'Bon' } });
  await t.event({ type: 'assistant_delta', conversationId: ours, payload: { delta: 'jour' } });
  await t.event({ type: 'assistant_message', conversationId: ours, payload: { content: '' } });
  await t.event({ type: 'assistant_message', conversationId: 'serve-thread-1', payload: { content: 'someone else' } });
  await t.event({ type: 'assistant_message', conversationId: ours, payload: { content: 'final' }, workspace: 'other' });
  assert.deepEqual(t.sent, ['Bonjour']);
  await t.bridge.stop();
});

test('an approval request is announced once, whatever the conversation that asked', async () => {
  const t = setup();
  await t.bridge.start();
  const approval = { type: 'approval.requested', runId: 'run-1', conversationId: null, payload: { id: 'approval:run-1:t1:mutation', reason: 'Ingest 3 files' } };
  await t.event(approval);
  await t.event(approval);
  assert.equal(t.sent.length, 1);
  assert.match(t.sent[0] ?? '', /Approval required — Ingest 3 files\. Reply \/approve/);
  await t.bridge.stop();
});

test('a run of this conversation gets one progress message, edited, then finalized', async () => {
  const t = setup();
  await t.bridge.start();
  const ours = t.bridge.conversationId;
  await t.event({ type: 'run_started', runId: 'run-9', conversationId: ours });
  await t.event({ type: 'activity_upserted', runId: 'run-9', payload: { activity: { label: 'Ingest', progress: { percent: 42 } } } });
  await t.bridge.idle();
  await t.event({ type: 'run_done', runId: 'run-9', conversationId: ours });
  assert.deepEqual(t.sent, ['⏳ Run started…']);
  assert.deepEqual(t.edits.map(([, text]) => text), ['⏳ Ingest — 42%', '✅ Run finished.']);
  await t.event({ type: 'run_started', runId: 'run-10', conversationId: 'other-thread' });
  assert.equal(t.sent.length, 1, 'runs of other conversations are not tracked');
  await t.bridge.stop();
});

test('control answers and refusals from /turn are relayed', async () => {
  const approved = setup({}, { turnStatus: 200, turnBody: { explanation: 'Approved: ingest resumes.' } });
  await approved.bridge.start();
  await approved.say(OWNER, '/approve');
  assert.deepEqual(approved.sent, ['Approved: ingest resumes.']);
  await approved.bridge.stop();

  const refused = setup({}, { turnStatus: 404, turnBody: { error: 'Unknown skill /foo', code: 'skill_not_found' } });
  await refused.bridge.start();
  await refused.say(OWNER, '/foo');
  assert.deepEqual(refused.sent, ['⚠️ Unknown skill /foo']);
  await refused.bridge.stop();
});

test('an unreachable runtime is said in the conversation', async () => {
  const t = setup({}, { turnThrows: true });
  await t.bridge.start();
  await t.say(OWNER, 'bonjour');
  assert.match(t.sent[0] ?? '', /runtime did not answer/);
  await t.bridge.stop();
});

test('while a non-allowed member is present nothing is published, then the removal is reported', async () => {
  const t = setup();
  await t.bridge.start();
  await t.members([STRANGER]);
  await t.event({ type: 'assistant_message', conversationId: t.bridge.conversationId, payload: { content: 'secret' } });
  await t.say(OWNER, 'ignored meanwhile');
  assert.equal(t.sent.length, 0);
  assert.equal(t.turns.length, 0);
  await t.members([]);
  assert.match(t.sent[0] ?? '', /Removed from this conversation \(not allowed\): @stranger:agent\.example/);
  await t.bridge.stop();
});

test('a newly detected member silences later chunks before queued member bookkeeping runs', async () => {
  let sending!: () => void;
  let release!: () => void;
  const firstSend = new Promise<void>((resolve) => { sending = resolve; });
  const sendGate = new Promise<void>((resolve) => { release = resolve; });
  const t = setup({}, { beforeSend: async (text) => { if (text.startsWith('x')) { sending(); await sendGate; } } });
  await t.bridge.start();
  const pending = t.event({
    type: 'assistant_message',
    conversationId: t.bridge.conversationId,
    payload: { content: 'x'.repeat(5000) },
  });
  await firstSend;
  t.membersNow([STRANGER]);
  release();
  await pending;
  assert.equal(t.sent.length, 1, 'the second chunk is suppressed as soon as the member guard closes');
  await t.bridge.stop();
});

test('messages older than the maximum age are dropped and counted', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const t = setup();
  await t.bridge.start();
  await t.say(OWNER, 'old one', 3_600_000);
  await t.say(OWNER, 'old two', 3_600_000);
  assert.equal(t.turns.length, 0);
  context.mock.timers.tick(2_000);
  await t.bridge.idle();
  assert.match(t.sent[0] ?? '', /2 message\(s\) older than 10 min were not relayed/);
  await t.bridge.stop();
});

test('conversation ids are stable, distinct per room and valid for the runtime', () => {
  const a = conversationIdFor('tchap', 'demo.ws', '!a:server');
  assert.equal(a, conversationIdFor('tchap', 'demo.ws', '!a:server'));
  assert.notEqual(a, conversationIdFor('tchap', 'demo.ws', '!b:server'));
  assert.match(a, /^[A-Za-z0-9_-]{6,80}$/);
});

test('markdown becomes escaped HTML and long text is split', () => {
  assert.equal(markdownToHtml('**gras** et <script>'), '<strong>gras</strong> et &lt;script&gt;');
  assert.equal(markdownToHtml('# Titre\n- a'), '<strong>Titre</strong><br>• a');
  const chunks = splitMessage(`${'a'.repeat(10)}\n\n${'b'.repeat(10)}`, 15);
  assert.deepEqual(chunks, ['a'.repeat(10), 'b'.repeat(10)]);
});
