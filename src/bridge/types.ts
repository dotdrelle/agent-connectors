/**
 * The bridge lets one or two people talk to Donna from a messaging app while
 * the workspace runs on their workstation — outbound only: the adapter fetches
 * messages, nothing ever connects to the workstation.
 *
 * The core (`bridge.ts`) speaks to the manager runtime (turns, events,
 * approvals) and owns every rule that does not depend on the messaging app:
 * who may speak, activation, pause, message age, what is relayed. An adapter
 * only moves text in and out of one conversation of one app, and tells the
 * core when someone who should not be there shows up.
 */

export type InboundMessage = {
  /** Provider message id. */
  id: string;
  /** Provider user id of the author. */
  sender: string;
  text: string;
  /** Epoch milliseconds, from the provider. */
  timestamp: number;
};

export type AdapterHandlers = {
  message(message: InboundMessage): void;
  /**
   * The conversation's members changed. `intruders` lists the members who are
   * not allowed; an empty list means the conversation is private again.
   */
  members(state: { intruders: string[] }): void;
  /** A failure the adapter cannot repair on its own (session revoked, room lost). */
  failure(reason: string): void;
};

export interface ChatAdapter {
  start(handlers: AdapterHandlers): Promise<void>;
  /** Send a message; returns its provider id, usable with `edit`. */
  send(text: string): Promise<string>;
  edit(messageId: string, text: string): Promise<void>;
  /**
   * Someone was just allowed: lift a ban the guard may have placed and invite
   * them. Returns what happened, in a sentence for the conversation.
   */
  admit?(userId: string): Promise<string>;
  /** Re-check the members against the allowed list now (after /deny), banning whoever is no longer allowed. */
  recheckMembers?(): Promise<void>;
  stop(): Promise<void>;
}

export type BridgeStatus = 'awaiting_activation' | 'active' | 'paused';

/** What the core persists per workspace, beside the adapter's own secrets. */
export type BridgeState = {
  adapter: string;
  status: BridgeStatus;
  /** The account the bridge runs as; the only one who can activate it or change who may speak. */
  owner: string;
  allowedUsers: string[];
  /** Adapter-specific conversation reference (a Matrix room id for Tchap). */
  room: string;
  roomLabel?: string;
  /** Adapter cursor (Matrix `next_batch`). */
  cursor?: string;
};
