import type { Ban } from '../../domain/entities/Ban.js';
import type { Report, ReportCategory, ReportStatus } from '../../domain/entities/Report.js';
import type {
  CreateBanInput,
  CreateReportInput,
  ReportRepository,
  ResolveReportInput,
} from '../../domain/ports/ReportRepository.js';
import type { ReportId, UserId } from '../../domain/values/ids.js';
import { asReportId, asRoomId, asUserId } from '../../domain/values/ids.js';
import { NotFoundError } from '../../domain/errors.js';
import type { Database } from './db.js';

/**
 * ADAPTER: reports and bans over Postgres.
 *
 * THE QUEUE ORDERING IS EXPRESSED IN SQL, AND THAT IS DELIBERATE
 * --------------------------------------------------------------
 * `listQueue` orders urgent categories first, then oldest first — the same rule
 * as `compareForQueue` in the domain. It is done in the query rather than by
 * loading and sorting in Node because a backlog of five thousand reports must
 * not be pulled into memory to find the top twenty.
 *
 * The CASE expression here matches the one in `reports_queue_idx` (migration
 * 0001) exactly. If they drift, the index stops being used and nobody notices
 * until the queue is slow. The integration test asserts this ordering agrees
 * with the domain's comparator.
 *
 * NOTHING HERE DELETES. Reports are permanent (patterns across dismissed ones
 * are themselves signal) and bans are permanent (lifting sets `lifted_at`).
 * The port offers no delete method and neither does this.
 */
interface ReportRow {
  id: string;
  reporter_id: string;
  target_id: string;
  room_id: string | null;
  category: string;
  note: string;
  audio_ref: string | null;
  status: string;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  resolution: string | null;
  created_at: Date;
}

const REPORT_COLUMNS = `
  id, reporter_id, target_id, room_id, category, note, audio_ref,
  status, reviewed_by, reviewed_at, resolution, created_at
`;

/** Must match `reports_queue_idx` in migration 0001, or the index goes unused. */
const URGENCY_RANK = `(CASE WHEN category IN ('minor_safety', 'self_harm') THEN 0 ELSE 1 END)`;

function toReport(row: ReportRow): Report {
  return {
    id: asReportId(row.id),
    reporterId: asUserId(row.reporter_id),
    targetId: asUserId(row.target_id),
    roomId: row.room_id === null ? null : asRoomId(row.room_id),
    category: row.category as ReportCategory,
    note: row.note,
    audioRef: row.audio_ref,
    status: row.status as ReportStatus,
    reviewedBy: row.reviewed_by === null ? null : asUserId(row.reviewed_by),
    reviewedAt: row.reviewed_at,
    resolution: row.resolution,
    createdAt: row.created_at,
  };
}

interface BanRow {
  user_id: string;
  reason: string;
  expires_at: Date | null;
  issued_by: string | null;
  issued_at: Date;
  lifted_at: Date | null;
}

function toBan(row: BanRow): Ban {
  return {
    userId: asUserId(row.user_id),
    reason: row.reason,
    expiresAt: row.expires_at,
    issuedBy: row.issued_by === null ? null : asUserId(row.issued_by),
    issuedAt: row.issued_at,
    liftedAt: row.lifted_at,
  };
}

const BAN_COLUMNS = `user_id, reason, expires_at, issued_by, issued_at, lifted_at`;

export class PostgresReportRepository implements ReportRepository {
  constructor(private readonly db: Database) {}

  async create(input: CreateReportInput): Promise<Report> {
    const row = await this.db.queryOne<ReportRow>(
      `INSERT INTO reports (id, reporter_id, target_id, room_id, category, note, audio_ref, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${REPORT_COLUMNS}`,
      [
        input.id,
        input.reporterId,
        input.targetId,
        input.roomId,
        input.category,
        input.note,
        input.audioRef,
        input.createdAt,
      ],
    );
    return toReport(row!);
  }

  async findById(id: ReportId): Promise<Report | null> {
    const row = await this.db.queryOne<ReportRow>(
      `SELECT ${REPORT_COLUMNS} FROM reports WHERE id = $1`,
      [id],
    );
    return row === null ? null : toReport(row);
  }

  async listQueue(status: ReportStatus, limit: number, offset: number): Promise<readonly Report[]> {
    const rows = await this.db.query<ReportRow>(
      `SELECT ${REPORT_COLUMNS}
         FROM reports
        WHERE status = $1
        ORDER BY ${URGENCY_RANK}, created_at
        LIMIT $2 OFFSET $3`,
      [status, limit, offset],
    );
    return rows.map(toReport);
  }

