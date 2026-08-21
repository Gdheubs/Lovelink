import type { Ports } from '../../domain/ports/index.js';
import type { TokenPair } from '../../domain/ports/TokenService.js';
import { mustDisconnect } from '../../domain/rules/moderation.js';
import { AuthorizationError } from '../../domain/errors.js';

/**
 * USE CASE: exchange a refresh token for a new token pair.
 *
 * WHY THE BAN CHECK IS HERE
 * -------------------------
 * A refresh token outlives an access token by weeks. Without this check, a user
 * banned five minutes ago keeps refreshing indefinitely and the ban is
 * decorative. So refresh is the second of the three places account status is
 * enforced:
 *
 *   1. socket connect      — closes the "already connected" window
 *   2. refresh (here)      — closes the "still holding a refresh token" window
 *   3. EventBus disconnect — closes the "connected right now" window immediately
 *
 * Three checks for one rule looks redundant; it is not. Each covers a window
 * the others do not, and the bus is best-effort rather than a guarantee.
 *
 * ROTATION
 * --------
 * The port rotates on every use: presenting a refresh token twice fails the
 * second time and revokes the session family. That is what turns a stolen
 * refresh token from a permanent credential into a detectable event — the real
 * user's next refresh fails, and they are logged out rather than shadowed.
 */
export interface RefreshSessionInput {
  readonly refreshToken: string;
}

export class RefreshSession {
  constructor(private readonly ports: Ports) {}

  async execute(input: RefreshSessionInput): Promise<TokenPair> {
    const rotated = await this.ports.tokens.rotateRefreshToken(input.refreshToken);

    if (rotated === null) {
      // Unknown, expired, already-used, or revoked. All four are the same
      // answer to the client: log in again. Distinguishing them would tell an
      // attacker which of their stolen tokens are live.
      throw new AuthorizationError(
        'Your session has expired. Please sign in again.',
        'UNAUTHENTICATED',
      );
    }

    const user = await this.ports.users.findById(rotated.userId);

    if (user === null) {
      await this.ports.tokens.revokeSession(rotated.sessionId);
      throw new AuthorizationError(
        'Your session has expired. Please sign in again.',
        'UNAUTHENTICATED',
      );
    }

    if (mustDisconnect(user)) {
      // Revoke everything, not just this session: a banned user with three
      // devices should lose all three, and they will not be back to refresh
      // the other two.
      await this.ports.tokens.revokeAllSessions(user.id);
      this.ports.logger.info(
        { userId: user.id, status: user.status },
        'refresh refused: account not active',
      );
      throw new AuthorizationError(
        'Your account has been suspended for breaking the community rules.',
        'BANNED',
      );
    }

    // Same session id: this is a continuation, not a new login. Keeping it
    // stable means "sign out this device" still means one device.
    const access = await this.ports.tokens.issueAccessToken(user.id, rotated.sessionId);
    const refresh = await this.ports.tokens.issueRefreshToken(user.id, rotated.sessionId);

    return {
      accessToken: access.token,
      refreshToken: refresh.token,
      accessExpiresAt: access.expiresAt,
      refreshExpiresAt: refresh.expiresAt,
    };
  }
}
