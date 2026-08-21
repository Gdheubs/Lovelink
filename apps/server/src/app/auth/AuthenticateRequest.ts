import type { User } from '../../domain/entities/User.js';
import type { Ports } from '../../domain/ports/index.js';
import { mustDisconnect } from '../../domain/rules/moderation.js';
import { AuthorizationError } from '../../domain/errors.js';

/**
 * USE CASE: turn a bearer token into an authenticated actor.
 *
 * WHY THIS IS A USE CASE AND NOT MIDDLEWARE
 * -----------------------------------------
 * Because there are two edges. The HTTP layer needs it per request and the
 * socket layer needs it per connection, and if each implemented its own version
 * they would drift — most likely on the account-status check, which is the part
 * a middleware author is most tempted to skip "for performance".
 *
 * Putting it here means both edges get exactly the same answer, and the rule
 * that a suspended account cannot act is enforced in one place.
 *
 * INVARIANT: the returned actor is a LOADED USER, not a claim from the token.
 * Nothing downstream ever trusts a userId a client sent; the identity comes
 * from a verified signature and is then re-hydrated from the database, so a
 * ban issued thirty seconds ago is visible on the next request.
 */
export interface AuthenticatedActor {
  readonly user: User;
  readonly sessionId: string;
}

export class AuthenticateRequest {
  constructor(private readonly ports: Ports) {}

  /**
   * @param authorizationHeader the raw `Authorization` header, or a bare token.
   * @throws UNAUTHENTICATED for anything unusable; BANNED for a valid token
   *         belonging to a suspended account.
   */
  async execute(authorizationHeader: string | undefined): Promise<AuthenticatedActor> {
    const token = extractBearerToken(authorizationHeader);

    if (token === null) {
      throw new AuthorizationError('Sign in to continue.', 'UNAUTHENTICATED');
    }

    const claims = await this.ports.tokens.verifyAccessToken(token);
    if (claims === null) {
      // Expired, malformed, wrong type, wrong signature, or a revoked session.
      // One answer for all of them — a client's only useful response is to
      // refresh, and distinguishing them helps only an attacker.
      throw new AuthorizationError(
        'Your session has expired. Please sign in again.',
        'UNAUTHENTICATED',
      );
    }

    const user = await this.ports.users.findById(claims.userId);
    if (user === null) {
      throw new AuthorizationError(
        'Your session has expired. Please sign in again.',
        'UNAUTHENTICATED',
      );
    }

    if (mustDisconnect(user)) {
      throw new AuthorizationError(
        'Your account has been suspended for breaking the community rules.',
        'BANNED',
      );
    }

    return { user, sessionId: claims.sessionId };
  }
}

/**
 * Accepts `Bearer <token>` or a bare token.
 *
 * The bare form exists because the socket handshake carries the token in
 * `auth.token` with no scheme prefix. Accepting both here keeps that difference
 * out of the two edges.
 */
export function extractBearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;

  const trimmed = header.trim();
  if (trimmed.length === 0) return null;

  const match = /^Bearer\s+(.+)$/i.exec(trimmed);
  if (match !== null) return match[1]!.trim();

  // A bare token must not contain whitespace; anything else is a malformed
  // header we should reject rather than try to interpret.
  return trimmed.includes(' ') ? null : trimmed;
}
