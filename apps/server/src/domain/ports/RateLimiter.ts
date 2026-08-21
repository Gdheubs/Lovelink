/**
 * PORT: RateLimiter
 *
 * WHY THIS EXISTS
 * ---------------
 * Rate limiting is a SAFETY control here, not a capacity control. The things it
 * protects against are: chat flooding, DM-request spam (a harassment vector
 * that the trust ladder alone does not stop, because a shared room is easy to
 * arrange), surprise-code brute forcing, and report spam. Because it is a
 * safety control, the limits are business rules and belong where the rest of
 * them live — hence a port, not a Fastify plugin bolted onto the HTTP layer
 * (which would leave the socket edge, the more abusable one, unprotected).
 *
 * INVARIANTS
 *  - `check` is atomic: two concurrent calls at the boundary cannot both
 *    succeed. In the Redis adapter this is a single INCR + EXPIRE, not a
 *    read-modify-write.
 *  - `check` CONSUMES a unit. It is not a peek. Call it once per attempt, and
 *    call it before doing the work, never after.
 */

export interface RateLimitResult {
  readonly allowed: boolean;
  /** Attempts left in the current window. */
  readonly remaining: number;
  /** When the window resets, epoch ms. Sent to clients as Retry-After. */
  readonly resetAtMs: number;
}

export interface RateLimiter {
  /**
   * Consume one unit against `key`.
   * @param key   Caller-scoped identity, e.g. `chat:send:<userId>:<roomId>`.
   * @param limit Max attempts allowed inside the window.
   * @param windowSec Window length in seconds.
   */
  check(key: string, limit: number, windowSec: number): Promise<RateLimitResult>;

  /** Clear a key. Used by tests and by moderators lifting a lockout. */
  reset(key: string): Promise<void>;
}

/**
 * The limit catalogue.
 *
 * Centralised so that tuning abuse controls is one diff a reviewer can reason
 * about, rather than a hunt through handlers. Each entry documents WHAT it
 * protects, because a limit whose purpose is unrecorded gets "temporarily"
 * raised during an incident and never lowered again.
 */
export interface LimitSpec {
  readonly limit: number;
  readonly windowSec: number;
}

export const LIMITS = Object.freeze({
  /** Chat flooding. Generous enough for genuine fast conversation. */
  chatSend: { limit: 20, windowSec: 10 } as LimitSpec,
  /** Typing indicators are chatty by nature; limited only to stop pure spam. */
  chatTyping: { limit: 30, windowSec: 10 } as LimitSpec,
  /** Reaction spam is a screen-flooding tactic. */
  reactionSend: { limit: 10, windowSec: 10 } as LimitSpec,
  /** Hand raise/lower toggling to spam the host's queue. */
  handToggle: { limit: 10, windowSec: 60 } as LimitSpec,
  /** Room joins - protects presence churn and media-token minting. */
  roomJoin: { limit: 20, windowSec: 60 } as LimitSpec,
  /**
   * DM requests. Deliberately harsh: this is the primary unsolicited-contact
   * vector and there is no legitimate reason to request twenty conversations a
   * minute.
   */
  dmRequest: { limit: 5, windowSec: 3600 } as LimitSpec,
  dmSend: { limit: 30, windowSec: 60 } as LimitSpec,
  /** 1:1 call invites - unanswered ringing is itself harassment. */
  callInvite: { limit: 5, windowSec: 300 } as LimitSpec,
  /** Surprise creation, to stop bulk-code generation. */
  surpriseCreate: { limit: 10, windowSec: 3600 } as LimitSpec,
  /**
   * Surprise redemption attempts, keyed by USER and by IP.
   * This is the brute-force control on claim codes; it is the reason a short
   * human-typeable code is acceptable at all.
   */
  surpriseRedeem: { limit: 10, windowSec: 600 } as LimitSpec,
  /** Report submission. Low, because report spam is a harassment vector. */
  reportSubmit: { limit: 5, windowSec: 3600 } as LimitSpec,
  /**
   * Auth: code requests PER IDENTIFIER.
   *
   * This is the control that protects a VICTIM from being SMS-bombed by someone
   * who knows their number, so it is deliberately harsh: there is no legitimate
   * reason to request six codes for one number in fifteen minutes.
   */
  authRequest: { limit: 5, windowSec: 900 } as LimitSpec,

  /**
   * Auth: code requests PER IP.
   *
   * A DIFFERENT control with a DIFFERENT purpose — this one caps our SMS bill
   * when one actor works through many numbers. It must be far more generous
   * than the per-identifier limit, because IP ADDRESSES ARE SHARED: an office,
   * a university, a café, and especially carrier-grade NAT put thousands of
   * unrelated people behind one address.
   *
   * Setting this as tight as the per-identifier limit means the sixth person on
   * a shared connection cannot sign up at all — a self-inflicted outage for a
   * whole building, invisible to us because it looks like a working rate
   * limiter.
   */
  authRequestPerIp: { limit: 40, windowSec: 900 } as LimitSpec,

  /** Auth: verification attempts per identifier, to stop OTP brute force. */
  authVerify: { limit: 8, windowSec: 900 } as LimitSpec,

  /** Auth: verification attempts per IP. Same shared-address reasoning. */
  authVerifyPerIp: { limit: 60, windowSec: 900 } as LimitSpec,
} as const);

export type LimitName = keyof typeof LIMITS;
