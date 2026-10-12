import { MatrixError, type MatrixClient } from './matrix.ts';

/**
 * Check and close the forum the bridge will use, on behalf of its owner.
 *
 * Measured on agent.dev-durable (2026-10-12): a forum is unencrypted; it can
 * be removed from the directory and its history closed to non-members, but
 * the server refuses `join_rule: invite` on it (403 M_FORBIDDEN). The join
 * rule is still attempted — a server that accepts it gives a truly private
 * room — and the outcome is reported, never assumed.
 *
 * Refusals are deliberate: an encrypted room (this adapter cannot read it), a
 * room the owner does not administer (an attacker's room would receive
 * Donna's answers), a room that already has other members.
 */

export type RoomSetupReport = {
  roomId: string;
  name?: string;
  encrypted: false;
  directory: 'private' | 'unchanged';
  historyVisibility: 'joined';
  inviteOnly: boolean;
  members: string[];
};

export type ForumCandidate = {
  roomId: string;
  alias?: string;
  name?: string;
  members: string[];
};

/**
 * The rooms of the signed-in account a bridge could use: unencrypted and
 * administered by the owner. One state read per room, bounded — an account in
 * hundreds of rooms must not turn a listing into hundreds of calls; what was
 * not looked at is counted, not hidden.
 */
export async function listForums(
  client: MatrixClient,
  owner: string,
  limit = 40,
): Promise<{ forums: ForumCandidate[]; skipped: number }> {
  const rooms = await client.joinedRooms();
  const forums: ForumCandidate[] = [];
  for (const roomId of rooms.slice(0, limit)) {
    let state;
    try {
      state = await client.roomState(roomId);
    } catch {
      continue;
    }
    const content = (type: string) => state.find((event) => event.type === type && (event.state_key ?? '') === '')?.content;
    if (content('m.room.encryption')) continue;
    const users = (content('m.room.power_levels')?.users ?? {}) as Record<string, unknown>;
    if (Number(users[owner] ?? 0) < 100) continue;
    const name = content('m.room.name')?.name;
    const alias = content('m.room.canonical_alias')?.alias;
    const members = state
      .filter((event) => event.type === 'm.room.member' && event.content?.membership === 'join')
      .map((event) => event.state_key ?? event.sender);
    forums.push({
      roomId,
      ...(typeof alias === 'string' ? { alias } : {}),
      ...(typeof name === 'string' ? { name } : {}),
      members,
    });
  }
  return { forums, skipped: Math.max(0, rooms.length - limit) };
}

export async function setupRoom(client: MatrixClient, options: { room: string; owner: string }): Promise<RoomSetupReport> {
  const roomId = options.room.startsWith('!') ? options.room : await client.resolveAlias(options.room);
  let members: string[];
  try {
    members = await client.joinedMembers(roomId);
  } catch (error) {
    if (!(error instanceof MatrixError) || error.status !== 403) throw error;
    await client.joinRoom(roomId);
    members = await client.joinedMembers(roomId);
  }
  if (await client.getState(roomId, 'm.room.encryption')) throw new Error('tchap_room_encrypted');
  const power = await client.getState(roomId, 'm.room.power_levels');
  const users = (power?.users ?? {}) as Record<string, unknown>;
  if (Number(users[options.owner] ?? power?.users_default ?? 0) < 100) throw new Error('tchap_room_not_owned');
  const others = members.filter((user) => user !== options.owner);
  if (others.length > 0) throw new Error(`tchap_room_has_other_members:${others.join(',')}`);

  let directory: RoomSetupReport['directory'] = 'private';
  try {
    await client.setDirectoryVisibility(roomId, 'private');
  } catch {
    directory = 'unchanged';
  }
  try {
    await client.putState(roomId, 'm.room.history_visibility', { history_visibility: 'joined' });
  } catch (error) {
    throw new Error(`tchap_room_history_not_closed:${error instanceof Error ? error.message : String(error)}`);
  }
  let inviteOnly = false;
  try {
    await client.putState(roomId, 'm.room.join_rules', { join_rule: 'invite' });
    inviteOnly = true;
  } catch (error) {
    if (!(error instanceof MatrixError) || error.status !== 403) throw error;
  }
  const nameState = await client.getState(roomId, 'm.room.name');
  return {
    roomId,
    ...(typeof nameState?.name === 'string' ? { name: nameState.name } : {}),
    encrypted: false,
    directory,
    historyVisibility: 'joined',
    inviteOnly,
    members,
  };
}
