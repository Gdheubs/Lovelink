import type { UserId } from '../values/ids.js';

/**
 * An enforcement action against an account.
 *
 * WHY THIS SHAPE
 * --------------
 * `expiresAt` is nullable: null means permanent. A temporary suspension and a
 * permanent ban are the same concept with different clocks, and collapsing them
 * into one row means every enforcement check is a single query rather than two
 * that can disagree.
 *
 * INVARIANT: a ban is a FACT, not a flag — bans are never deleted, only
 * expired or lifted (which sets `liftedAt`). `users.status` is a cached
 * projection of the active ban, so that the hot path (every socket connect)
 * does not need to join. If the two ever disagree, the ban row wins.
 */
export interface Ban {
  readonly userId: UserId;
  readonly reason: string;
  /** Null for a permanent ban. */
  readonly expiresAt: Date | null;
  readonly issuedBy: UserId | null;
  readonly issuedAt: Date;
  /** Set when a moderator reverses the ban early. */
  readonly liftedAt: Date | null;
}

/** True when the ban is currently in force. */
export function isActiveBan(ban: Ban, now: Date): boolean {
  if (ban.liftedAt !== null) return false;
  if (ban.expiresAt === null) return true;
  return ban.expiresAt.getTime() > now.getTime();
}

export function isPermanent(ban: Pick<Ban, 'expiresAt'>): boolean {
  return ban.expiresAt === null;
}

/**
 * The message shown to a banned user. Deliberately does not disclose who
 * reported them or which specific message triggered it — that information is
 * routinely used to retaliate against the reporter.
 */
export function banNotice(ban: Ban): string {
  return isPermanent(ban)
    ? 'Your account has been suspended for breaking the community rules.'
    : 'Your account is temporarily suspended for breaking the community rules.';
}
