import type { Clock } from '../../domain/ports/Clock.js';
import type { IdGenerator } from '../../domain/ports/IdGenerator.js';
import type { AccessClaims, TokenService } from '../../domain/ports/TokenService.js';
import type { UserId } from '../../domain/values/ids.js';
import { asUserId } from '../../domain/values/ids.js';

interface StoredRefresh {
  userId: UserId;
  sessionId: string;
  expiresAtMs: number;
  used: boolean;
}

/**
 * ADAPTER (memory): TokenService with no cryptography.
 *
 * WHY NO CRYPTO: the point of this fake is to test AUTH FLOW — rotation,
 * revocation, session isolation, expiry — not signature verification, which is
 * the real adapter's job and is covered by its own integration test. A fake
 * that signed things would be slower and would test `jose`, not our logic.
 *
 * IT STILL ENFORCES THE PORT'S SECURITY INVARIANTS, because those are what the
 * use cases depend on:
 *  - access and refresh tokens are distinct namespaces, so one cannot be used
 *    where the other is expected;
 *  - refresh tokens ROTATE: presenting one twice fails the second time;
 *  - revocation is immediate, for one session or all of a user's sessions.
 *
 * Tokens are legible strings (`access.<user>.<session>.<exp>`) so a failing
 * test prints something a human can read.
 */
export class MemoryTokenService implements TokenService {
  private readonly refreshTokens = new Map<string, StoredRefresh>();
  private readonly revokedSessions = new Set<string>();
  /**
   * userId -> every session ever issued for them.
   *
   * Tracked separately from `refreshTokens` because `revokeAllSessions` (called
   * on ban) must kill ACCESS tokens too, and a session whose refresh token has
   * already been rotated away would otherwise survive the ban with a valid
   * access token for up to its full TTL.
   */
  private readonly sessionsByUser = new Map<string, Set<string>>();

  constructor(
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly accessTtlSeconds = 900,
    private readonly refreshTtlSeconds = 60 * 60 * 24 * 30,
  ) {}

  private rememberSession(userId: UserId, sessionId: string): void {
    let sessions = this.sessionsByUser.get(userId);
    if (sessions === undefined) {
      sessions = new Set();
      this.sessionsByUser.set(userId, sessions);
    }
    sessions.add(sessionId);
  }

  async issueAccessToken(
    userId: UserId,
    sessionId: string,
  ): Promise<{ token: string; expiresAt: Date }> {
    this.rememberSession(userId, sessionId);
    const expiresAtMs = this.clock.nowMs() + this.accessTtlSeconds * 1000;
    return {
      token: `access.${userId}.${sessionId}.${expiresAtMs}`,
      expiresAt: new Date(expiresAtMs),
    };
  }

  async verifyAccessToken(token: string): Promise<AccessClaims | null> {
    const parts = token.split('.');
    // A refresh token starts with `refresh.` and is rejected here by shape —
    // the same separation the real adapter enforces with a `typ` claim.
    if (parts.length !== 4 || parts[0] !== 'access') return null;

    const [, userId, sessionId, expiresAtRaw] = parts as [string, string, string, string];
    const expiresAtMs = Number(expiresAtRaw);
    if (!Number.isFinite(expiresAtMs)) return null;
    if (expiresAtMs <= this.clock.nowMs()) return null;
    if (this.revokedSessions.has(sessionId)) return null;

    return {
      userId: asUserId(userId),
      sessionId,
      issuedAtMs: expiresAtMs - this.accessTtlSeconds * 1000,
      expiresAtMs,
    };
  }

  async issueRefreshToken(
    userId: UserId,
    sessionId: string,
  ): Promise<{ token: string; expiresAt: Date }> {
    this.rememberSession(userId, sessionId);
    const token = `refresh.${this.ids.token(24)}`;
    const expiresAtMs = this.clock.nowMs() + this.refreshTtlSeconds * 1000;
    this.refreshTokens.set(token, { userId, sessionId, expiresAtMs, used: false });
    return { token, expiresAt: new Date(expiresAtMs) };
  }

  async rotateRefreshToken(token: string): Promise<{ userId: UserId; sessionId: string } | null> {
    const stored = this.refreshTokens.get(token);
    if (stored === undefined) return null;

    // Replay of an already-rotated token. In a real deployment this is the
    // signal that a token was stolen; the real adapter revokes the whole
    // session family on this branch.
    if (stored.used) {
      this.revokedSessions.add(stored.sessionId);
      return null;
    }
    if (stored.expiresAtMs <= this.clock.nowMs()) return null;
    if (this.revokedSessions.has(stored.sessionId)) return null;

    stored.used = true;
    return { userId: stored.userId, sessionId: stored.sessionId };
  }

  async revokeSession(sessionId: string): Promise<void> {
    this.revokedSessions.add(sessionId);
    for (const [token, stored] of this.refreshTokens) {
      if (stored.sessionId === sessionId) this.refreshTokens.delete(token);
    }
  }

  async revokeAllSessions(userId: UserId): Promise<void> {
    for (const sessionId of this.sessionsByUser.get(userId) ?? []) {
      this.revokedSessions.add(sessionId);
    }
    for (const [token, stored] of this.refreshTokens) {
      if (stored.userId === userId) {
        this.revokedSessions.add(stored.sessionId);
        this.refreshTokens.delete(token);
      }
    }
  }

  /** Test helper. Not part of the port. */
  clear(): void {
    this.refreshTokens.clear();
    this.revokedSessions.clear();
    this.sessionsByUser.clear();
  }
}
