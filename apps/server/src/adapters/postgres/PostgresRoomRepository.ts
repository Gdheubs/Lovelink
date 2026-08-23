import type { Room, RoomCategory, RoomStatus } from '../../domain/entities/Room.js';
import type { RoomMember, RoomRole } from '../../domain/entities/RoomMember.js';
import type {
  CreateRoomInput,
  RoomListFilter,
  RoomRepository,
} from '../../domain/ports/RoomRepository.js';
import type { RoomId, UserId } from '../../domain/values/ids.js';
import { asRoomId, asUserId } from '../../domain/values/ids.js';
import { ConflictError, NotFoundError } from '../../domain/errors.js';
import { isPgError, PG_ERROR, type Database } from './db.js';

/**
 * ADAPTER: RoomRepository over Postgres, including the durable membership
 * mirror.
 *
 * THE QUERY THAT MATTERS MOST IS `haveSharedRoomSession`
 * ------------------------------------------------------
 * It is the evidence behind the DM rung of the trust ladder, and it is an
 * INTERVAL OVERLAP, not a set intersection. The tempting-but-wrong version is:
 *
 *     SELECT 1 FROM room_members a JOIN room_members b USING (room_id)
 *      WHERE a.user_id = $1 AND b.user_id = $2
 *
 * That returns true for two people who used the same popular room a week apart
 * — which would let anyone unlock DMs with a stranger by visiting a room the
 * stranger once visited. The correct condition compares time ranges:
 *
 *     a.joined_at < COALESCE(b.left_at, 'infinity')
 *     AND b.joined_at < COALESCE(a.left_at, 'infinity')
 *
 * `COALESCE(left_at, 'infinity')` is what makes an OPEN session (someone still
 * in the room) count as extending to now, so two people currently talking
 * qualify immediately rather than only after one of them leaves.
 */
interface RoomRow {
  id: string;
  slug: string;
  title: string;
  category: string;
  host_user_id: string;
  is_scheduled: boolean;
  schedule_cron: string | null;
  max_speakers: number;
  status: string;
  created_at: Date;
  next_occurrence_at: Date | null;
  last_opened_at: Date | null;
  schedule_time_zone: string | null;
}

const ROOM_COLUMNS = `
  id, slug, title, category, host_user_id,
  is_scheduled, schedule_cron, max_speakers, status, created_at,
  next_occurrence_at, last_opened_at, schedule_time_zone
`;

function toRoom(row: RoomRow): Room {
  return {
    id: asRoomId(row.id),
    slug: row.slug,
    title: row.title,
    category: row.category as RoomCategory,
    hostUserId: asUserId(row.host_user_id),
    isScheduled: row.is_scheduled,
    scheduleCron: row.schedule_cron,
    maxSpeakers: row.max_speakers,
    status: row.status as RoomStatus,
    createdAt: row.created_at,
    nextOccurrenceAt: row.next_occurrence_at,
    lastOpenedAt: row.last_opened_at,
    scheduleTimeZone: row.schedule_time_zone,
  };
}

interface MemberRow {
  room_id: string;
  user_id: string;
  role: string;
  joined_at: Date;
  left_at: Date | null;
  muted_by_host: boolean;
}

function toMember(row: MemberRow): RoomMember {
  return {
    roomId: asRoomId(row.room_id),
    userId: asUserId(row.user_id),
    role: row.role as RoomRole,
    joinedAt: row.joined_at,
    leftAt: row.left_at,
    mutedByHost: row.muted_by_host,
  };
}

export class PostgresRoomRepository implements RoomRepository {
  constructor(private readonly db: Database) {}

  async create(input: CreateRoomInput): Promise<Room> {
    try {
      const row = await this.db.queryOne<RoomRow>(
        `INSERT INTO rooms
           (id, slug, title, category, host_user_id, is_scheduled, schedule_cron,
            max_speakers, status, created_at, next_occurrence_at, schedule_time_zone)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING ${ROOM_COLUMNS}`,
        [
          input.id,
          input.slug,
          input.title,
          input.category,
          input.hostUserId,
          input.isScheduled,
          input.scheduleCron,
          input.maxSpeakers,
          input.status,
          input.createdAt,
          input.nextOccurrenceAt ?? null,
          input.scheduleTimeZone ?? null,
        ],
      );
      return toRoom(row!);
    } catch (error) {
      if (isPgError(error, PG_ERROR.UNIQUE_VIOLATION)) {
        // The slug race CreateRoom's probe loop cannot prevent. The unique
        // index is the real guarantee; this is where it becomes a domain error.
        throw new ConflictError('A room with that address already exists.');
      }
      throw error;
    }
  }

