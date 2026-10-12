import { createHash } from 'node:crypto';

import type { RuntimeClient, RuntimeEvent } from './runtimeClient.ts';
import { splitMessage } from './format.ts';
import { errorMessage } from './util.ts';
import type { AdapterHandlers, BridgeState, ChatAdapter, InboundMessage } from './types.ts';

/**
 * The messaging-app-independent half of the bridge (see types.ts).
 *
 * Rules held here, whatever the app:
 * - only `allowedUsers` are heard; the owner alone activates the bridge and
 *   changes that list, from the conversation itself — never from an MCP call,
 *   so a prompt injection cannot add a listener;
 * - nothing is relayed before the owner types /activate, nor while paused;
 * - nothing at all is published while a non-allowed member is present;
 * - messages older than `maxAgeMs` (sent while the workstation was off) are
 *   dropped, and the bridge says how many;
 * - every message becomes a Donna turn (`/turn`); the runtime decides, the
 *   bridge never interprets a request.
 */

const MXID = /^@[^:\s]+:[^\s]+$/;

const HELP = [
  'Commands:',
  '• any text — a request to Donna (agent mode)',
  '• /chat <question> — read-only question',
  '• /approve — approve what is waiting · /cancel — stop the current run',
  '• /status — workspace status',
  '• /stop — pause the bridge · /start — resume',
  '• /who — who may speak here',
  '• /allow @user:server · /deny @user:server — owner only',
].join('\n');

/** Read on a phone: a very long report (a curation's) is shortened, and says where the rest is. */
const PHONE_MAX = 4_000;
export function forPhone(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= PHONE_MAX) return trimmed;
  const cut = trimmed.slice(0, PHONE_MAX);
  const end = Math.max(cut.lastIndexOf('\n\n'), cut.lastIndexOf('\n'));
  return `${(end > PHONE_MAX / 2 ? cut.slice(0, end) : cut).trimEnd()}\n\n… (shortened for the phone — ${trimmed.length - (end > PHONE_MAX / 2 ? end : PHONE_MAX)} more characters in the wikiLLM chat)`;
}

export function conversationIdFor(adapter: string, workspace: string, room: string): string {
  const hash = createHash('sha256').update(`${adapter}:${room}`).digest('hex').slice(0, 10);
  return `${adapter}-${workspace.replace(/[^A-Za-z0-9_-]/g, '-')}-${hash}`.slice(0, 80);
}

/**
 * One progress message per run, created at the first progress and edited in
 * place — only when it says something new (a new phase, or +5 points), at most
 * once per interval, and never backwards: the runtime's percentage wobbles,
 * and an edit every 5 s filled the forum with ~150 events per run.
 */
type TrackedRun = {
  message?: Promise<string | undefined>;
  lastEdit: number;
  shownPercent: number;
  shownPhase?: string;
  /** Best percentage per activity: never backwards within one, from scratch for the next. */
  bestPercent: Map<string, number>;
  pending?: { text: string; percent: number; phase: string };
  timer?: NodeJS.Timeout;
};

const PROGRESS_STEP = 5;
const LABEL_MAX = 60;

export class ChatBridge {
  readonly workspace: string;
  readonly conversationId: string;
  readonly #adapter: ChatAdapter;
  readonly #runtime: RuntimeClient;
  readonly #state: { read(): BridgeState; write(next: BridgeState): void };
  readonly #maxAgeMs: number;
  readonly #progressIntervalMs: number;
  readonly #log: (line: string) => void;
  readonly #now: () => number;
  readonly #onFailure: (reason: string) => void;
  readonly #abort = new AbortController();
  #queue: Promise<void> = Promise.resolve();
  #intruders: string[] = [];
  #buffer = '';
  readonly #approvalsSeen = new Set<string>();
  readonly #runs = new Map<string, TrackedRun>();
  readonly #ignoredSenders = new Set<string>();
  #stale = 0;
  #staleTimer: NodeJS.Timeout | undefined;
  #runtimeDown = false;

  constructor(options: {
    workspace: string;
    adapter: ChatAdapter;
    runtime: RuntimeClient;
    state: { read(): BridgeState; write(next: BridgeState): void };
    maxAgeMs: number;
    progressIntervalMs?: number;
    log?: (line: string) => void;
    now?: () => number;
    onFailure?: (reason: string) => void;
  }) {
    this.workspace = options.workspace;
    this.#adapter = options.adapter;
    this.#runtime = options.runtime;
    this.#state = options.state;
    this.#maxAgeMs = options.maxAgeMs;
    this.#progressIntervalMs = options.progressIntervalMs ?? 30_000;
    this.#log = options.log ?? ((line) => console.log(`agent-connectors bridge[${options.workspace}]: ${line}`));
    this.#now = options.now ?? Date.now;
    this.#onFailure = options.onFailure ?? (() => {});
    const state = this.#state.read();
    this.conversationId = conversationIdFor(state.adapter, this.workspace, state.room);
  }

