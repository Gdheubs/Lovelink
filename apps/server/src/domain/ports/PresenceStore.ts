import type { RoomRole } from '../entities/RoomMember.js';
import type { RoomId, UserId } from '../values/ids.js';

/**
 * PORT: PresenceStore
 *
 * WHY THIS EXISTS
 * ---------------
 * "Who is in this room RIGHT NOW" is a fundamentally different question from
 * "who has ever been in this room", and answering it from Postgres would mean
 * writing a row on every reconnect — which, on mobile, is constant. Live
 * presence is therefore ephemeral, keyed, and TTL'd (Redis in production).
 *
 * THE GHOST PROBLEM
 * -----------------
 * The hard part of presence is not joining, it is leaving: phones lock, tunnels
 * die, and processes get OOM-killed, none of which send a clean `room:leave`.
 * So presence entries EXPIRE unless refreshed by `heartbeat()`, and
 * `reapExpired()` exists to sweep the stragglers and emit the `user:left`
 * events those users never sent for themselves.
 *
 * INVARIANTS
 *  - Every presence write sets or refreshes a TTL. A presence record that
 *    cannot expire is a ghost by construction.
 *  - This store is authoritative for LIVE membership only. Durable history
 *    lives in `room_members` via RoomRepository, and the trust ladder reads
 *    that, not this.
 */

export interface PresenceEntry {
  readonly userId: UserId;
  readonly roomId: RoomId;
  readonly role: RoomRole;
  readonly mutedByHost: boolean;
  /** Millisecond timestamp of the last heartbeat. */
  readonly lastSeenMs: number;
  /** Set when the member has an active hand raised. */
  readonly handRaisedAtMs: number | null;
}

export interface PresenceStore {
  /**
   * Mark a user present in a room. Idempotent: calling twice does not create a
   * duplicate, it refreshes.
   */
  setOnline(entry: Omit<PresenceEntry, 'lastSeenMs' | 'handRaisedAtMs'>): Promise<void>;

  /** Remove a user from a room's live set. Idempotent. */
  setOffline(roomId: RoomId, userId: UserId): Promise<void>;

  /**
   * Refresh the TTL on a user's presence.
   * Returns false when the entry had already expired, which tells the caller to
   * re-join rather than silently resurrect a half-dead session.
   */
  heartbeat(roomId: RoomId, userId: UserId): Promise<boolean>;

  getRoomMembers(roomId: RoomId): Promise<readonly PresenceEntry[]>;

  getMember(roomId: RoomId, userId: UserId): Promise<PresenceEntry | null>;

  /** Cheap count for room lists, without serializing every member. */
  countRoomMembers(roomId: RoomId): Promise<number>;

  /** Every room a user is currently in. Used by ban enforcement and reconnect. */
  getRoomsForUser(userId: UserId): Promise<readonly RoomId[]>;

  updateRole(roomId: RoomId, userId: UserId, role: RoomRole): Promise<void>;

  setMutedByHost(roomId: RoomId, userId: UserId, muted: boolean): Promise<void>;

  /**
   * Raise or lower a hand. Stored in presence rather than Postgres because a
   * raised hand is meaningless once you have left the room.
   */
  setHandRaised(roomId: RoomId, userId: UserId, raised: boolean): Promise<void>;

  /** Hands currently up, oldest first — the queue the host works through. */
  getRaisedHands(roomId: RoomId): Promise<readonly PresenceEntry[]>;

  /**
   * Sweep entries whose heartbeat has lapsed.
   * Returns what was removed so the caller can emit `user:left` for each.
   * Run on an interval by the realtime process.
   */
  reapExpired(): Promise<readonly PresenceEntry[]>;
}