  async findById(id: RoomId): Promise<Room | null> {
    const row = await this.db.queryOne<RoomRow>(`SELECT ${ROOM_COLUMNS} FROM rooms WHERE id = $1`, [
      id,
    ]);
    return row === null ? null : toRoom(row);
  }

  async findBySlug(slug: string): Promise<Room | null> {
    const row = await this.db.queryOne<RoomRow>(
      `SELECT ${ROOM_COLUMNS} FROM rooms WHERE slug = $1`,
      [slug],
    );
    return row === null ? null : toRoom(row);
  }

  async list(filter: RoomListFilter): Promise<readonly Room[]> {
    // Static SQL with nullable parameters rather than a dynamically-assembled
    // WHERE clause: one query plan, and no code path that concatenates a
    // caller-supplied value into SQL.
    const rows = await this.db.query<RoomRow>(
      `SELECT ${ROOM_COLUMNS}
         FROM rooms
        WHERE ($1::text IS NULL OR category = $1)
          AND ($2::text IS NULL OR status = $2)
        ORDER BY created_at DESC
        LIMIT $3 OFFSET $4`,
      [filter.category ?? null, filter.status ?? null, filter.limit, filter.offset],
    );
    return rows.map(toRoom);
  }

  async updateStatus(id: RoomId, status: RoomStatus): Promise<void> {
    const rows = await this.db.query(`UPDATE rooms SET status = $2 WHERE id = $1 RETURNING id`, [
      id,
      status,
    ]);
    if (rows.length === 0) throw new NotFoundError('Room');
  }

  // -- membership ----------------------------------------------------------

  /**
   * Idempotent for a member who is already present.
   *
   * The partial unique index `room_members_one_open_session` guarantees at most
   * one open row per (room, user), so this is an upsert TARGETED AT THAT INDEX:
   * a reconnect updates the existing open row instead of opening a second one.
   *
   * `joined_at` is deliberately NOT updated on conflict — the original arrival
   * time is what `haveSharedRoomSession` overlaps, and resetting it on every
   * reconnect would shrink a two-hour conversation to the last thirty seconds.
   */
  async recordJoin(member: Omit<RoomMember, 'leftAt'>): Promise<void> {
    await this.db.query(
      `INSERT INTO room_members (room_id, user_id, role, joined_at, muted_by_host)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (room_id, user_id) WHERE left_at IS NULL
       DO UPDATE SET role = EXCLUDED.role,
                     muted_by_host = EXCLUDED.muted_by_host`,
      [member.roomId, member.userId, member.role, member.joinedAt, member.mutedByHost],
    );
  }

  /**
   * Atomic compare-and-set.
   *
   * The `left_at IS NULL` predicate is the guard and `RETURNING` reports
   * whether this call was the one that closed the session — so two concurrent
   * departures (an explicit leave racing the disconnect handler, say) cannot
   * both come back true and both announce `user:left`.
   */
  async recordLeave(roomId: RoomId, userId: UserId, leftAt: Date): Promise<boolean> {
    const rows = await this.db.query(
      `UPDATE room_members
          SET left_at = $3
        WHERE room_id = $1 AND user_id = $2 AND left_at IS NULL
        RETURNING id`,
      [roomId, userId, leftAt],
    );
    return rows.length > 0;
  }

  async updateRole(roomId: RoomId, userId: UserId, role: RoomRole): Promise<void> {
    await this.db.query(
      `UPDATE room_members SET role = $3
        WHERE room_id = $1 AND user_id = $2 AND left_at IS NULL`,
      [roomId, userId, role],
    );
  }

