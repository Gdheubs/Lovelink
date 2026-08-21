import type { Report, ReportCategory } from '../../domain/entities/Report.js';
import type { User } from '../../domain/entities/User.js';
import type { Ports } from '../../domain/ports/index.js';
import type { RoomId, UserId } from '../../domain/values/ids.js';
import { isReportCategory, normalizeReportNote } from '../../domain/entities/Report.js';
import { assertCanSubmitReport } from '../../domain/rules/moderation.js';
import { LIMITS } from '../../domain/ports/RateLimiter.js';
import { asReportId } from '../../domain/values/ids.js';
import { NotFoundError, RateLimitError, ValidationError } from '../../domain/errors.js';

/**
 * USE CASE: report someone.
 *
 * THIS MUST ALWAYS SUCCEED FOR THE REPORTER
 * -----------------------------------------
 * Someone reporting harassment is, by definition, having a bad time. Every
 * failure mode here has been chosen to avoid adding to it:
 *
 *   - the report is recorded FIRST, before any notification, trust write, or
 *     metric. Those are all best-effort afterwards, because a report that
 *     failed because a counter was unavailable is unforgivable;
 *   - the response never says whether the target has been reported before,
 *     which would be a way to probe other people's standing;
 *   - it never tells the target anything. Retaliation against a reporter is
 *     the most predictable consequence of a leak here, so the target is not
 *     notified at all.
 *
 * THE ONE-OPEN-REPORT RULE, AND ITS EXCEPTION
 * -------------------------------------------
 * A reporter may hold one open report per target. Without that, "report"
 * becomes a button that generates unlimited notifications about someone you
 * dislike, and the queue becomes useless.
 *
 * Urgent categories — minor safety, self-harm — are EXEMPT. Suppressing a
 * second child-safety report because a spam report is already open would be
 * indefensible, and that judgement lives in the domain rather than here.
 */
export interface SubmitReportInput {
  readonly targetId: UserId;
  /** Where it happened. Null for a profile or DM report. */
  readonly roomId?: RoomId | null;
  readonly category: string;
  readonly note?: string;
  /**
   * Handle to a retained audio clip, if the client captured one.
   *
   * Optional by design: recording every room continuously is both a privacy
   * hazard and a storage bill. We keep a clip only when someone asks us to
   * look at something.
   */
  readonly audioRef?: string | null;
}

export class SubmitReport {
  constructor(private readonly ports: Ports) {}

  async execute(reporter: User, input: SubmitReportInput): Promise<Report> {
    if (!isReportCategory(input.category)) {
      throw new ValidationError('Choose a reason for your report.');
    }
    const category: ReportCategory = input.category;

    // Report spam is itself a harassment vector, so this is limited — but
    // generously enough that nobody with a real complaint is ever blocked.
    const limit = await this.ports.rateLimiter.check(
      `report:submit:${reporter.id}`,
      LIMITS.reportSubmit.limit,
      LIMITS.reportSubmit.windowSec,
    );
    if (!limit.allowed) {
      this.ports.metrics.increment('ratelimit.blocked');
      throw new RateLimitError('You have sent several reports recently. Our team is looking.');
    }

    const target = await this.ports.users.findById(input.targetId);
    if (target === null) throw new NotFoundError('That person');

    const existingOpenReports = await this.ports.reports.listOpenByReporterAgainst(
      reporter.id,
      input.targetId,
    );

    // Domain rule: no self-reports, one open report per target, urgent exempt.
    assertCanSubmitReport(
      { reporterId: reporter.id, targetId: input.targetId, existingOpenReports },
      category,
    );

    const note = normalizeReportNote(input.note ?? '');

    // THE RECORD, FIRST. Everything below this line is best-effort.
    const report = await this.ports.reports.create({
      id: asReportId(this.ports.ids.uuid()),
      reporterId: reporter.id,
      targetId: input.targetId,
      roomId: input.roomId ?? null,
      category,
      note,
      audioRef: input.audioRef ?? null,
      createdAt: this.ports.clock.now(),
    });

    this.ports.metrics.increment('report.submitted');

    // Deliberately logged WITHOUT the note. A report's free text routinely
    // contains exactly the abuse being reported, and logs are read by more
    // people, in more places, than the moderation queue is.
    this.ports.logger.warn(
      {
        reportId: report.id,
        category,
        targetId: input.targetId,
        roomId: input.roomId ?? null,
        urgent: category === 'minor_safety' || category === 'self_harm',
      },
      'report submitted',
    );

    return report;
  }
}
