import type { UserId } from '../values/ids.js';
import type { TrustReason } from '../values/trust.js';

/**
 * One append-only entry in a user's trust ledger.
 *
 * WHY THIS EXISTS
 * ---------------
 * See values/trust.ts: `users.trust_score` is a cached projection, and this is
 * the source of truth behind it. Keeping the ledger means we can answer "why is
 * my account restricted?" with a list of dated events instead of a shrug, and
 * it means a scoring bug can be corrected by replaying rather than by guessing
 * at the correct current value.
 *
 * INVARIANT: rows are INSERT-only. Nothing in this codebase updates or deletes
 * a trust event; a mistake is corrected by appending a compensating
 * `manual_adjustment`.
 */
export interface TrustEvent {
  readonly userId: UserId;
  readonly delta: number;
  readonly reason: TrustReason;
  /** Optional free-text context, e.g. the report id that caused a penalty. */
  readonly context: string | null;
  readonly createdAt: Date;
}
