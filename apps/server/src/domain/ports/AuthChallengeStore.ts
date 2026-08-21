import type { IdentifierKind } from '../entities/User.js';

/**
 * PORT: AuthChallengeStore
 *
 * WHY THIS EXISTS
 * ---------------
 * Passwordless auth (phone OTP / email magic link) needs a short-lived,
 * single-use secret bound to an identifier. That is a cache with rules, and the
 * rules are security-critical enough to state on the interface rather than
 * leave to whoever writes the Redis calls:
 *
 * INVARIANTS
 *  - Challenges EXPIRE (default 10 minutes). An OTP with no TTL is a password.
 *  - `consume` is single-use and ATOMIC. Two concurrent submissions of the same
 *    code must not both succeed, or a leaked code stays useful.
 *  - Failed attempts are COUNTED and the challenge is destroyed after
 *    MAX_ATTEMPTS. A 6-digit code with unlimited attempts is a 6-digit code
 *    with no security.
 *  - The stored value is a HASH of the code, not the code. Anyone reading a
 *    Redis dump or a log line should not be able to log in as someone else.
 */

export const CHALLENGE_TTL_SECONDS = 600;
export const MAX_CHALLENGE_ATTEMPTS = 5;
export const OTP_LENGTH = 6;

export interface Challenge {
  readonly identifier: string;
  readonly identifierKind: IdentifierKind;
  /** Attempts used so far. */
  readonly attempts: number;
  readonly expiresAtMs: number;
}

export interface AuthChallengeStore {
  /**
   * Create (or replace) the challenge for an identifier.
   * Replacing rather than stacking means requesting a new code invalidates the
   * old one — otherwise every resend widens the guessing surface.
   */
  issue(
    identifier: string,
    identifierKind: IdentifierKind,
    code: string,
    ttlSeconds?: number,
  ): Promise<void>;

  /**
   * Atomically verify and destroy a challenge.
   * @returns 'ok' on success; 'invalid' on wrong code (attempt counted);
   *          'expired' when absent or timed out; 'too_many_attempts' when the
   *          challenge was destroyed for exceeding MAX_CHALLENGE_ATTEMPTS.
   */
  consume(
    identifier: string,
    code: string,
  ): Promise<'ok' | 'invalid' | 'expired' | 'too_many_attempts'>;

  /** Inspect without consuming. For diagnostics and tests only. */
  peek(identifier: string): Promise<Challenge | null>;

  /** Drop a challenge, e.g. after a successful login through another route. */
  discard(identifier: string): Promise<void>;
}
