import type { Room } from '../../domain/entities/Room.js';
import type { Ports } from '../../domain/ports/index.js';
import type { PresenceEntry } from '../../domain/ports/PresenceStore.js';
import type {
  ChatMessageView,
  RoomMemberView,
  RoomStateView,
} from '../../domain/ports/RealtimeTransport.js';
import type { RoomRole } from '../../domain/entities/RoomMember.js';
import type { UserId } from '../../domain/values/ids.js';
import { toPublicProfile } from '../../domain/entities/User.js';

/**
 * Assembles the `room:state` snapshot.
 *
 * WHY A FULL SNAPSHOT EXISTS AT ALL
 * ---------------------------------
 * Mobile clients disconnect constantly — a tunnel, a locked screen, a network
 * handover — and there is no way for a reconnecting client to know which events
 * it missed. Two designs are possible:
 *
 *   (a) replay a delta log from the client's last-seen cursor, or
 *   (b) throw the client's state away and send a fresh picture.
 *
 * We chose (b). Delta replay requires a durable, ordered, per-client log of
 * every room event, which is a lot of machinery whose failure mode is SILENT:
 * one dropped delta and that client's member list is subtly wrong forever,
 * with nothing to detect it. A snapshot is self-correcting — however wrong the
 * client was, it is right again after this message.
 *
 * The cost is a larger payload on join and reconnect. For a room with tens of
 * members and fifty buffered messages, that is a few kilobytes, which is a
 * trade worth making many times over.
 *
 * WHY IT LIVES IN THE APPLICATION RING
 * ------------------------------------
 * It reads three ports (presence, users, messages) and does no I/O of its own
 * beyond them. The socket edge must not assemble this itself, or the snapshot
 * sent on join and the one sent on reconnect would be built by two pieces of
 * code that can drift.
 */

/** How much recent chat a joiner or reconnecting client receives. */
export const SNAPSHOT_MESSAGE_LIMIT = 50;

export interface RoomStateOptions {
  /** Perspective. Their own role is included; blocked users are filtered out. */
  readonly viewerId: UserId;
}

/**
 * Build the snapshot for one viewer.
 *
 * BLOCKING IS APPLIED HERE, at the projection, rather than at each event. That
 * matters: a user who blocked someone should not see them in the member list
 * OR in the buffered chat, and doing it in one place means a new field cannot
 * accidentally leak a blocked person's presence.
 */
export async function buildRoomState(
  ports: Ports,
  room: Room,
  options: RoomStateOptions,
): Promise<RoomStateView> {
  const presentEntries = await ports.presence.getRoomMembers(room.id);

  // One batch load rather than a query per member: a busy room would otherwise
  // issue fifty round trips to render one snapshot.
  const profiles = await loadProfiles(
    ports,
    presentEntries.map((entry) => entry.userId),
  );

  const blocked = new Set(await ports.relationships.listBlockedIds(options.viewerId));

  const members: RoomMemberView[] = [];
  for (const entry of presentEntries) {
    // Mutual invisibility. The blocked party is simply not in the room as far
    // as this viewer is concerned.
    if (blocked.has(entry.userId)) continue;

    const user = profiles.get(entry.userId);
    if (user === undefined) continue; // deleted mid-session; skip rather than crash

    members.push(toMemberView(entry, user));
  }

  // Stable ordering, so the list does not shuffle on every re-render: host
  // first, then speakers, then listeners, alphabetical within each group.
  members.sort(compareMembers);

  const recentMessages = await loadRecentMessages(ports, room, blocked, profiles);

  const selfEntry = presentEntries.find((entry) => entry.userId === options.viewerId);

  return {
    roomId: room.id,
    title: room.title,
    category: room.category,
    hostUserId: room.hostUserId,
    maxSpeakers: room.maxSpeakers,
    members,
    raisedHands: presentEntries
      .filter((entry) => entry.handRaisedAtMs !== null)
      .sort((a, b) => (a.handRaisedAtMs ?? 0) - (b.handRaisedAtMs ?? 0))
      .map((entry) => entry.userId),
    recentMessages,
    // Falls back to listener: if presence has already lapsed for the viewer,
    // the least-privileged answer is the safe one.
    selfRole: selfEntry?.role ?? 'listener',
  };
}

/**
 * The member view for a single user, used by `user:joined` as well as the
 * snapshot — so the two cannot describe the same person differently.
 */
export async function buildMemberView(
  ports: Ports,
  entry: PresenceEntry,
): Promise<RoomMemberView | null> {
  const [user] = await ports.users.findManyByIds([entry.userId]);
  return user === undefined ? null : toMemberView(entry, toPublicProfile(user));
}

// ---------------------------------------------------------------------------

type Profile = ReturnType<typeof toPublicProfile>;

async function loadProfiles(
  ports: Ports,
  userIds: readonly UserId[],
): Promise<Map<UserId, Profile>> {
  if (userIds.length === 0) return new Map();

  const users = await ports.users.findManyByIds(userIds);
  return new Map(users.map((user) => [user.id, toPublicProfile(user)]));
}

function toMemberView(entry: PresenceEntry, user: Profile): RoomMemberView {
  return {
    user,
    role: entry.role,
    mutedByHost: entry.mutedByHost,
    handRaised: entry.handRaisedAtMs !== null,
  };
}

const ROLE_ORDER: Readonly<Record<RoomRole, number>> = Object.freeze({
  host: 0,
  speaker: 1,
  listener: 2,
});

function compareMembers(a: RoomMemberView, b: RoomMemberView): number {
  const byRole = ROLE_ORDER[a.role] - ROLE_ORDER[b.role];
  if (byRole !== 0) return byRole;
  return a.user.displayName.localeCompare(b.user.displayName);
}

/**
 * The tail of room chat, with blocked senders removed.
 *
 * Senders may have LEFT the room, so their profiles are not in the presence
 * batch — hence the second lookup for any author we do not already have.
 */
async function loadRecentMessages(
  ports: Ports,
  room: Room,
  blocked: ReadonlySet<UserId>,
  known: Map<UserId, Profile>,
): Promise<readonly ChatMessageView[]> {
  const messages = await ports.messages.recentRoomMessages(room.id, SNAPSHOT_MESSAGE_LIMIT);
  if (messages.length === 0) return [];

  const visible = messages.filter((message) => !blocked.has(message.senderId));

  const missing = [
    ...new Set(visible.map((message) => message.senderId).filter((id) => !known.has(id))),
  ];
  if (missing.length > 0) {
    for (const [id, profile] of await loadProfiles(ports, missing)) {
      known.set(id, profile);
    }
  }

  const views: ChatMessageView[] = [];
  for (const message of visible) {
    const from = known.get(message.senderId);
    if (from === undefined) continue;

    views.push({
      id: message.id,
      roomId: message.roomId,
      from,
      text: message.text,
      sentAt: message.sentAt.toISOString(),
    });
  }
  return views;
}
