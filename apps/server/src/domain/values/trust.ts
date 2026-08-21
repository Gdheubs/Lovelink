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

/** The canonical delta table. Use cases reference these, never magic numbers. */
export const TRUST_DELTAS: Readonly<Record<TrustReason, number>> = Object.freeze({
  account_created: 0,
  room_session_completed: 2,
  promoted_to_speaker: 3,
  surprise_sent: 1,
  surprise_redeemed: 2,
  report_upheld: -25,
  report_dismissed: 0,
  kicked_from_room: -10,
  banned: -100,
  manual_adjustment: 0,
});

export type TrustTier = 'restricted' | 'newcomer' | 'regular' | 'trusted';

/** Thresholds are inclusive lower bounds, checked from the top down. */
export function trustTier(score: number): TrustTier {
  if (score < 0) return 'restricted';
  if (score >= 40) return 'trusted';
  if (score >= 10) return 'regular';
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
