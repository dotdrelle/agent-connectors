import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { ChatBridge } from '../bridge/bridge.ts';
import { readJsonFile, removeFile, writeJsonFile } from '../bridge/jsonFile.ts';
import type { RuntimeClient } from '../bridge/runtimeClient.ts';
import type { BridgeState } from '../bridge/types.ts';
import { errorMessage, sleep } from '../bridge/util.ts';
import { TchapAdapter } from './adapter.ts';
import type { DeviceFlow, TchapAuth } from './auth.ts';
import { MatrixClient } from './matrix.ts';
import { listForums, setupRoom, type ForumCandidate, type RoomSetupReport } from './roomSetup.ts';

/**
 * The Tchap side of the bridge: sign-in, forums, and one bridge per workspace
 * (the app-independent rules live in ../bridge/). Set up from the chat through the
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
  /** state.json kept in memory: read once, written through. The bridge reads it on every message. */
  readonly #states = new Map<string, BridgeState | undefined>();
  /** Start/stop of one workspace's bridge run one at a time: two overlapping starts would leave two sync loops. */
  readonly #lifecycle = new Map<string, Promise<unknown>>();
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
    if (!this.#states.has(workspace)) this.#states.set(workspace, readJsonFile<BridgeState>(this.#statePath(workspace)));
    return this.#states.get(workspace);
  }

  #writeState(workspace: string, state: BridgeState): void {
    writeJsonFile(this.#statePath(workspace), state);
    this.#states.set(workspace, state);
  }

  #removeState(workspace: string): void {
    removeFile(this.#statePath(workspace));
    this.#states.set(workspace, undefined);
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

  /** Start every configured bridge, side by side: a slow forum must not hold the others. Failures are said, one per workspace. */
  async bootstrap(): Promise<void> {
    if (!this.#enabled || !this.#auth.readSession()) return;
    await this.#startAll(this.#configuredWorkspaces());
  }

  async #startAll(workspaces: string[]): Promise<void> {
    await Promise.all(workspaces.map((workspace) => this.start(workspace).catch((error) => this.#fail(workspace, error))));
  }

  start(workspace: string): Promise<void> {
    return this.#serialize(workspace, () => this.#start(workspace));
  }

  stop(workspace: string): Promise<void> {
    return this.#serialize(workspace, () => this.#stop(workspace));
  }

  #serialize<T>(workspace: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#lifecycle.get(workspace) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    const settled = next.catch(() => {});
    this.#lifecycle.set(workspace, settled);
    void settled.then(() => { if (this.#lifecycle.get(workspace) === settled) this.#lifecycle.delete(workspace); });
    return next;
  }

  async #start(workspace: string): Promise<void> {
    if (!this.#enabled) throw new Error('bridge_disabled');
    if (!this.#runtime) throw new Error('runtime_not_configured');
    await this.#stop(workspace);
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
    // Registered BEFORE it starts, so a stop arriving meanwhile finds it.
    this.#bridges.set(workspace, bridge);
    try {
      await bridge.start();
    } catch (error) {
      this.#bridges.delete(workspace);
      await bridge.stop().catch(() => {});
      throw error;
    }
    this.#lastError.delete(workspace);
    this.#log(`[${workspace}] bridge started (${state.status}, forum ${state.roomLabel ?? state.room})`);
  }

  async #stop(workspace: string): Promise<void> {
    const bridge = this.#bridges.get(workspace);
    this.#bridges.delete(workspace);
    await bridge?.stop();
  }

  /** Stop every bridge; returns the workspaces that were running. */
  async stopAll(): Promise<string[]> {
    this.#cancelPending();
    const stopped = [...this.#bridges.keys()];
    await Promise.all(stopped.map((workspace) => this.stop(workspace)));
    return stopped;
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
        if (errorMessage(error) !== 'tchap_reauthorization_required') return { ok: false, error: errorMessage(error) };
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
      return { ok: false, error: errorMessage(error) };
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
    this.#removeState(workspace);
    this.#lastError.delete(workspace);
    this.#log(`[${workspace}] forum detached`);
    return { ok: true, hadForum };
  }

  /** Sign out of Tchap for every workspace: bridges stop, the session is revoked; forums are kept for the next sign-in. */
  async signOut(): Promise<{ ok: true; revoked: boolean; reason?: string; stopped: string[] }> {
    const stopped = await this.stopAll();
    const revoked = await this.#auth.revoke();
    this.#accountError = undefined;
    this.#log(`signed out of Tchap (${revoked.revoked ? 'session revoked' : `revocation: ${revoked.reason}`}); stopped: ${stopped.join(', ') || 'none'}`);
    return { ok: true, revoked: revoked.revoked, ...(revoked.reason ? { reason: revoked.reason } : {}), stopped };
  }

  /** The signed-in account's forums a workspace could use, with the workspace already using each one. */
  async forums(): Promise<{ ok: true; forums: Array<ForumCandidate & { usedBy?: string }>; skipped: number } | { ok: false; error: string }> {
    if (!this.#auth.readSession()) return { ok: false, error: 'tchap_not_connected' };
    try {
      const session = await this.#auth.identity();
      const listed = await listForums(this.#client(session.homeserver), session.userId);
      const usedBy = new Map(this.#configuredWorkspaces().map((workspace) => [this.readState(workspace)?.room, workspace]));
      return {
        ok: true,
        forums: listed.forums.map((forum) => {
          const owner = usedBy.get(forum.roomId);
          return owner ? { ...forum, usedBy: owner } : forum;
        }),
        skipped: listed.skipped,
      };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  /**
   * The bridge as both surfaces show it. `phase` is the one reading of the
   * raw fields — the ShellUI line and the Serve card only map it to words, so
   * the two can never interpret a state differently.
   */
  status(workspace: string): Record<string, unknown> {
    const state = this.readState(workspace);
    const session = this.#auth.readSession();
    const pending = this.#pending;
    const waiting = pending?.requests.get(workspace);
    const lastError = this.#lastError.get(workspace) ?? this.#accountError;
    const running = this.#bridges.has(workspace);
    const phase = !this.#enabled ? 'disabled'
      : pending?.error && (waiting || !session) ? 'signin_failed'
        : pending && waiting ? 'signin_pending'
          : !session ? (state || lastError ? 'signed_out' : 'not_set_up')
            : !state ? 'no_forum'
              : !running ? 'stopped'
                : state.status;
    return {
      phase,
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
      running,
      ...(pending && (waiting || pending.error)
        ? {
            pending: pending.error
              ? { error: pending.error }
              : { userCode: pending.flow.userCode, verificationUri: pending.flow.verificationUri, forum: waiting },
          }
        : {}),
      ...(lastError ? { lastError } : {}),
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
        // Unexpected, but not a reason to drop a code the user may be confirming.
        result = { state: 'retry' as const, reason: errorMessage(error) };
      }
      if (result.state === 'pending') continue;
      if (result.state === 'retry') {
        this.#log(`device code poll failed (${result.reason}); polling again`);
        continue;
      }
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
      this.#log(`signed in to Tchap${result.session.userId ? ` as ${result.session.userId}` : ''}`);
      this.#pending = undefined;
      await Promise.all([...pending.requests].map(([workspace, room]) =>
        this.#adopt(workspace, room).catch((error) => this.#fail(workspace, error))));
      // Forums kept from before a sign-out come back with the session.
      await this.#startAll(this.#configuredWorkspaces().filter((workspace) =>
        !pending.requests.has(workspace) && !this.#bridges.has(workspace)));
      return;
    }
  }

  /** Set up the forum with the shared account and (re)start the bridge, awaiting /activate. */
  async #adopt(workspace: string, room: string): Promise<RoomSetupReport> {
    const session = await this.#auth.identity();
    const client = this.#client(session.homeserver);
    const roomId = room.startsWith('!') ? room : await client.resolveAlias(room);
    // One forum, one workspace: this is what keeps workspaces apart on a shared account.
    const owner = this.#configuredWorkspaces().find((other) => other !== workspace && this.readState(other)?.room === roomId);
    if (owner && this.#workspacesRoot && !existsSync(path.join(this.#workspacesRoot, owner))) {
      // The workspace holding it was deleted: release the forum, and say so.
      await this.stop(owner);
      this.#removeState(owner);
      this.#log(`[${owner}] workspace deleted — its forum is released to ${workspace}`);
    } else if (owner) {
      throw new Error(`tchap_room_used_by_workspace:${owner}`);
    }
    const report = await setupRoom(client, { roomId, owner: session.userId });
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
    const stopped = await this.stopAll();
    this.#auth.forget();
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
    const reason = errorMessage(error);
    this.#lastError.set(workspace, reason);
    this.#log(`[${workspace}] bridge not started: ${reason}`);
  }
}
