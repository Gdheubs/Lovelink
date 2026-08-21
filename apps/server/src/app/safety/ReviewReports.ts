import type { Report, ReportStatus } from '../../domain/entities/Report.js';
import type { Ports } from '../../domain/ports/index.js';
import type { ReportId, UserId } from '../../domain/values/ids.js';
import type { ModeratorDirectory } from '../../domain/rules/moderation.js';
import {
  assertCanResolveReport,
  assertIsModerator,
  trustDeltaForResolution,
} from '../../domain/rules/moderation.js';
import { NotFoundError, ValidationError } from '../../domain/errors.js';

/**
 * USE CASES: the moderation queue.
 *
 * WHAT A MODERATOR NEEDS, AND WHY THE SHAPE IS THIS
 * -------------------------------------------------
 * A report in isolation is almost unactionable. "This person was rude" tells
 * you nothing about whether it is a bad night or a pattern. So the review view
 * carries the report AND the target's history AND their trust standing — which
 * is what turns a judgement call into an informed one.
 *
 * WHAT IT DELIBERATELY DOES NOT CARRY: the reporter's identity is included for
 * the moderator (they may need to contact them) but is never exposed anywhere
 * near the target. Retaliation against a reporter is the most predictable
 * consequence of leaking it.
 */

export interface QueuedReport {
  readonly report: Report;
  /** Everything else filed against this person, for pattern recognition. */
  readonly targetHistory: readonly Report[];
  readonly targetDisplayName: string;
  readonly targetTrustScore: number;
  readonly targetStatus: string;
  readonly reporterDisplayName: string;
}

const HISTORY_LIMIT = 20;

export class ListReportQueue {
  constructor(
    private readonly ports: Ports,
    private readonly moderators: ModeratorDirectory,
  ) {}

  async execute(
    moderatorId: UserId,
    options: { status?: ReportStatus; limit?: number; offset?: number } = {},
  ): Promise<readonly QueuedReport[]> {
    assertIsModerator(this.moderators, moderatorId);

    const reports = await this.ports.reports.listQueue(
      options.status ?? 'open',
      Math.min(options.limit ?? 25, 100),
      Math.max(0, options.offset ?? 0),
    );
    if (reports.length === 0) return [];

    // One batch load for every participant across the whole page, rather than
    // two queries per row.
    const userIds = [...new Set(reports.flatMap((report) => [report.targetId, report.reporterId]))];
    const users = new Map(
      (await this.ports.users.findManyByIds(userIds)).map((user) => [user.id, user]),
    );

    return Promise.all(
      reports.map(async (report) => {
        const target = users.get(report.targetId);
        const reporter = users.get(report.reporterId);

        return {
          report,
          targetHistory: await this.ports.reports.listAgainst(report.targetId, HISTORY_LIMIT),
          targetDisplayName: target?.displayName ?? 'unknown',
          targetTrustScore: target?.trustScore ?? 0,
          targetStatus: target?.status ?? 'unknown',
          reporterDisplayName: reporter?.displayName ?? 'unknown',
        };
      }),
    );
  }
}

/**
 * USE CASE: claim a report so two moderators do not work the same one.
 *
 * The repository's compare-and-set means the second claimant gets the report
 * back showing who already has it, rather than an error they cannot act on.
 */
export class ClaimReport {
  constructor(
    private readonly ports: Ports,
    private readonly moderators: ModeratorDirectory,
  ) {}

  async execute(moderatorId: UserId, reportId: ReportId): Promise<Report> {
    assertIsModerator(this.moderators, moderatorId);
    return this.ports.reports.claimForReview(reportId, moderatorId, this.ports.clock.now());
  }
}

/**
 * USE CASE: decide a report.
 *
 * UPHOLDING APPLIES A TRUST PENALTY; DISMISSING DOES NOT
 * -----------------------------------------------------
 * The penalty is a named constant in the domain, not a number typed here, so
 * "what does an upheld report cost?" has one answer that can be changed in one
 * place and is visible on the user's own profile screen.
 *
 * A dismissal costs nothing — deliberately. If dismissed reports quietly
 * damaged standing, being reported unfairly would still hurt, which is exactly
 * the outcome a harassment campaign is looking for.
 *
 * BANNING IS A SEPARATE ACTION. Resolving says "this was or was not a
 * violation"; banning says "and this is the consequence". Fusing them would
 * mean every upheld report carried the same penalty regardless of severity.
 */
export interface ResolveReportInput {
  readonly reportId: ReportId;
  readonly outcome: 'upheld' | 'dismissed';
  readonly resolution: string;
}

export class ResolveReport {
  constructor(
    private readonly ports: Ports,
    private readonly moderators: ModeratorDirectory,
  ) {}

  async execute(moderatorId: UserId, input: ResolveReportInput): Promise<Report> {
    assertIsModerator(this.moderators, moderatorId);

    if (input.resolution.trim().length === 0) {
      // A decision with no stated reason is unreviewable weeks later, which is
      // when someone always asks why.
      throw new ValidationError('Say why you reached this decision.');
    }

    const existing = await this.ports.reports.findById(input.reportId);
    if (existing === null) throw new NotFoundError('Report');

    // Refuses to re-resolve an already-closed report.
    assertCanResolveReport(existing);

    const now = this.ports.clock.now();
    const resolved = await this.ports.reports.resolve({
      id: input.reportId,
      status: input.outcome,
      reviewedBy: moderatorId,
      reviewedAt: now,
      resolution: input.resolution.trim(),
    });

    const delta = trustDeltaForResolution(input.outcome);
    if (delta !== 0) {
      await this.ports.users
        .appendTrustEvent({
          userId: existing.targetId,
          delta,
          reason: input.outcome === 'upheld' ? 'report_upheld' : 'report_dismissed',
          context: input.reportId,
          createdAt: now,
        })
        .catch((error: unknown) => {
          this.ports.logger.warn(
            { reportId: input.reportId, err: String(error) },
            'could not record the trust penalty for an upheld report',
          );
        });
    }

    this.ports.metrics.increment('report.resolved');
    this.ports.logger.info(
      { reportId: input.reportId, outcome: input.outcome, moderatorId },
      'report resolved',
    );

    return resolved;
  }
}
