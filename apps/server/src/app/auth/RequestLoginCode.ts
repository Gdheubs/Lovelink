import type { Ports } from '../../domain/ports/index.js';
import { LIMITS } from '../../domain/ports/RateLimiter.js';
import { OTP_LENGTH } from '../../domain/ports/AuthChallengeStore.js';
import { normalizeIdentifier } from '../../domain/values/identifier.js';
import { RateLimitError } from '../../domain/errors.js';

/**
 * USE CASE: request a one-time login code.
 *
 * WHY IT LOOKS LIKE THIS
 * ----------------------
 * This endpoint is unauthenticated and takes an arbitrary phone number or email
 * address, which makes it the most abusable surface in the product. Three
 * distinct attacks have to be answered at once:
 *
 *  1. SMS/EMAIL BOMBING — using us to spam a number the attacker does not own.
 *     Answered by a per-identifier rate limit.
 *  2. COST — every SMS is real money. Same limit, plus a per-IP limit so one
 *     actor cannot spread the cost across many victims.
 *  3. ACCOUNT ENUMERATION — telling the caller whether an identifier is
 *     registered turns this into a "does this person use Loverlink?" oracle,
 *     which for a platform involving late-night intimate conversation is a
 *     genuine safety problem, not just a privacy nicety.
 *
 * ENUMERATION IS THE SUBTLE ONE. The response is IDENTICAL whether or not the
 * account exists: same shape, same message, and — importantly — the code is
 * issued either way, so timing does not leak the answer either. Whether this is
 * a signup or a login is decided later, by VerifyLoginCode, once the caller has
 * proven they control the identifier.
 *
 * INVARIANTS PROTECTED
 *  - No response distinguishes an existing account from a new one.
 *  - A code is never returned to the caller unless AUTH_ECHO_CODE is on, which
 *    config refuses in production.
 *  - The plaintext code is never logged; the challenge store holds only a hash.
 */
export interface RequestLoginCodeInput {
  readonly identifier: string;
  /** Caller IP, from the edge. Used only for rate limiting. */
  readonly ip: string;
}

export interface RequestLoginCodeResult {
  /**
   * Always true, regardless of whether the account exists — see the
   * enumeration note above. It means "we have accepted your request", not
   * "an account was found".
   */
  readonly sent: true;
  readonly identifierKind: 'phone' | 'email';
  /**
   * DEVELOPMENT ONLY: the plaintext code, so `dev:memory` can complete a signup
   * with no SMS provider. Null unless AUTH_ECHO_CODE is enabled, which
   * config.ts rejects outright in production.
   */
  readonly devCode: string | null;
}

export class RequestLoginCode {
  constructor(
    private readonly ports: Ports,
    private readonly options: { readonly echoCode: boolean },
  ) {}

  async execute(input: RequestLoginCodeInput): Promise<RequestLoginCodeResult> {
    const { value: identifier, kind } = normalizeIdentifier(input.identifier);

    // Two limits, both consumed before any work. Per-identifier stops bombing
    // one victim; per-IP stops one actor bombing many.
    await this.enforceLimit(`auth:request:id:${identifier}`);
    await this.enforceLimit(`auth:request:ip:${input.ip}`);

    // Numeric OTP: it gets read aloud, typed on a phone keypad, and
    // autofilled by the OS from an SMS. Letters would help none of that.
    const code = this.generateNumericCode();

    await this.ports.challenges.issue(identifier, kind, code);

    // Delivery is best-effort and MUST NOT change the response shape: a
    // provider failure is our problem, and surfacing "no such number" here
    // would reintroduce the enumeration oracle from the other direction.
    const delivery = await this.ports.notifications.sendLoginCode(identifier, kind, code);
    if (!delivery.delivered) {
      this.ports.logger.warn(
        { kind, reason: delivery.failureReason },
        'login code delivery failed',
      );
    }

    this.ports.metrics.increment('user.login');

    return {
      sent: true,
      identifierKind: kind,
      devCode: this.options.echoCode ? code : null,
    };
  }

  private async enforceLimit(key: string): Promise<void> {
    const result = await this.ports.rateLimiter.check(
      key,
      LIMITS.authRequest.limit,
      LIMITS.authRequest.windowSec,
    );
    if (!result.allowed) {
      this.ports.metrics.increment('ratelimit.blocked');
      throw new RateLimitError('Too many codes requested. Try again in a few minutes.');
    }
  }

  /**
   * A uniformly-distributed numeric code of OTP_LENGTH digits, from the
   * IdGenerator's CSPRNG.
   *
   * `randomCode` returns characters from an unambiguous alphanumeric alphabet;
   * here we need digits only, so we map each character to a digit by index.
   * That mapping is uniform because the source alphabet length (30) is a
   * multiple of 10.
   */
  private generateNumericCode(): string {
    const alphabetic = this.ports.ids.randomCode(OTP_LENGTH);
    let digits = '';
    for (const char of alphabetic) {
      digits += String(char.charCodeAt(0) % 10);
    }
    return digits;
  }
}
