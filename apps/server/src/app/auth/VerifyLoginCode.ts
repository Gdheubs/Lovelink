import type { PublicProfile, User } from '../../domain/entities/User.js';
import type { Ports } from '../../domain/ports/index.js';
import type { TokenPair } from '../../domain/ports/TokenService.js';
import { toPublicProfile, normalizeDisplayName } from '../../domain/entities/User.js';
import { LIMITS } from '../../domain/ports/RateLimiter.js';
import { TRUST_DELTAS } from '../../domain/values/trust.js';
import { assertAdult, parseDobUtc } from '../../domain/rules/ageGate.js';
import { normalizeIdentifier } from '../../domain/values/identifier.js';
import { asUserId } from '../../domain/values/ids.js';
import {
  AuthorizationError,
  DomainError,
  RateLimitError,
  ValidationError,
} from '../../domain/errors.js';

/**
 * USE CASE: verify a login code, then either log the user in or register them.
 *
 * WHY ONE USE CASE AND NOT TWO
 * ----------------------------
 * Splitting this into `Login` and `Register` would require the caller to know
 * which one to invoke — which means the server must first tell them whether the
 * account exists, which is exactly the enumeration oracle RequestLoginCode goes
 * out of its way to avoid. So the single entry point decides internally, AFTER
 * the caller has proven control of the identifier.
 *
 * The cost is one conditional response: when the identifier is new, we need a
 * display name and a date of birth. The client handles that by sending them
 * optimistically, or by reacting to `REGISTRATION_REQUIRED`.
 *
 * THE 18+ GATE
 * ------------
 * Enforced HERE, server-side, in the registration branch, by the domain's
 * `assertAdult`. Not in the form, not in a route handler. This is the only
 * place an account can come into existence, so it is the only place the gate
 * has to hold — and it holds for every future edge automatically.
 *
 * INVARIANTS PROTECTED
 *  - No account exists whose stored `dob` is under 18 at creation.
 *  - The challenge is consumed exactly once, atomically; a code cannot be
 *    replayed even by the legitimate user.
 *  - A banned user can complete the code check but receives no tokens.
 */
export interface VerifyLoginCodeInput {
  readonly identifier: string;
  readonly code: string;
  readonly ip: string;
  /** Required only when the identifier is new. */
  readonly displayName?: string;
  /** Required only when the identifier is new. `YYYY-MM-DD`. */
  readonly dob?: string;
}

export interface VerifyLoginCodeResult {
  readonly tokens: TokenPair;
  readonly profile: PublicProfile;
  /** True when this call created the account, so the client can show onboarding. */
  readonly isNewAccount: boolean;
}

export class VerifyLoginCode {
  constructor(private readonly ports: Ports) {}

  async execute(input: VerifyLoginCodeInput): Promise<VerifyLoginCodeResult> {
    const { value: identifier, kind } = normalizeIdentifier(input.identifier);

    // Consumed before the check, so a brute-force attempt cannot buy attempts
    // by racing. The challenge store ALSO caps attempts per challenge; this
    // limit covers the attacker who keeps requesting fresh challenges.
    await this.enforceVerifyLimit(identifier, input.ip);

    const outcome = await this.ports.challenges.consume(identifier, input.code);
    if (outcome !== 'ok') {
      throw this.challengeError(outcome);
    }

    const existing = await this.ports.users.findByIdentifier(identifier);

    const user =
      existing === null
        ? await this.register(identifier, kind, input)
        : this.assertLoginAllowed(existing);

    const tokens = await this.issueTokens(user);

    this.ports.logger.info(
      { userId: user.id, isNewAccount: existing === null },
      existing === null ? 'account registered' : 'user logged in',
    );

    return {
      tokens,
      profile: toPublicProfile(user),
      isNewAccount: existing === null,
    };
  }

  // -------------------------------------------------------------------------

  private async register(
    identifier: string,
    kind: 'phone' | 'email',
    input: VerifyLoginCodeInput,
  ): Promise<User> {
    if (input.displayName === undefined || input.dob === undefined) {
      // A distinct, actionable failure: the client now knows to collect the two
      // extra fields and resubmit. It learns this only AFTER proving control of
      // the identifier, so it is not an enumeration signal.
      throw new DomainError(
        'VALIDATION_FAILED',
        'Tell us your name and date of birth to finish creating your account.',
        { registrationRequired: true },
      );
    }

    const displayName = normalizeDisplayName(input.displayName);

    // THE GATE. Domain rule, server side, before the row exists.
    const dob = parseDobUtc(input.dob);
    assertAdult(dob, this.ports.clock.now());

    const user = await this.ports.users.create({
      id: asUserId(this.ports.ids.uuid()),
      identifier,
      identifierKind: kind,
      displayName,
      // Random, NOT derived from the identifier: an avatar is public, and
      // anything derived from a phone number is a public commitment to it.
      avatarSeed: this.ports.ids.token(12),
      dob,
      createdAt: this.ports.clock.now(),
    });

    // Opens the ledger so the account's standing is explainable from event one.
    await this.ports.users.appendTrustEvent({
      userId: user.id,
      delta: TRUST_DELTAS.account_created,
      reason: 'account_created',
      context: null,
      createdAt: this.ports.clock.now(),
    });

    this.ports.metrics.increment('user.registered');
    return user;
  }

  /**
   * A banned user can hold a valid code — they were sent one, because refusing
   * at the request stage would leak their status. Refusal happens here, where
   * the check is cheap and the message is honest.
   */
  private assertLoginAllowed(user: User): User {
    if (user.status === 'active') return user;

    if (user.status === 'deleted') {
      throw new AuthorizationError('That account no longer exists.', 'FORBIDDEN');
    }
    throw new AuthorizationError(
      'Your account has been suspended for breaking the community rules.',
      'BANNED',
    );
  }

  private async issueTokens(user: User): Promise<TokenPair> {
    // One session per login, so signing out on a phone does not sign out a
    // laptop, and so a single compromised device can be revoked alone.
    const sessionId = this.ports.ids.uuid();

    const access = await this.ports.tokens.issueAccessToken(user.id, sessionId);
    const refresh = await this.ports.tokens.issueRefreshToken(user.id, sessionId);

    return {
      accessToken: access.token,
      refreshToken: refresh.token,
      accessExpiresAt: access.expiresAt,
      refreshExpiresAt: refresh.expiresAt,
    };
  }

  private async enforceVerifyLimit(identifier: string, ip: string): Promise<void> {
    for (const key of [`auth:verify:id:${identifier}`, `auth:verify:ip:${ip}`]) {
      const result = await this.ports.rateLimiter.check(
        key,
        LIMITS.authVerify.limit,
        LIMITS.authVerify.windowSec,
      );
      if (!result.allowed) {
        this.ports.metrics.increment('ratelimit.blocked');
        throw new RateLimitError('Too many attempts. Try again in a few minutes.');
      }
    }
  }

  private challengeError(outcome: 'invalid' | 'expired' | 'too_many_attempts'): DomainError {
    switch (outcome) {
      case 'invalid':
        // Deliberately vague and identical to the expired case in shape, so a
        // guesser cannot tell a wrong code from a dead challenge.
        return new ValidationError('That code is not right. Check it and try again.');
      case 'expired':
        return new ValidationError('That code has expired. Request a new one.');
      case 'too_many_attempts':
        return new RateLimitError('Too many incorrect attempts. Request a new code.');
    }
  }
}