  async start(): Promise<void> {
    const handlers: AdapterHandlers = {
      message: (message) => { this.#enqueue(() => this.#onMessage(message)); },
      members: ({ intruders }) => {
        // Close the publication gate before queueing bookkeeping. The queue
        // may be waiting on a slow /turn or Tchap request; an intruder must
        // silence runtime output immediately when the adapter detects them.
        const before = this.#intruders;
        this.#intruders = intruders;
        this.#enqueue(() => this.#onMembers(intruders, before));
      },
      failure: (reason) => {
        this.#log(`adapter failure: ${reason}`);
        this.#onFailure(reason);
      },
    };
    await this.#adapter.start(handlers);
    void this.#runtime.follow(this.workspace, {
      event: (event) => { this.#enqueue(() => this.#onEvent(event)); },
      status: (state, detail) => {
        if (state === 'disconnected' && !this.#runtimeDown) {
          this.#runtimeDown = true;
          this.#log(`runtime event stream lost (${detail ?? 'unknown'}); retrying`);
        } else if (state === 'connected' && this.#runtimeDown) {
          this.#runtimeDown = false;
          this.#log('runtime event stream restored');
        }
      },
    }, this.#abort.signal);
    if (this.#state.read().status === 'awaiting_activation') {
      await this.#publish(
        `wikiLLM — Donna can be reached here for workspace "${this.workspace}". ` +
          'Type /activate to switch the bridge on (owner only). Nothing is relayed until then.',
        { force: true },
      );
    }
  }

