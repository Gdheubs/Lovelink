import type { Report, ReportCategory, ReportStatus } from '../entities/Report.js';
import type { Ban } from '../entities/Ban.js';
import type { ReportId, RoomId, UserId } from '../values/ids.js';

/**
 * PORT: ReportRepository
 *
 * WHY REPORTS AND BANS SHARE A PORT
 * ---------------------------------
 * They are one workflow: a moderator reads a report and, in the same action,
 * either dismisses it or upholds it and bans. Keeping them together means that
 * action is one transaction in the Postgres adapter, so we can never end up
 * with a ban whose justifying report was never marked resolved (or worse, a
 * report marked upheld with no enforcement).
 *
 * INVARIANT: nothing here deletes. `Report` rows are permanent (patterns across
 * dismissed reports are signal) and `Ban` rows are permanent (lifting sets
 * `liftedAt`). The interface offers no delete method on purpose.
 */

export interface CreateReportInput {
  readonly id: ReportId;
  readonly reporterId: UserId;
  readonly targetId: UserId;
  readonly roomId: RoomId | null;
  readonly category: ReportCategory;
  readonly note: string;
  readonly audioRef: string | null;
  readonly createdAt: Date;
}

export interface ResolveReportInput {
  readonly id: ReportId;
  readonly status: Extract<ReportStatus, 'upheld' | 'dismissed'>;
  readonly reviewedBy: UserId;
  readonly reviewedAt: Date;
  readonly resolution: string;
}

export interface CreateBanInput {
  readonly userId: UserId;
  readonly reason: string;
  readonly expiresAt: Date | null;
  readonly issuedBy: UserId | null;
  readonly issuedAt: Date;
}

export interface ReportRepository {
  create(input: CreateReportInput): Promise<Report>;

  findById(id: ReportId): Promise<Report | null>;

  /**
   * The moderation queue, already ordered by `compareForQueue` semantics
   * (urgent categories first, then oldest first). Ordering is expressed in the
   * query so a 5000-report backlog does not have to be loaded to sort it.
   */
  listQueue(status: ReportStatus, limit: number, offset: number): Promise<readonly Report[]>;

  /** Feeds the duplicate-report rule in rules/moderation.ts. */
  listOpenByReporterAgainst(reporterId: UserId, targetId: UserId): Promise<readonly Report[]>;

  /** All reports against a user — context a moderator needs before deciding. */
  listAgainst(targetId: UserId, limit: number): Promise<readonly Report[]>;

  claimForReview(id: ReportId, moderatorId: UserId, at: Date): Promise<Report>;

  resolve(input: ResolveReportInput): Promise<Report>;

  countByStatus(status: ReportStatus): Promise<number>;

  // -- bans ----------------------------------------------------------------

  createBan(input: CreateBanInput): Promise<Ban>;

  /** Every ban ever issued against a user, newest first. */
  listBans(userId: UserId): Promise<readonly Ban[]>;

  /** The currently-in-force ban, if any. Hot path: called on socket connect. */
  findActiveBan(userId: UserId, now: Date): Promise<Ban | null>;

  liftBan(userId: UserId, liftedAt: Date): Promise<void>;
}
