import type { Ban } from '../entities/Ban.js';
import type { Report, ReportStatus } from '../entities/Report.js';
import type { User } from '../entities/User.js';
import type { UserId } from '../values/ids.js';
import { isActiveBan } from '../entities/Ban.js';
import { isUrgent } from '../entities/Report.js';
import { TRUST_DELTAS } from '../values/trust.js';
import { AuthorizationError, ConflictError, ValidationError } from '../errors.js';

/**
 * Moderation and enforcement rules.
 *
 * WHY THIS EXISTS
 * ---------------
 * The safety baseline (report -> queue -> review -> ban -> force disconnect) is
 * non-deferrable, which means it will be touched by whoever is on call at 3am.
 * Putting the decisions here — pure, named, and tested — means that person can
 * read what the system does without tracing it through Fastify routes and
 * socket handlers.
 *
 * INVARIANTS THIS PROTECTS
 *  - A user cannot report themselves, and cannot spam duplicate open reports
 *    against the same target (which would drown the queue and function as its
 *    own harassment vector).
 *  - Only a moderator resolves a report, and a resolved report cannot be
 *    silently re-resolved to a different outcome.
 *  - Upholding a report and issuing a ban both append to the trust ledger; the
 *    penalties are named constants, not numbers typed at the call site.
 */

// ---------------------------------------------------------------------------
// Who may moderate
// ---------------------------------------------------------------------------

/**
 * Platform-level moderator authority.
 *
 * DELIBERATELY SIMPLE: at MVP, moderators are a fixed allowlist of user ids
 * supplied by configuration, not a role column. A role column invites a
 * privilege-escalation bug (anyone who can write a user row can mint a
 * moderator); a config allowlist can only be changed by someone with deploy
 * access. When this needs to become a real RBAC system, that is an ADR.
 */
export interface ModeratorDirectory {
  readonly moderatorIds: ReadonlySet<UserId>;
}

export function isModerator(directory: ModeratorDirectory, userId: UserId): boolean {
  return directory.moderatorIds.has(userId);
}

export function assertIsModerator(directory: ModeratorDirectory, userId: UserId): void {
  if (!isModerator(directory, userId)) {
    throw new AuthorizationError('Moderator access required.', 'FORBIDDEN', { userId });
  }
}

// ---------------------------------------------------------------------------
// Submitting a report
// ---------------------------------------------------------------------------

export interface ReportSubmissionContext {
  readonly reporterId: UserId;
  readonly targetId: UserId;
  /** Open reports this reporter already has against this target. */
  readonly existingOpenReports: readonly Pick<Report, 'status' | 'category'>[];
}

/**
 * A reporter may hold ONE open report per target at a time.
 *
 * WHY: without this, "report" becomes a button that generates unlimited
 * notifications about someone you dislike, and the review queue becomes
 * useless. Once the existing report is resolved, a new one is allowed —
 * genuine repeat abuse is still reportable.
 *
 * EXCEPTION: urgent categories (minor safety, self-harm) are never blocked by
 * this rule. Suppressing a second report of a child-safety concern because a
 * spam report is already open would be indefensible.
 */
export function assertCanSubmitReport(
  ctx: ReportSubmissionContext,
  category: Report['category'],
): void {
  if (ctx.reporterId === ctx.targetId) {
    throw new ValidationError('You cannot report yourself.');
  }
  if (isUrgent(category)) return;

  const hasOpen = ctx.existingOpenReports.some(
    (r) => r.status === 'open' || r.status === 'reviewing',
  );
  if (hasOpen) {
    throw new ConflictError(
      'You already have a report open about this person. Our team is looking at it.',
      'CONFLICT',
      { targetId: ctx.targetId },
    );
  }
}

// ---------------------------------------------------------------------------
// Resolving a report
// ---------------------------------------------------------------------------

const RESOLVABLE_FROM: readonly ReportStatus[] = Object.freeze(['open', 'reviewing'] as const);

export function assertCanResolveReport(report: Pick<Report, 'status'>): void {
  if (!RESOLVABLE_FROM.includes(report.status)) {
    throw new ConflictError('That report has already been resolved.', 'CONFLICT', {
      status: report.status,
    });
  }
}

/**
 * The trust penalty applied to the TARGET when a report is upheld.
 * Returned rather than applied, so the use case owns the write and this stays pure.
 */
export function trustDeltaForResolution(outcome: 'upheld' | 'dismissed'): number {
  return outcome === 'upheld' ? TRUST_DELTAS.report_upheld : TRUST_DELTAS.report_dismissed;
}

// ---------------------------------------------------------------------------
// Bans
// ---------------------------------------------------------------------------

export const DEFAULT_TEMP_BAN_HOURS = 72;

export function assertCanBan(
  directory: ModeratorDirectory,
  moderatorId: UserId,
  targetId: UserId,
): void {
  assertIsModerator(directory, moderatorId);
  if (moderatorId === targetId) {
    throw new ValidationError('You cannot ban yourself.');
  }
  if (isModerator(directory, targetId)) {
    // Moderators are removed from the config allowlist, not banned through the
    // same UI they operate — otherwise a compromised mod account can disable
    // the rest of the team in one pass.
    throw new AuthorizationError('Moderators cannot be banned from this interface.', 'FORBIDDEN');
  }
}

/** Compute the expiry for a temporary ban; null hours means permanent. */
export function banExpiry(now: Date, hours: number | null): Date | null {
  if (hours === null) return null;
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new ValidationError('Ban duration must be a positive number of hours.');
  }
  return new Date(now.getTime() + hours * 60 * 60 * 1000);
}

/**
 * The projection from ban rows to `users.status`.
 *
 * INVARIANT (stated in Ban.ts): if the cached status and the ban rows ever
 * disagree, the ban rows win. This function is how that reconciliation is done,
 * and it is the ONLY place a status is derived from bans.
 */
export function statusFromBans(
  current: User['status'],
  bans: readonly Ban[],
  now: Date,
): User['status'] {
  if (current === 'deleted') return 'deleted';
  const active = bans.filter((b) => isActiveBan(b, now));
  if (active.length === 0) {
    // Lifting the last ban restores the account rather than leaving it stuck.
    return current === 'banned' || current === 'suspended' ? 'active' : current;
  }
  return active.some((b) => b.expiresAt === null) ? 'banned' : 'suspended';
}

/**
 * Whether an authenticated session must be torn down right now.
 *
 * Called on every socket connect AND broadcast over the EventBus when a ban is
 * issued, because a banned user with an already-open socket is exactly the
 * person a moderator was trying to remove.
 */
export function mustDisconnect(user: Pick<User, 'status'>): boolean {
  return user.status === 'banned' || user.status === 'suspended' || user.status === 'deleted';
}
