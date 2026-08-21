import type { UserId } from '../values/ids.js';

/**
 * PORT: TokenService
 *
 * WHY THIS EXISTS
 * ---------------
 * JWT libraries are a classic vendor entanglement: `jose`, `jsonwebtoken` and
 * the platform's own WebCrypto all disagree about APIs, and every one of them
 * has a footgun (`algorithms: none`, unverified `decode()` used where `verify()`
 * was meant). Isolating them behind five methods means there is exactly one
 * place to get the verification right, and one place to audit.
 *
 * ACCESS vs REFRESH — and why they are different types
 * ----------------------------------------------------
 * Access tokens are short-lived, stateless, and presented on every request and
 * socket connect. Refresh tokens are long-lived, must be REVOCABLE, and are
 * therefore stored server-side. Giving them separate mint/verify methods means
 * a refresh token can never be accepted where an access token is expected —
 * which is otherwise a real and quiet privilege escalation, because a refresh
 * token outlives every ban.
 *
 * INVARIANT: `verifyAccess` must reject a token whose `typ` is not `access`,
 * must verify the signature (never decode-without-verify), and must check
 * expiry against the injected Clock rather than the process clock.
 */

export interface AccessClaims {
  readonly userId: UserId;
  /** Session identity, so one device's logout does not kill the others. */
  readonly sessionId: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
}

export interface TokenPair {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessExpiresAt: Date;
  readonly refreshExpiresAt: Date;
}

export interface TokenService {
  /** Mint a short-lived access token. */
  issueAccessToken(userId: UserId, sessionId: string): Promise<{ token: string; expiresAt: Date }>;

  /**
   * Verify and decode an access token.
   * @returns claims, or null when the token is absent, malformed, expired,
   *          wrongly typed, or signed with the wrong key. Callers get a null,
   *          never an exception, because an invalid token is an ordinary event
   *          on a public endpoint and should not fill the logs with stacks.
   */
  verifyAccessToken(token: string): Promise<AccessClaims | null>;

  /**
   * Mint a refresh token and record it server-side so it can be revoked.
   * The returned string is opaque to the client.
   */
  issueRefreshToken(userId: UserId, sessionId: string): Promise<{ token: string; expiresAt: Date }>;

  /**
   * Exchange a refresh token for a new pair, ROTATING it.
   *
   * Rotation matters: if a refresh token is stolen and both the thief and the
   * user present it, the second presentation fails and we learn the token was
   * compromised. A non-rotating refresh token is a permanent credential.
   *
   * @returns null when the token is unknown, expired or already used.
   */
  rotateRefreshToken(token: string): Promise<{ userId: UserId; sessionId: string } | null>;

  /** Revoke one session (logout on this device). */
  revokeSession(sessionId: string): Promise<void>;

  /** Revoke every session for a user. Called on ban and on password/identity change. */
  revokeAllSessions(userId: UserId): Promise<void>;
}
