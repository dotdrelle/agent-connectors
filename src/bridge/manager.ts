import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { TchapAdapter } from '../tchap/adapter.ts';
import type { DeviceFlow, TchapAuth } from '../tchap/auth.ts';
import { MatrixClient } from '../tchap/matrix.ts';
import { listForums, setupRoom, type ForumCandidate, type RoomSetupReport } from '../tchap/roomSetup.ts';
import { ChatBridge } from './bridge.ts';
import { readJsonFile, removeFile, writeJsonFile } from './jsonFile.ts';
import type { RuntimeClient } from './runtimeClient.ts';
import type { BridgeState } from './types.ts';

/**
 * One bridge per workspace, set up from the chat through the
 * `connectors_tchap_*` tools — no `.env` edit, no restart.
 *
 * Like CME's Confluence credentials, the Tchap sign-in is AGENT-WIDE: one
 * device code, one session (`<dataDir>/tchap-session.json`), one client
 * registration (`<dataDir>/tchap-clients.json`). Workspaces stay apart by
 * their FORUM: each one has its own `<dataDir>/<workspace>/tchap/state.json`
 * (forum, allowed users, status, cursor), a forum belongs to one workspace
 * only, each bridge syncs its forum alone and sends turns for its workspace
 * alone. Bridges that were running start again at boot.
 */

type Pending = {
  flow: DeviceFlow;
  /** Workspaces waiting for this sign-in, with the forum each asked for. */
  requests: Map<string, string>;
  /** Aborted by a sign-out or shutdown: the poll loop must not outlive its request. */
  abort: AbortController;
  error?: string;
};

export type ConnectResult =
  | { ok: true; pending: true; verificationUri: string; verificationUriComplete?: string; userCode: string; expiresInSeconds: number }
  | { ok: true; pending: false; report: RoomSetupReport }
  | { ok: false; error: string };

