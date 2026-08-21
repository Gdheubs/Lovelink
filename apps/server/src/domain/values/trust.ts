/**
 * Trust scoring and tiers.
 *
 * WHY THIS EXISTS
 * ---------------
 * `users.trust_score` is a DERIVED value: the sum of an append-only
 * `trust_events` ledger. We never mutate a score directly, because a bare
 * integer that drifts is unauditable — when a user asks "why can't I DM?", we
 * must be able to show them the exact events that produced their standing.
 *
 * INVARIANT: score is always `sum(trust_events.delta)` clamped to [MIN, MAX].
 * Anything that changes standing appends an event; nothing writes the score
 * except a projection of that ledger.
 */

export const TRUST_MIN = -100;
export const TRUST_MAX = 100;

/** Reasons a trust delta can be applied. Append new members; never repurpose old ones. */
export type TrustReason =
  | 'account_created'
  | 'room_session_completed'
  | 'promoted_to_speaker'
  | 'surprise_sent'
  | 'surprise_redeemed'
  | 'report_upheld'
  | 'report_dismissed'
  | 'kicked_from_room'
  | 'banned'
  | 'manual_adjustment';

/**
 * The canonical delta table. Use cases reference these, never magic numbers.
 *
 * THE STARTING BALANCE IS LOAD-BEARING
 * ------------------------------------
 * `account_created` is POSITIVE, and that is not a welcome gift — it is what
 * stops a single negative event from restricting a brand-new account.
 *
 * With a starting balance of zero, one `kicked_from_room` took a new user
 * straight below zero and therefore to the `restricted` tier, which blocks
 * joining ANY room. So one host, kicking one person for any reason at all —
 * including a capricious one — effectively removed them from the whole
 * platform. That directly contradicts what a kick is supposed to be
 * (room-scoped, not account-scoped) and was found by a test that expected a
 * kicked user to be able to walk into a different room.
 *
 * The balance is therefore sized so that:
 *   - ONE kick costs something but restricts nobody;
 *   - a PATTERN of kicks does restrict, which is what the signal is actually
 *     worth ("a host asked them to leave" is weak evidence; "several hosts
 *     did" is not);
 *   - ONE upheld report restricts immediately, because a moderator reviewing
 *     evidence is strong evidence and should not need to happen three times.
 */
export const TRUST_DELTAS: Readonly<Record<TrustReason, number>> = Object.freeze({
  // The starting balance. See above — this is a safety property, not a perk.
  account_created: 10,
  room_session_completed: 2,
  promoted_to_speaker: 3,
  surprise_sent: 1,
  surprise_redeemed: 2,
  // Strong evidence, reviewed by a person: restricts on its own (10 - 25 < 0).
  report_upheld: -25,
  report_dismissed: 0,
  // Weak evidence, applied unilaterally by one host: three of them restrict.
  kicked_from_room: -5,
  banned: -100,
  manual_adjustment: 0,
});

export type TrustTier = 'restricted' | 'newcomer' | 'regular' | 'trusted';

/**
 * Thresholds are inclusive lower bounds, checked from the top down.
 *
 * THEY ARE SIZED RELATIVE TO THE STARTING BALANCE, and must stay that way.
 * `account_created` grants 10, so `regular` has to begin well above that — a
 * brand-new account that reads as "Regular" on its own profile screen is
 * simply wrong, and it was exactly what happened when the starting balance was
 * introduced without moving these.
 *
 * Roughly: NEWCOMER is where you start, REGULAR is a handful of real sessions
 * in, TRUSTED takes sustained participation.
 */
const REGULAR_FROM = 25;
const TRUSTED_FROM = 60;

export function trustTier(score: number): TrustTier {
  if (score < 0) return 'restricted';
  if (score >= TRUSTED_FROM) return 'trusted';
  if (score >= REGULAR_FROM) return 'regular';
  return 'newcomer';
}

export function clampTrust(score: number): number {
  return Math.max(TRUST_MIN, Math.min(TRUST_MAX, Math.trunc(score)));
}

/** Project the ledger into a score. The ONLY sanctioned way to compute one. */
export function projectTrustScore(deltas: readonly number[]): number {
  return clampTrust(deltas.reduce((sum, d) => sum + d, 0));
}

/**
 * A restricted user keeps read access but loses the privileges that let them
 * reach other people unprompted. Enforced in the trust-ladder rules.
 */
export function isRestricted(score: number): boolean {
  return trustTier(score) === 'restricted';
}
