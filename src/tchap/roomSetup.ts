import { errorMessage } from '../bridge/util.ts';
import { MatrixError, type MatrixClient, type MatrixEvent } from './matrix.ts';

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
  directory: 'private' | 'unchanged';
  inviteOnly: boolean;
  members: string[];
};

export type ForumCandidate = {
  roomId: string;
  alias?: string;
  name?: string;
  members: string[];
};

/** The facts a forum check needs, read from one `/state` answer. */
function describe(state: MatrixEvent[], roomId: string, owner: string) {
  const content = (type: string) => state.find((event) => event.type === type && (event.state_key ?? '') === '')?.content;
  const users = (content('m.room.power_levels')?.users ?? {}) as Record<string, unknown>;
  const name = content('m.room.name')?.name;
  const alias = content('m.room.canonical_alias')?.alias;
  return {
    roomId,
    encrypted: Boolean(content('m.room.encryption')),
    owned: Number(users[owner] ?? content('m.room.power_levels')?.users_default ?? 0) >= 100,
    ...(typeof name === 'string' ? { name } : {}),
    ...(typeof alias === 'string' ? { alias } : {}),
    members: state
      .filter((event) => event.type === 'm.room.member' && event.content?.membership === 'join')
      .map((event) => event.state_key ?? event.sender),
  };
}

const LIST_LIMIT = 40;
const LIST_CONCURRENCY = 6;

/**
 * The rooms of the signed-in account a bridge could use: unencrypted and
 * administered by the owner. One state read per room, a few at a time, and
 * bounded — an account in hundreds of rooms must not turn a listing into
 * hundreds of calls; what was not looked at is counted, not hidden.
 */
export async function listForums(
  client: MatrixClient,
  owner: string,
  limit = LIST_LIMIT,
): Promise<{ forums: ForumCandidate[]; skipped: number }> {
  const rooms = await client.joinedRooms();
  const examined = rooms.slice(0, limit);
  const described: Array<ReturnType<typeof describe> | undefined> = [];
  for (let start = 0; start < examined.length; start += LIST_CONCURRENCY) {
    described.push(...await Promise.all(examined.slice(start, start + LIST_CONCURRENCY).map((roomId) =>
      client.roomState(roomId).then((state) => describe(state, roomId, owner), () => undefined))));
  }
  const forums = described
    .filter((room): room is ReturnType<typeof describe> => Boolean(room && !room.encrypted && room.owned))
    .map(({ roomId, alias, name, members }) => ({ roomId, ...(alias ? { alias } : {}), ...(name ? { name } : {}), members }));
  return { forums, skipped: Math.max(0, rooms.length - limit) };
}

export async function setupRoom(client: MatrixClient, options: { roomId: string; owner: string }): Promise<RoomSetupReport> {
  const { roomId, owner } = options;
  let state: MatrixEvent[];
  try {
    state = await client.roomState(roomId);
  } catch (error) {
    if (!(error instanceof MatrixError) || error.status !== 403) throw error;
    await client.joinRoom(roomId);
    state = await client.roomState(roomId);
  }
  const room = describe(state, roomId, owner);
  if (room.encrypted) throw new Error('tchap_room_encrypted');
  if (!room.owned) throw new Error('tchap_room_not_owned');
  const others = room.members.filter((user) => user !== owner);
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
    throw new Error(`tchap_room_history_not_closed:${errorMessage(error)}`);
  }
  let inviteOnly = false;
  try {
    await client.putState(roomId, 'm.room.join_rules', { join_rule: 'invite' });
    inviteOnly = true;
  } catch (error) {
    if (!(error instanceof MatrixError) || error.status !== 403) throw error;
  }
  return { roomId, ...(room.name ? { name: room.name } : {}), directory, inviteOnly, members: room.members };
}
