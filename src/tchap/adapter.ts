import { markdownToHtml } from '../bridge/format.ts';
import { errorMessage, sleep } from '../bridge/util.ts';
import type { AdapterHandlers, ChatAdapter } from '../bridge/types.ts';
import { BRIDGE_MARKER, MatrixError, type MatrixClient, type MatrixEvent } from './matrix.ts';

/**
 * Tchap transport for the bridge: one room, read by `/sync` long polling,
 * written with `m.room.message`. Outbound only.
 *
 * Option A (decided 2026-10-12): the room is an unencrypted Tchap forum,
 * since Tchap encrypts every private room it creates and refuses to turn a
 * forum invite-only. A forum stays joinable by whoever knows its address, so
 * this adapter guards it: any member who is not allowed is banned on sight,
 * and the core publishes nothing while one is present.
 *
 * The bridge posts as its owner's own account (a separate device), so its
 * messages come back through `/sync` from an allowed sender. They carry
 * BRIDGE_MARKER and their ids are remembered: neither is ever read back as a
 * request.
 */

const SYNC_TIMEOUT_MS = 30_000;
const SENT_MEMORY = 200;
/** Inbound ids already handed to the core: a batch replayed after a failed sync is never dispatched twice. */
const SEEN_MEMORY = 500;
/** An idle sync's cursor is persisted at most this often: the position only matters across a restart. */
const CURSOR_PERSIST_MS = 60_000;

export class TchapAdapter implements ChatAdapter {
  readonly #client: MatrixClient;
  readonly #roomId: string;
  readonly #members: () => { owner: string; allowedUsers: string[] };
  readonly #cursor: { read(): string | undefined; write(next: string): void };
  readonly #log: (line: string) => void;
  readonly #abort = new AbortController();
  readonly #sent: string[] = [];
  readonly #seen: string[] = [];
  #handlers: AdapterHandlers | undefined;
  #loop: Promise<void> | undefined;
  /** Sync position, held in memory; written through `#cursor` on activity, at most every minute when idle, and on stop. */
  #position: string | undefined;
  #persisted: string | undefined;
  #persistedAt = 0;

  constructor(options: {
    client: MatrixClient;
    roomId: string;
    members: () => { owner: string; allowedUsers: string[] };
    cursor: { read(): string | undefined; write(next: string): void };
    log?: (line: string) => void;
  }) {
    this.#client = options.client;
    this.#roomId = options.roomId;
    this.#members = options.members;
    this.#cursor = options.cursor;
    this.#log = options.log ?? ((line) => console.log(`agent-connectors tchap: ${line}`));
  }

  async start(handlers: AdapterHandlers): Promise<void> {
    this.#handlers = handlers;
    await this.#guard(await this.#client.joinedMembers(this.#roomId));
    this.#position = this.#persisted = this.#cursor.read();
    if (!this.#position) {
      // First start: take the current position and skip the history — the
      // bridge answers what is said from now on, not what was said before.
      const first = await this.#client.sync({ timeoutMs: 0, filter: this.#filter(0) });
      this.#advance(first.next_batch, true);
    }
    this.#loop = this.#run();
  }

  async stop(): Promise<void> {
    this.#abort.abort();
    await this.#loop?.catch(() => {});
    if (this.#position) this.#advance(this.#position, true);
  }

  #advance(next: string, persist: boolean): void {
    this.#position = next;
    if (next === this.#persisted) return;
    if (!persist && Date.now() - this.#persistedAt < CURSOR_PERSIST_MS) return;
    this.#cursor.write(next);
    this.#persisted = next;
    this.#persistedAt = Date.now();
  }

  async send(text: string): Promise<string> {
    const id = await this.#client.sendMessage(this.#roomId, {
      msgtype: 'm.text',
      body: text,
      format: 'org.matrix.custom.html',
      formatted_body: markdownToHtml(text),
    });
    this.#remember(id);
    return id;
  }