  async stop(): Promise<void> {
    this.#abort.abort();
    clearTimeout(this.#staleTimer);
    for (const run of this.#runs.values()) clearTimeout(run.timer);
    await this.#adapter.stop();
  }

  /** Inbound messages and runtime events are handled one at a time, in arrival order. */
  #enqueue(task: () => Promise<void>): void {
    this.#queue = this.#queue.then(task).catch((error) => {
      this.#log(`handler error: ${errorMessage(error)}`);
    });
  }

  /** Wait for everything queued so far (tests). */
  async idle(): Promise<void> {
    await this.#queue;
  }

  async #onMessage(message: InboundMessage): Promise<void> {
    const state = this.#state.read();
    if (!state.allowedUsers.includes(message.sender)) {
      if (!this.#ignoredSenders.has(message.sender)) {
        this.#ignoredSenders.add(message.sender);
        this.#log(`ignored a message from ${message.sender} (not allowed)`);
      }
      return;
    }
    if (this.#intruders.length > 0) return;
    if (this.#now() - message.timestamp > this.#maxAgeMs) {
      this.#stale += 1;
      clearTimeout(this.#staleTimer);
      this.#staleTimer = setTimeout(() => this.#enqueue(() => this.#reportStale()), 2_000);
      return;
    }
    const text = message.text.trim();
    if (!text) return;
    if (await this.#command(text, message.sender, state)) return;
    if (state.status !== 'active') return;
    const chat = /^\/chat\s+/i.exec(text);
    await this.#forward(chat ? text.slice(chat[0].length) : text, chat ? 'chat' : 'agent');
  }

  /** Bridge commands; returns true when the text was one. */
  async #command(text: string, sender: string, state: BridgeState): Promise<boolean> {
    const [rawVerb = '', ...rest] = text.split(/\s+/);
    const verb = rawVerb.toLowerCase();
    const isOwner = sender === state.owner;
    const reply = async (line: string) => { await this.#publish(line, { force: true }); return true; };
    switch (verb) {
      case '/activate':
      case '/activer':
        if (!isOwner) return reply('Only the owner of this bridge can activate it.');
        if (state.status === 'active') return reply('The bridge is already active.');
        this.#state.write({ ...state, status: 'active' });
        return reply(`Bridge active. Messages here now reach Donna (workspace "${this.workspace}"). /help lists the commands.`);
      case '/stop':
      case '/pause':
        if (state.status === 'awaiting_activation') return false;
        this.#state.write({ ...state, status: 'paused' });
        return reply('Bridge paused — nothing is relayed. /start resumes.');
      case '/start':
      case '/reprendre':
        if (state.status === 'awaiting_activation') return reply('The owner must type /activate first.');
        this.#state.write({ ...state, status: 'active' });
        return reply('Bridge resumed.');
      case '/help':
      case '/aide':
        return reply(HELP);
      case '/who':
      case '/membres':
        return reply(`Allowed here: ${state.allowedUsers.join(', ')} (owner: ${state.owner}).`);
      case '/allow':
      case '/autoriser':
      case '/deny':
      case '/retirer': {
        if (!isOwner) return reply('Only the owner can change who may speak here.');
        const target = rest[0] ?? '';
        if (!MXID.test(target)) return reply(`Usage: ${verb} @user:server`);
        const adding = verb === '/allow' || verb === '/autoriser';
        if (!adding && target === state.owner) return reply('The owner cannot be removed.');
        const allowedUsers = adding
          ? [...new Set([...state.allowedUsers, target])]
          : state.allowedUsers.filter((user) => user !== target);
        this.#state.write({ ...state, allowedUsers });
        this.#log(`${adding ? 'allowed' : 'removed'} ${target}`);
        if (adding) {
          // The guard may already have banned them (they joined before being
          // allowed): an invite to a banned user is refused, so lift it first.
          let admitted = 'Invite them to this conversation.';
          try {
            admitted = (await this.#adapter.admit?.(target)) ?? admitted;
          } catch (error) {
            admitted = `They could not be invited (${errorMessage(error)}) — invite them from Tchap.`;
          }
          return reply(`${target} may now speak to Donna here. ${admitted}`);
        }
        // Removing someone still present must take effect now: no membership
        // event will come to trigger the guard, and publishing would go on.
        await reply(`${target} is no longer heard here.`);
        try {
          await this.#adapter.recheckMembers?.();
        } catch (error) {
          this.#log(`member re-check after /deny failed: ${errorMessage(error)}`);
        }
        return true;
      }
      default:
        return false;
    }
  }

  async #forward(input: string, mode: 'agent' | 'chat'): Promise<void> {
    let result;
    try {
      const state = this.#state.read();
      result = await this.#runtime.turn({
        workspace: this.workspace,
        input,
        conversationId: this.conversationId,
        mode,
        // Tells Donna her replies are posted to this thread and read on a phone.
        context: { channel: { kind: state.adapter, ...(state.roomLabel ? { label: state.roomLabel } : {}) } },
      });
    } catch (error) {
      this.#log(`turn not delivered: ${errorMessage(error)}`);
      await this.#publish('⚠️ The workspace runtime did not answer — is wikiLLM running on the workstation? Your message was not delivered.');
      return;
    }
    const body = result.body;
    if (result.status === 202 && body.kind === 'turn') return; // the answer arrives as events
    const said = typeof body.explanation === 'string' ? body.explanation
      : typeof body.message === 'string' ? body.message
        : '';
    if (result.status >= 400) {
      await this.#publish(`⚠️ ${said || (typeof body.error === 'string' ? body.error : `request refused (${result.status})`)}`);
      return;
    }
    if (said) await this.#publish(said);
  }

  async #onEvent(event: RuntimeEvent): Promise<void> {
    if (event.workspace && event.workspace !== this.workspace) return;
    const ours = event.conversationId === this.conversationId;
    const payload = event.payload ?? {};
    switch (event.type) {
      case 'assistant_delta':
        if (ours) this.#buffer += String(payload.delta ?? '');
        return;
      case 'assistant_delta_reset':
        if (ours) this.#buffer = '';
        return;
      case 'assistant_message': {
        if (!ours) return;
        const text = String(payload.content ?? '') || this.#buffer;
        this.#buffer = '';
        if (text.trim()) await this.#publish(forPhone(text));
        return;
      }
      case 'approval.requested': {
        // Workspace-level: an approval asked from another surface can be given from here too.
        const id = String(payload.id ?? `${event.runId ?? ''}:${String(payload.taskId ?? '')}`);
        if (this.#approvalsSeen.has(id)) return;
        this.#approvalsSeen.add(id);
        const said = typeof payload.reason === 'string' ? payload.reason.trim().replace(/[.!…\s]+$/u, '') : '';
        const reason = said ? ` — ${said}` : '';
        await this.#publish(`⏸ Approval required${reason}. Reply /approve to run it, or /cancel to stop the run.`);
        return;
      }
      case 'run_started':
        // No message yet: an approval request often follows at once, and the
        // first progress creates the run's message.
        if (ours && event.runId) this.#runs.set(event.runId, { lastEdit: 0, shownPercent: -1, bestPercent: new Map() });
        return;
      case 'activity_upserted':
        if (event.runId && this.#runs.has(event.runId)) this.#progress(event.runId, payload.activity as Record<string, unknown> | undefined);
        return;
      case 'run_done':
      case 'run_error':
      case 'run_cancelled':
        if (event.runId && this.#runs.has(event.runId)) await this.#finishRun(event.runId, event.type, payload);
        return;
      default:
        return;
    }
  }

  #progress(runId: string, activity: Record<string, unknown> | undefined): void {
    const run = this.#runs.get(runId);
    if (!run || !activity) return;
    const progress = (activity.progress ?? {}) as Record<string, unknown>;
    const key = String(activity.id ?? activity.key ?? 'run');
    const best = Math.max(run.bestPercent.get(key) ?? 0, typeof progress.percent === 'number' ? Math.round(progress.percent) : 0);
    run.bestPercent.set(key, best);
    const raw = String(progress.label ?? activity.label ?? 'working').replace(/\s+/g, ' ').trim();
    const label = raw.length > LABEL_MAX ? `${raw.slice(0, LABEL_MAX - 1)}…` : raw;
    // A new activity is a new phase too: its percentage starts afresh.
    const phase = `${key}:${label.split(' ')[0]?.toLowerCase() ?? ''}`;
    const percent = best;
    const news = run.message === undefined || phase !== run.shownPhase || percent - run.shownPercent >= PROGRESS_STEP;
    if (!news) return;
    run.pending = { text: `⏳ ${label}${typeof progress.percent === 'number' ? ` — ${percent}%` : ''}`, percent, phase };
    const wait = run.message === undefined ? 0 : run.lastEdit + this.#progressIntervalMs - this.#now();
    if (wait <= 0) {
      this.#enqueue(() => this.#flushProgress(runId));
    } else if (!run.timer) {
      run.timer = setTimeout(() => {
        run.timer = undefined;
        this.#enqueue(() => this.#flushProgress(runId));
      }, wait);
    }
  }

  async #flushProgress(runId: string): Promise<void> {
    const run = this.#runs.get(runId);
    if (!run?.pending) return;
    const { text, percent, phase } = run.pending;
    run.pending = undefined;
    run.lastEdit = this.#now();
    run.shownPercent = percent;
    run.shownPhase = phase;
    if (run.message === undefined) {
      run.message = this.#publish(text);
      await run.message;
      return;
    }
    await this.#editRun(run, text);
  }

  async #finishRun(runId: string, type: string, payload: Record<string, unknown>): Promise<void> {
    const run = this.#runs.get(runId);
    if (!run) return;
    clearTimeout(run.timer);
    this.#runs.delete(runId);
    const text = type === 'run_done'
      ? '✅ Run finished.'
      : type === 'run_cancelled'
        ? '⏹ Run cancelled.'
        : `❌ Run failed${typeof payload.message === 'string' ? `: ${payload.message}` : '.'}`;
    if (run.message === undefined) await this.#publish(text);
    else await this.#editRun(run, text);
  }

  async #editRun(run: TrackedRun, text: string): Promise<void> {
    const id = await run.message;
    if (!id || this.#silenced(false)) return;
    try {
      await this.#adapter.edit(id, text);
    } catch (error) {
      this.#log(`progress edit failed: ${errorMessage(error)}`);
    }
  }

  async #onMembers(intruders: string[], before: string[]): Promise<void> {
    if (intruders.length > 0 && before.length === 0) {
      this.#log(`non-allowed member(s) present: ${intruders.join(', ')} — publishing suspended`);
    } else if (intruders.length === 0 && before.length > 0) {
      this.#log('conversation private again — publishing resumed');
      await this.#publish(`⚠️ Removed from this conversation (not allowed): ${before.join(', ')}. Nothing was published while they were present.`, { force: true });
    }
  }

  async #reportStale(): Promise<void> {
    const count = this.#stale;
    this.#stale = 0;
    if (count === 0) return;
    const minutes = Math.round(this.#maxAgeMs / 60_000);
    this.#log(`dropped ${count} message(s) older than ${minutes} min`);
    await this.#publish(`⚠️ ${count} message(s) older than ${minutes} min were not relayed (sent while the workstation was off). Send them again if still needed.`, { force: true });
  }

  #silenced(force: boolean): boolean {
    if (this.#intruders.length > 0) return true;
    return !force && this.#state.read().status !== 'active';
  }

  async #publish(text: string, options: { force?: boolean } = {}): Promise<string | undefined> {
    if (this.#silenced(options.force === true)) return undefined;
    let first: string | undefined;
    for (const chunk of splitMessage(text)) {
      // Membership can change while a previous chunk is being sent.
      if (this.#silenced(options.force === true)) return first;
      try {
        const id = await this.#adapter.send(chunk);
        first ??= id;
      } catch (error) {
        this.#log(`send failed: ${errorMessage(error)}`);
        return first;
      }
    }
    return first;
  }
}