  async setMutedByHost(roomId: RoomId, userId: UserId, muted: boolean): Promise<void> {
    await this.db.query(
      `UPDATE room_members SET muted_by_host = $3
        WHERE room_id = $1 AND user_id = $2 AND left_at IS NULL`,
      [roomId, userId, muted],
    );
  }

  async findMembership(roomId: RoomId, userId: UserId): Promise<RoomMember | null> {
    const row = await this.db.queryOne<MemberRow>(
      `SELECT room_id, user_id, role, joined_at, left_at, muted_by_host
         FROM room_members
        WHERE room_id = $1 AND user_id = $2 AND left_at IS NULL`,
      [roomId, userId],
    );
    return row === null ? null : toMember(row);
  }

  /**
   * Did these two users overlap in the same room at the same time?
   *
   * See the class comment for why this is an interval overlap rather than a
   * plain join. `EXISTS` with `LIMIT 1` stops at the first match — the answer
   * is a boolean, so counting every shared session would be wasted work on a
   * query that runs on every DM request.
   */
  async haveSharedRoomSession(a: UserId, b: UserId): Promise<boolean> {
    if (a === b) return false;

    const row = await this.db.queryOne<{ shared: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM room_members ma
           JOIN room_members mb
             ON ma.room_id = mb.room_id
          WHERE ma.user_id = $1
            AND mb.user_id = $2
            AND ma.joined_at < COALESCE(mb.left_at, 'infinity'::timestamptz)
            AND mb.joined_at < COALESCE(ma.left_at, 'infinity'::timestamptz)
          LIMIT 1
       ) AS shared`,
      [a, b],
    );

    return row?.shared === true;
  }

  async listHostedBy(userId: UserId, limit: number): Promise<readonly Room[]> {
    const rows = await this.db.query<RoomRow>(
      `SELECT ${ROOM_COLUMNS}
         FROM rooms
        WHERE host_user_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [userId, limit],
    );
    return rows.map(toRoom);
  }

  // -- scheduling ----------------------------------------------------------

  async listDueSchedules(now: Date, limit: number): Promise<readonly Room[]> {
    // Uses `rooms_due_idx`, the partial index over scheduled rooms only —
    // ad-hoc rooms are the overwhelming majority and never belong in it.
    const rows = await this.db.query<RoomRow>(
      `SELECT ${ROOM_COLUMNS} FROM rooms
        WHERE is_scheduled
          AND next_occurrence_at IS NOT NULL
          AND next_occurrence_at <= $1
          AND status <> 'deleted'
        ORDER BY next_occurrence_at ASC
        LIMIT $2`,
      [now, limit],
    );
    return rows.map(toRoom);
  }

  async claimOccurrence(input: {
    roomId: RoomId;
    now: Date;
    nextOccurrenceAt: Date;
    openedAt: Date;
  }): Promise<boolean> {
    // ONE statement, and the WHERE clause is the compare-and-set.
    //
    // "Due, and not already opened for this occurrence." The winner moves
    // `next_occurrence_at` into the future and stamps `last_opened_at`, so the
    // loser of a race fails BOTH halves of the predicate.
    //
    // Deliberately NOT `next_occurrence_at = $expected`: see the port for why
    // timestamp equality strands every room whose occurrence was written by
    // SQL rather than by JavaScript.
    const claimed = await this.db.queryOne<{ id: string }>(
      `UPDATE rooms
          SET next_occurrence_at = $3,
              last_opened_at     = $4,
              status             = 'live'
        WHERE id = $1
          AND is_scheduled
          AND next_occurrence_at IS NOT NULL
          AND next_occurrence_at <= $2
          AND (last_opened_at IS NULL OR last_opened_at < next_occurrence_at)
        RETURNING id`,
      [input.roomId, input.now, input.nextOccurrenceAt, input.openedAt],
    );

    return claimed !== null;
  }

  async disableSchedule(roomId: RoomId): Promise<void> {
    // `schedule_cron` deliberately survives — see the port, and migration 0003
    // for the constraint change that permits it.
    await this.db.query(
      `UPDATE rooms
          SET is_scheduled = false, next_occurrence_at = NULL
        WHERE id = $1`,
      [roomId],
    );
  }
}
