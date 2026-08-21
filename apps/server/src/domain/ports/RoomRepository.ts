import type { Room, RoomCategory, RoomStatus } from '../entities/Room.js';
import type { RoomMember, RoomRole } from '../entities/RoomMember.js';
import type { RoomId, UserId } from '../values/ids.js';

/**
 * PORT: RoomRepository
 *
 * WHY THIS SHAPE
 * --------------
 * This port owns BOTH rooms and their durable membership rows, because the two
 * are written together and are meaningless apart. Splitting them into two
 * repositories would put a transaction boundary between "create the room" and
 * "make the creator its host", which is exactly the sort of gap that leaves
 * hostless rooms in production.
 *
 * THE ONE QUERY THAT MATTERS
 * --------------------------
 * `haveSharedRoomSession(a, b)` is the durable evidence behind the DM rung of
 * the trust ladder. It reads history, NOT live presence, so that a Redis flush
 * cannot revoke everyone's messaging rights. It needs an index on
 * (user_id, room_id) to stay cheap — see migration 0002.
 */

export interface CreateRoomInput {
  readonly id: RoomId;
  readonly slug: string;
  readonly title: string;
  readonly category: RoomCategory;
  readonly hostUserId: UserId;
  readonly isScheduled: boolean;
  readonly scheduleCron: string | null;
  readonly maxSpeakers: number;
  readonly status: RoomStatus;
  readonly createdAt: Date;
}

export interface RoomListFilter {
  readonly category?: RoomCategory;
  readonly status?: RoomStatus;
  readonly limit: number;
  readonly offset: number;
}

export interface RoomRepository {
  create(input: CreateRoomInput): Promise<Room>;

  findById(id: RoomId): Promise<Room | null>;

  findBySlug(slug: string): Promise<Room | null>;

  list(filter: RoomListFilter): Promise<readonly Room[]>;

  updateStatus(id: RoomId, status: RoomStatus): Promise<void>;

  // -- durable membership mirror ------------------------------------------

  /**
   * Record that a user joined. Idempotent for an already-present member:
   * re-joining after a reconnect must not create a second open row, or the
   * session history becomes uncountable.
   */
  recordJoin(member: Omit<RoomMember, 'leftAt'>): Promise<void>;

  /**
   * Close the open membership row by setting `leftAt`.
   *
   * @returns true when THIS call closed an open session; false when there was
   *          nothing open to close.
   *
   * WHY IT RETURNS A BOOLEAN: departure runs from several places at once and
   * routinely — an explicit `room:leave`, the socket `disconnect` handler, and
   * the presence reaper can all fire for one person leaving. Exactly one of
   * them should announce `user:left`, or the room watches them depart three
   * times.
   *
   * Making the CLOSE itself report whether it did anything turns that into an
   * atomic compare-and-set (`UPDATE ... WHERE left_at IS NULL RETURNING`)
   * rather than a check-then-act that two concurrent callers can both win.
   */
  recordLeave(roomId: RoomId, userId: UserId, leftAt: Date): Promise<boolean>;

  updateRole(roomId: RoomId, userId: UserId, role: RoomRole): Promise<void>;

  setMutedByHost(roomId: RoomId, userId: UserId, muted: boolean): Promise<void>;

  /** The user's current (open) membership row, or null if not present. */
  findMembership(roomId: RoomId, userId: UserId): Promise<RoomMember | null>;

  /**
   * Durable evidence for the trust ladder: have these two users ever been in
   * the same room at the same time?
   *
   * "At the same time" matters — two people who used the same room on different
   * days have not met, and treating that as a meeting would let anyone unlock
   * DMs by joining a popular room's history.
   */
  haveSharedRoomSession(a: UserId, b: UserId): Promise<boolean>;

  /** Rooms a user hosts. Used by the profile screen and scheduled-room jobs. */
  listHostedBy(userId: UserId, limit: number): Promise<readonly Room[]>;
}