  async edit(messageId: string, text: string): Promise<void> {
    const content = { msgtype: 'm.text', body: text, format: 'org.matrix.custom.html', formatted_body: markdownToHtml(text) };
    const id = await this.#client.sendMessage(this.#roomId, {
      msgtype: 'm.text',
      body: `* ${text}`,
      'm.new_content': content,
      'm.relates_to': { rel_type: 'm.replace', event_id: messageId },
    });
    this.#remember(id);
  }

  async admit(userId: string): Promise<string> {
    const membership = await this.#client.membership(this.#roomId, userId);
    if (membership === 'join') return 'They are already in this conversation.';
    if (membership === 'ban') {
      await this.#client.unban(this.#roomId, userId);
      this.#log(`unbanned ${userId} (now allowed)`);
    }
    if (membership === 'invite') return 'They are already invited.';
    await this.#client.invite(this.#roomId, userId);
    this.#log(`invited ${userId}`);
    return 'They have been invited to this conversation.';
  }

  async recheckMembers(): Promise<void> {
    await this.#guard(await this.#client.joinedMembers(this.#roomId));
  }

  async #run(): Promise<void> {
    let delay = 2_000;
    while (!this.#abort.signal.aborted) {
      try {
        const response = await this.#client.sync({
          since: this.#position,
          timeoutMs: SYNC_TIMEOUT_MS,
          filter: this.#filter(50),
          signal: this.#abort.signal,
        });
        delay = 2_000;
        const room = response.rooms?.join?.[this.#roomId];
        if (response.rooms?.leave && this.#roomId in response.rooms.leave) {
          this.#handlers?.failure('tchap_room_lost');
          return;
        }
        const events = room ? [...(room.state?.events ?? []), ...(room.timeline?.events ?? [])] : [];
        if (events.length > 0) await this.#handle(events);
        this.#advance(response.next_batch, events.length > 0);
      } catch (error) {
        if (this.#abort.signal.aborted) return;
        const message = errorMessage(error);
        if (message === 'tchap_reauthorization_required' || message === 'tchap_not_connected'
          || (error instanceof MatrixError && error.errcode === 'M_UNKNOWN_TOKEN')) {
          this.#handlers?.failure('tchap_reauthorization_required');
          return;
        }
        this.#log(`sync failed (${message}); retrying in ${Math.round(delay / 1000)} s`);
        await sleep(delay, this.#abort.signal);
        delay = Math.min(delay * 2, 60_000);
      }
    }
  }

  async #handle(events: MatrixEvent[]): Promise<void> {
    // Members first: a stranger who joined in this batch must silence the core
    // BEFORE any message of the same batch is relayed and answered. If the
    // check fails, nothing of the batch is dispatched and the sync retries it.
    if (events.some((event) => event.type === 'm.room.member')) {
      await this.#guard(await this.#client.joinedMembers(this.#roomId));
    }
    for (const event of events) {
      if (event.type !== 'm.room.message') continue;
      if (this.#seen.includes(event.event_id)) continue;
      this.#seen.push(event.event_id);
      if (this.#seen.length > SEEN_MEMORY) this.#seen.splice(0, this.#seen.length - SEEN_MEMORY);
      const content = event.content ?? {};
      if (content[BRIDGE_MARKER] === true || this.#sent.includes(event.event_id)) continue;
      const relation = content['m.relates_to'] as Record<string, unknown> | undefined;
      if (relation?.rel_type === 'm.replace') continue; // an edit is not a new request
      if (content.msgtype !== 'm.text' || typeof content.body !== 'string') continue;
      this.#handlers?.message({
        id: event.event_id,
        sender: event.sender,
        text: content.body,
        timestamp: event.origin_server_ts ?? Date.now(),
      });
    }
  }

  /** Ban every member who is not allowed, then report who is still there. */
  async #guard(joined: string[]): Promise<void> {
    const { owner, allowedUsers } = this.#members();
    const allowed = new Set([owner, ...allowedUsers]);
    const intruders = joined.filter((user) => !allowed.has(user));
    this.#handlers?.members({ intruders });
    if (intruders.length === 0) return;
    for (const user of intruders) {
      try {
        await this.#client.ban(this.#roomId, user, 'Not allowed in this wikiLLM Donna conversation.');
        this.#log(`banned ${user} (not allowed)`);
      } catch (error) {
        this.#log(`could not ban ${user}: ${errorMessage(error)} — staying silent while they are present`);
      }
    }
    const remaining = (await this.#client.joinedMembers(this.#roomId)).filter((user) => !allowed.has(user));
    this.#handlers?.members({ intruders: remaining });
  }

  #remember(id: string): void {
    this.#sent.push(id);
    if (this.#sent.length > SENT_MEMORY) this.#sent.splice(0, this.#sent.length - SENT_MEMORY);
  }

  #filter(timelineLimit: number): Record<string, unknown> {
    return {
      presence: { not_types: ['*'] },
      account_data: { not_types: ['*'] },
      room: {
        rooms: [this.#roomId],
        timeline: { limit: timelineLimit, types: ['m.room.message', 'm.room.member'] },
        state: { types: ['m.room.member'] },
        ephemeral: { not_types: ['*'] },
        account_data: { not_types: ['*'] },
      },
    };
  }
}