const ROOM_REF = /^[#!][^:\s]+:([a-z0-9.-]+)$/i;

export class BridgeManager {
  readonly #dataDir: string;
  readonly #workspacesRoot: string | undefined;
  readonly #enabled: boolean;
  readonly #maxAgeMs: number;
  readonly #runtime: RuntimeClient | undefined;
  readonly #auth: TchapAuth;
  readonly #fetch: typeof fetch | undefined;
  readonly #log: (line: string) => void;
  readonly #bridges = new Map<string, ChatBridge>();
  readonly #lastError = new Map<string, string>();
  #pending: Pending | undefined;
  #accountError: string | undefined;

  constructor(options: {
    dataDir: string;
    /** When given, a bridge whose workspace folder is gone is not started (deleted workspace). */
    workspacesRoot?: string;
    enabled: boolean;
    maxAgeMs: number;
    runtime?: RuntimeClient;
    auth: TchapAuth;
    fetch?: typeof fetch;
    log?: (line: string) => void;
  }) {
    this.#dataDir = options.dataDir;
    this.#workspacesRoot = options.workspacesRoot;
    this.#enabled = options.enabled;
    this.#maxAgeMs = options.maxAgeMs;
    this.#runtime = options.runtime;
    this.#auth = options.auth;
    this.#fetch = options.fetch;
    this.#log = options.log ?? ((line) => console.log(`agent-connectors bridge: ${line}`));
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  #statePath(workspace: string): string {
    return path.join(this.#dataDir, workspace, 'tchap', 'state.json');
  }

  readState(workspace: string): BridgeState | undefined {
    return readJsonFile<BridgeState>(this.#statePath(workspace));
  }

  #writeState(workspace: string, state: BridgeState): void {
    writeJsonFile(this.#statePath(workspace), state);
  }

  /** Every workspace that has a forum, whether its bridge runs or not. */
  #configuredWorkspaces(): string[] {
    try {
      return readdirSync(this.#dataDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && this.readState(entry.name))
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  }

  /** Start every configured bridge. Failures are said, one per workspace. */
  async bootstrap(): Promise<void> {
    if (!this.#enabled || !this.#auth.readSession()) return;
    for (const workspace of this.#configuredWorkspaces()) {
      await this.start(workspace).catch((error) => this.#fail(workspace, error));
    }
  }

  async start(workspace: string): Promise<void> {
    if (!this.#enabled) throw new Error('bridge_disabled');
    if (!this.#runtime) throw new Error('runtime_not_configured');
    await this.stop(workspace);
    const state = this.readState(workspace);
    const session = this.#auth.readSession();
    if (!session) throw new Error('tchap_not_connected');
    if (!state) throw new Error('tchap_no_forum');
    // A deleted workspace keeps its forum file in the agent's volume (like
    // Gmail tokens); its bridge must not come back and relay into nothing.
    if (this.#workspacesRoot && !existsSync(path.join(this.#workspacesRoot, workspace))) throw new Error('workspace_missing');
    const adapter = new TchapAdapter({
      client: this.#client(session.homeserver),
      roomId: state.room,
      members: () => {
        const current = this.readState(workspace) ?? state;
        return { owner: current.owner, allowedUsers: current.allowedUsers };
      },
      cursor: {
        read: () => this.readState(workspace)?.cursor,
        write: (cursor) => {
          const current = this.readState(workspace);
          if (current) this.#writeState(workspace, { ...current, cursor });
        },
      },
      log: (line) => this.#log(`[${workspace}] ${line}`),
    });
    const bridge = new ChatBridge({
      workspace,
      adapter,
      runtime: this.#runtime,
      state: {
        read: () => this.readState(workspace) ?? state,
        write: (next) => this.#writeState(workspace, next),
      },
      maxAgeMs: this.#maxAgeMs,
      onFailure: (reason) => { void this.#onBridgeFailure(workspace, reason); },
    });
    await bridge.start();
    this.#bridges.set(workspace, bridge);
    this.#lastError.delete(workspace);
    this.#log(`[${workspace}] bridge started (${state.status}, forum ${state.roomLabel ?? state.room})`);
  }

  async stop(workspace: string): Promise<void> {
    const bridge = this.#bridges.get(workspace);
    this.#bridges.delete(workspace);
    await bridge?.stop();
  }

  async stopAll(): Promise<void> {
    this.#cancelPending();
    await Promise.all([...this.#bridges.keys()].map((workspace) => this.stop(workspace)));
  }

  /**
   * Attach a forum to a workspace. Signed in already: the forum is set up now,
   * no code. Not signed in: a device code is returned (shared by every
   * workspace asking meanwhile) and the forum is set up once it is confirmed.
   */
  async connect(workspace: string, room: string): Promise<ConnectResult> {
    if (!this.#enabled) return { ok: false, error: 'bridge_disabled' };
    if (!this.#runtime) return { ok: false, error: 'runtime_not_configured' };
    const trimmed = room.trim();
    const server = ROOM_REF.exec(trimmed)?.[1];
    if (!server) return { ok: false, error: 'tchap_room_invalid' };
    const session = this.#auth.readSession();
    if (session && session.server !== server) return { ok: false, error: `tchap_other_server:${session.server}` };
    if (session) {
      try {
        return { ok: true, pending: false, report: await this.#adopt(workspace, trimmed) };
      } catch (error) {
        // An ended session is repaired by signing in again, not reported as a
        // dead end: forget it and fall through to a new device code.
        if (message(error) !== 'tchap_reauthorization_required') return { ok: false, error: message(error) };
        await this.#endSession('tchap_reauthorization_required');
      }
    }
    if (this.#pending && !this.#pending.error && this.#pending.flow.server === server && this.#pending.flow.expiresAt > Date.now()) {
      this.#pending.requests.set(workspace, trimmed);
      return this.#pendingResult(this.#pending.flow);
    }
    let flow: DeviceFlow;
    try {
      flow = await this.#auth.startDeviceFlow(server);
    } catch (error) {
      return { ok: false, error: message(error) };
    }
    this.#cancelPending();
    const pending: Pending = { flow, requests: new Map([[workspace, trimmed]]), abort: new AbortController() };
    this.#pending = pending;
    void this.#waitForApproval(pending);
    return this.#pendingResult(flow);
  }

  /** Detach this workspace's forum. The shared Tchap sign-in and the other workspaces are untouched. */
  async disconnect(workspace: string): Promise<{ ok: true; hadForum: boolean }> {
    this.#pending?.requests.delete(workspace);
    // Nobody waits for the sign-in any more: stop polling for it.
    if (this.#pending && this.#pending.requests.size === 0) this.#cancelPending();
    await this.stop(workspace);
    const hadForum = Boolean(this.readState(workspace));
    removeFile(this.#statePath(workspace));
    this.#lastError.delete(workspace);
    this.#log(`[${workspace}] forum detached`);
    return { ok: true, hadForum };
  }

  /** Sign out of Tchap for every workspace: bridges stop, the session is revoked; forums are kept for the next sign-in. */
  async signOut(): Promise<{ ok: true; revoked: boolean; reason?: string; stopped: string[] }> {
    this.#cancelPending();
    const stopped = [...this.#bridges.keys()];
    await Promise.all(stopped.map((workspace) => this.stop(workspace)));
    const revoked = await this.#auth.revoke();
    this.#accountError = undefined;
    this.#log(`signed out of Tchap (${revoked.revoked ? 'session revoked' : `revocation: ${revoked.reason}`}); stopped: ${stopped.join(', ') || 'none'}`);
    return { ok: true, revoked: revoked.revoked, ...(revoked.reason ? { reason: revoked.reason } : {}), stopped };
  }

  /** The signed-in account's forums a workspace could use, with the workspace already using each one. */
  async forums(): Promise<{ ok: true; forums: Array<ForumCandidate & { usedBy?: string }>; skipped: number } | { ok: false; error: string }> {
    const session = this.#auth.readSession();
    if (!session) return { ok: false, error: 'tchap_not_connected' };
    try {
      const listed = await listForums(this.#client(session.homeserver), session.userId);
      const usedBy = new Map(this.#configuredWorkspaces().map((workspace) => [this.readState(workspace)?.room, workspace]));
      return {
        ok: true,
        forums: listed.forums.map((forum) => ({ ...forum, ...(usedBy.get(forum.roomId) ? { usedBy: usedBy.get(forum.roomId) } : {}) })),
        skipped: listed.skipped,
      };
    } catch (error) {
      return { ok: false, error: message(error) };
    }
  }

  status(workspace: string): Record<string, unknown> {
    const state = this.readState(workspace);
    const session = this.#auth.readSession();
    const pending = this.#pending;
    const waiting = pending?.requests.get(workspace);
    return {
      enabled: this.#enabled,
      runtimeConfigured: Boolean(this.#runtime),
      // The account is shared by every workspace; the forum is this workspace's own.
      connected: Boolean(session),
      ...(session ? { account: session.userId, device: session.deviceId, server: session.server } : {}),
      ...(state
        ? {
            forum: state.roomLabel ?? state.room,
            roomId: state.room,
            bridge: state.status,
            owner: state.owner,
            allowedUsers: state.allowedUsers,
          }
        : {}),
      running: this.#bridges.has(workspace),
      ...(pending && (waiting || pending.error)
        ? {
            pending: pending.error
              ? { error: pending.error }
              : { userCode: pending.flow.userCode, verificationUri: pending.flow.verificationUri, forum: waiting },
          }
        : {}),
      ...(this.#lastError.get(workspace) ?? this.#accountError
        ? { lastError: this.#lastError.get(workspace) ?? this.#accountError }
        : {}),
    };
  }

  async #waitForApproval(pending: Pending): Promise<void> {
    let interval = pending.flow.intervalSeconds * 1000;
    while (this.#pending === pending) {
      await sleep(interval, pending.abort.signal);
      if (pending.abort.signal.aborted || this.#pending !== pending) return;
      let result;
      try {
        result = await this.#auth.pollDeviceFlow(pending.flow);
      } catch (error) {
        pending.error = message(error);
        this.#log(`device code poll failed: ${pending.error}`);
        return;
      }
      if (result.state === 'pending') continue;
      if (result.state === 'slow_down') {
        interval += 5_000;
        continue;
      }
      if (result.state === 'failed') {
        pending.error = result.reason;
        this.#log(`Tchap sign-in failed: ${result.reason}`);
        return;
      }
      this.#accountError = undefined;
      this.#log(`signed in to Tchap as ${result.session.userId}`);
      this.#pending = undefined;
      for (const [workspace, room] of pending.requests) {
        await this.#adopt(workspace, room).catch((error) => this.#fail(workspace, error));
      }
      // Forums kept from before a sign-out come back with the session.
      for (const workspace of this.#configuredWorkspaces()) {
        if (!pending.requests.has(workspace) && !this.#bridges.has(workspace)) {
          await this.start(workspace).catch((error) => this.#fail(workspace, error));
        }
      }
      return;
    }
  }

  /** Set up the forum with the shared account and (re)start the bridge, awaiting /activate. */
  async #adopt(workspace: string, room: string): Promise<RoomSetupReport> {
    const session = this.#auth.readSession();
    if (!session) throw new Error('tchap_not_connected');
    const client = this.#client(session.homeserver);
    const roomId = room.startsWith('!') ? room : await client.resolveAlias(room);
    // One forum, one workspace: this is what keeps workspaces apart on a shared account.
    const owner = this.#configuredWorkspaces().find((other) => other !== workspace && this.readState(other)?.room === roomId);
    if (owner && this.#workspacesRoot && !existsSync(path.join(this.#workspacesRoot, owner))) {
      // The workspace holding it was deleted: release the forum, and say so.
      await this.stop(owner);
      removeFile(this.#statePath(owner));
      this.#log(`[${owner}] workspace deleted — its forum is released to ${workspace}`);
    } else if (owner) {
      throw new Error(`tchap_room_used_by_workspace:${owner}`);
    }
    const report = await setupRoom(client, { room: roomId, owner: session.userId });
    const previous = this.readState(workspace);
    const sameRoom = previous?.room === report.roomId;
    this.#writeState(workspace, {
      adapter: 'tchap',
      status: 'awaiting_activation',
      owner: session.userId,
      allowedUsers: sameRoom && previous ? previous.allowedUsers : [session.userId],
      room: report.roomId,
      roomLabel: report.name ? `${report.name} (${room})` : room,
    });
    await this.start(workspace);
    return report;
  }

  /** A failure of one bridge; an ended session concerns them all. */
  async #onBridgeFailure(workspace: string, reason: string): Promise<void> {
    this.#lastError.set(workspace, reason);
    if (reason === 'tchap_reauthorization_required') {
      await this.#endSession(reason);
      return;
    }
    await this.stop(workspace);
  }

  async #endSession(reason: string): Promise<void> {
    const stopped = [...this.#bridges.keys()];
    await Promise.all(stopped.map((workspace) => this.stop(workspace)));
    removeFile(this.#auth.sessionPath());
    this.#accountError = reason;
    this.#log(`Tchap session ended (${reason}); stopped: ${stopped.join(', ') || 'none'} — a new sign-in restarts them`);
  }

  #pendingResult(flow: DeviceFlow): ConnectResult {
    return {
      ok: true,
      pending: true,
      verificationUri: flow.verificationUri,
      ...(flow.verificationUriComplete ? { verificationUriComplete: flow.verificationUriComplete } : {}),
      userCode: flow.userCode,
      expiresInSeconds: Math.max(0, Math.round((flow.expiresAt - Date.now()) / 1000)),
    };
  }

  #cancelPending(): void {
    this.#pending?.abort.abort();
    this.#pending = undefined;
  }

  #client(homeserver: string): MatrixClient {
    return new MatrixClient({
      homeserver,
      token: (force) => this.#auth.accessToken({ force }),
      ...(this.#fetch ? { fetch: this.#fetch } : {}),
    });
  }

  #fail(workspace: string, error: unknown): void {
    const reason = message(error);
    this.#lastError.set(workspace, reason);
    this.#log(`[${workspace}] bridge not started: ${reason}`);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