  async listOpenByReporterAgainst(
    reporterId: UserId,
    targetId: UserId,
  ): Promise<readonly Report[]> {
    const rows = await this.db.query<ReportRow>(
      `SELECT ${REPORT_COLUMNS}
         FROM reports
        WHERE reporter_id = $1 AND target_id = $2 AND status IN ('open', 'reviewing')`,
      [reporterId, targetId],
    );
    return rows.map(toReport);
  }

  async listAgainst(targetId: UserId, limit: number): Promise<readonly Report[]> {
    const rows = await this.db.query<ReportRow>(
      `SELECT ${REPORT_COLUMNS}
         FROM reports
        WHERE target_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [targetId, limit],
    );
    return rows.map(toReport);
  }

  /**
   * Claim a report for review.
   *
   * The `status = 'open'` guard makes this a compare-and-set: two moderators
   * opening the same report at the same moment cannot both claim it, so the
   * second sees it is already being handled rather than duplicating the work.
   */
  async claimForReview(id: ReportId, moderatorId: UserId, at: Date): Promise<Report> {
    const row = await this.db.queryOne<ReportRow>(
      `UPDATE reports
          SET status = 'reviewing', reviewed_by = $2, reviewed_at = $3
        WHERE id = $1 AND status = 'open'
        RETURNING ${REPORT_COLUMNS}`,
      [id, moderatorId, at],
    );

    if (row === null) {
      // Either it does not exist or someone else already has it. Re-read so the
      // caller gets the real state rather than a bare failure.
      const existing = await this.findById(id);
      if (existing === null) throw new NotFoundError('Report');
      return existing;
    }
    return toReport(row);
  }

  async resolve(input: ResolveReportInput): Promise<Report> {
    const row = await this.db.queryOne<ReportRow>(
      `UPDATE reports
          SET status = $2, reviewed_by = $3, reviewed_at = $4, resolution = $5
        WHERE id = $1 AND status IN ('open', 'reviewing')
        RETURNING ${REPORT_COLUMNS}`,
      [input.id, input.status, input.reviewedBy, input.reviewedAt, input.resolution],
    );

    if (row === null) throw new NotFoundError('An open report');
    return toReport(row);
  }

  async countByStatus(status: ReportStatus): Promise<number> {
    const row = await this.db.queryOne<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM reports WHERE status = $1`,
      [status],
    );
    return row?.count ?? 0;
  }

  // -- bans ----------------------------------------------------------------

  async createBan(input: CreateBanInput): Promise<Ban> {
    const row = await this.db.queryOne<BanRow>(
      `INSERT INTO bans (id, user_id, reason, expires_at, issued_by, issued_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)
       RETURNING ${BAN_COLUMNS}`,
      [input.userId, input.reason, input.expiresAt, input.issuedBy, input.issuedAt],
    );
    return toBan(row!);
  }

  async listBans(userId: UserId): Promise<readonly Ban[]> {
    const rows = await this.db.query<BanRow>(
      `SELECT ${BAN_COLUMNS} FROM bans WHERE user_id = $1 ORDER BY issued_at DESC`,
      [userId],
    );
    return rows.map(toBan);
  }

  /**
   * The currently-in-force ban.
   *
   * HOT PATH: called on every socket connect. The partial index
   * `bans_active_idx (user_id, expires_at) WHERE lifted_at IS NULL` is what
   * keeps it cheap, and the ORDER BY puts a permanent ban ahead of a temporary
   * one so the notice shown to the user is the truthful one.
   */
  async findActiveBan(userId: UserId, now: Date): Promise<Ban | null> {
    const row = await this.db.queryOne<BanRow>(
      `SELECT ${BAN_COLUMNS}
         FROM bans
        WHERE user_id = $1
          AND lifted_at IS NULL
          AND (expires_at IS NULL OR expires_at > $2)
        ORDER BY (expires_at IS NULL) DESC, issued_at DESC
        LIMIT 1`,
      [userId, now],
    );
    return row === null ? null : toBan(row);
  }

  /** Lifts every in-force ban. The rows remain, for the audit trail. */
  async liftBan(userId: UserId, liftedAt: Date): Promise<void> {
    await this.db.query(`UPDATE bans SET lifted_at = $2 WHERE user_id = $1 AND lifted_at IS NULL`, [
      userId,
      liftedAt,
    ]);
  }
}
