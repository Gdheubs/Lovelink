import type { Ban } from '../../domain/entities/Ban.js';
import { isActiveBan } from '../../domain/entities/Ban.js';
import type { Report, ReportStatus } from '../../domain/entities/Report.js';
import { compareForQueue } from '../../domain/entities/Report.js';
import type {
  CreateBanInput,
  CreateReportInput,
  ReportRepository,
  ResolveReportInput,
} from '../../domain/ports/ReportRepository.js';
import type { ReportId, UserId } from '../../domain/values/ids.js';
import { NotFoundError } from '../../domain/errors.js';

/**
 * ADAPTER (memory): reports and bans.
 *
 * NOTE ON QUEUE ORDERING: this fake sorts with the domain's own
 * `compareForQueue`, while the Postgres adapter expresses the same ordering in
 * SQL (urgent categories first, then oldest first). They are two encodings of
 * one rule, and the adapter integration test asserts they agree — because a
 * moderation queue that orders differently in dev than in production is how
 * urgent reports get missed.
 *
 * Nothing here deletes, matching the port: dismissing sets a status, lifting a
 * ban sets `liftedAt`.
 */
export class MemoryReportRepository implements ReportRepository {
  private readonly reports = new Map<string, Report>();
  private readonly bans = new Map<string, Ban[]>();

  async create(input: CreateReportInput): Promise<Report> {
    const report: Report = Object.freeze({
      ...input,
      status: 'open' as ReportStatus,
      reviewedBy: null,
      reviewedAt: null,
      resolution: null,
    });
    this.reports.set(report.id, report);
    return report;
  }

  async findById(id: ReportId): Promise<Report | null> {
    return this.reports.get(id) ?? null;
  }

  async listQueue(status: ReportStatus, limit: number, offset: number): Promise<readonly Report[]> {
    return [...this.reports.values()]
      .filter((r) => r.status === status)
      .sort(compareForQueue)
      .slice(offset, offset + limit);
  }

  async listOpenByReporterAgainst(
    reporterId: UserId,
    targetId: UserId,
  ): Promise<readonly Report[]> {
    return [...this.reports.values()].filter(
      (r) =>
        r.reporterId === reporterId &&
        r.targetId === targetId &&
        (r.status === 'open' || r.status === 'reviewing'),
    );
  }

  async listAgainst(targetId: UserId, limit: number): Promise<readonly Report[]> {
    return [...this.reports.values()]
      .filter((r) => r.targetId === targetId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  async claimForReview(id: ReportId, moderatorId: UserId, at: Date): Promise<Report> {
    const existing = this.reports.get(id);
    if (existing === undefined) throw new NotFoundError('Report');
    const updated: Report = Object.freeze({
      ...existing,
      status: 'reviewing' as ReportStatus,
      reviewedBy: moderatorId,
      reviewedAt: at,
    });
    this.reports.set(id, updated);
    return updated;
  }

  async resolve(input: ResolveReportInput): Promise<Report> {
    const existing = this.reports.get(input.id);
    if (existing === undefined) throw new NotFoundError('Report');
    const updated: Report = Object.freeze({
      ...existing,
      status: input.status,
      reviewedBy: input.reviewedBy,
      reviewedAt: input.reviewedAt,
      resolution: input.resolution,
    });
    this.reports.set(input.id, updated);
    return updated;
  }

  async countByStatus(status: ReportStatus): Promise<number> {
    let count = 0;
    for (const report of this.reports.values()) {
      if (report.status === status) count += 1;
    }
    return count;
  }

  // -- bans ----------------------------------------------------------------

  async createBan(input: CreateBanInput): Promise<Ban> {
    const ban: Ban = Object.freeze({ ...input, liftedAt: null });
    const list = this.bans.get(input.userId) ?? [];
    list.push(ban);
    this.bans.set(input.userId, list);
    return ban;
  }

  async listBans(userId: UserId): Promise<readonly Ban[]> {
    return [...(this.bans.get(userId) ?? [])].sort(
      (a, b) => b.issuedAt.getTime() - a.issuedAt.getTime(),
    );
  }

  async findActiveBan(userId: UserId, now: Date): Promise<Ban | null> {
    const list = this.bans.get(userId) ?? [];
    // Permanent bans win over temporary ones so the notice shown is the truthful one.
    const active = list.filter((b) => isActiveBan(b, now));
    return active.find((b) => b.expiresAt === null) ?? active[0] ?? null;
  }

  async liftBan(userId: UserId, liftedAt: Date): Promise<void> {
    const list = this.bans.get(userId) ?? [];
    this.bans.set(
      userId,
      list.map((b) => (b.liftedAt === null ? Object.freeze({ ...b, liftedAt }) : b)),
    );
  }

  /** Test helper. Not part of the port. */
  clear(): void {
    this.reports.clear();
    this.bans.clear();
  }
}
