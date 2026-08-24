import type { Room, RoomCategory, RoomStatus } from '../entities/Room.js';
import type { RoomTemperature } from '../values/roomTemperature.js';
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
  /** Required when `isScheduled`; the DB CHECK refuses a schedule without one. */
  readonly nextOccurrenceAt?: Date | null;
  readonly scheduleTimeZone?: string | null;
  /** Defaults to `warm` — the least demanding thing to walk into. */
  readonly temperature?: RoomTemperature;
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

  // -- scheduling (phase 6) ------------------------------------------------

  /**
   * Scheduled rooms whose next occurrence has arrived.
   *
   * Returns rooms that are DUE, not rooms that have been opened. Deciding what
   * to do with them — and claiming them — is the caller's job, because the
   * decision involves the domain's cron arithmetic and the claim has to be
   * atomic.
   */
  listDueSchedules(now: Date, limit: number): Promise<readonly Room[]>;

  /**
   * Atomically claim one occurrence and book the next.
   *
   * WHY THIS IS ONE METHOD AND NOT read-then-write
   * ----------------------------------------------
   * Two servers running the scheduler — during a rolling deploy, say — will
   * both see the same room as due within the same second. If claiming were a
   * separate write, both would open it, and the room would be announced twice
   * to everyone watching.
   *
   * WHAT THE CONDITION IS, AND WHY IT IS NOT TIMESTAMP EQUALITY
   * ------------------------------------------------------------
   * The obvious key is "claim it if `next_occurrence_at` is still the value I
   * read". It is also wrong, and wrong in a way that hides itself: Postgres
   * TIMESTAMPTZ keeps MICROSECONDS and a JavaScript Date keeps milliseconds, so
   * any value that originated in SQL — `now()`, a backfill, a manual edit, a
   * restore — comes back as `.949` against a stored `.949147` and the equality
   * never matches. The sweep then reports the room as claimed by another
   * server, which is a lie, and the room is stranded forever with nothing
   * logged as an error.
   *
   * So the condition says what is actually meant: claim it if it is DUE and has
   * not already been opened FOR THIS OCCURRENCE. That is precision-independent,
   * and it is still a compare-and-set — the winner moves the occurrence
   * forward and stamps `last_opened_at`, so the loser finds it neither due nor
   * unopened.
   *
   * @returns true if THIS caller claimed it.
   */
  claimOccurrence(input: {
    roomId: RoomId;
    /** The sweep's notion of now. The room must be due against this. */
    now: Date;
    /** When it should open next. Always a real date; see `disableSchedule`. */
    nextOccurrenceAt: Date;
    openedAt: Date;
  }): Promise<boolean>;

  /**
   * Stop a schedule that can never fire again.
   *
   * SEPARATE FROM `claimOccurrence` because it is a different intent, and
   * folding it in (as a null occurrence) meant one method that sometimes opened
   * a room and sometimes switched it off — with `status = 'live'` applied in
   * both cases, so a broken room was advertised as running.
   *
   * The room is NOT deleted and `schedule_cron` is NOT cleared: the host's
   * intent stays on the row so a human can see what was asked for and that it
   * is no longer happening. Only `is_scheduled` and `next_occurrence_at` change,
   * which is exactly what takes it out of the sweep. See migration 0003.
   */
  disableSchedule(roomId: RoomId): Promise<void>;
}
