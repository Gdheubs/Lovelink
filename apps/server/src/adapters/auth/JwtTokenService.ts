import { jwtVerify, SignJWT } from 'jose';
import type { Clock } from '../../domain/ports/Clock.js';
import type { IdGenerator } from '../../domain/ports/IdGenerator.js';
import type { Logger } from '../../domain/ports/Logger.js';
import type { AccessClaims, TokenService } from '../../domain/ports/TokenService.js';
import type { UserId } from '../../domain/values/ids.js';
import { asUserId } from '../../domain/values/ids.js';
import { KEY, type RedisClient } from '../redis/client.js';

/**
 * ADAPTER: TokenService using JWT access tokens and Redis-backed refresh tokens.
 *
 * WHY THE TWO TOKENS HAVE COMPLETELY DIFFERENT DESIGNS
 * ----------------------------------------------------
 *   ACCESS  — a signed JWT. Stateless, so verifying it costs no I/O on the hot
 *             path (every request, every socket connect). Short-lived, because
 *             a stateless token cannot be un-issued.
 *
 *   REFRESH — an OPAQUE random string with a server-side record. Long-lived,
 *             and therefore it MUST be revocable: a ban that a refresh token
 *             can outlive is not a ban.
 *
 * A single "just use a long-lived JWT" design fails precisely at the moment it
 * matters, which is why the port defines them as separate operations.
 *
 * THE THREE FOOTGUNS THIS FILE EXISTS TO CONTAIN
 * ----------------------------------------------
 *  1. ALGORITHM CONFUSION. `jwtVerify` is called with an explicit
 *     `algorithms: ['HS256']`. Without it, a token claiming `alg: none` — or
 *     one signed with a different family — can be accepted. This is the classic
 *     JWT vulnerability and it is one missing option away.
 *  2. DECODE-WITHOUT-VERIFY. There is no `decode` anywhere in this file. Every
 *     path that reads claims has verified the signature first.
 *  3. TYPE CONFUSION. Access tokens carry `typ: 'access'` and it is CHECKED.
 *     Without it, a refresh token (which outlives every ban) presented as an
 *     access token would be accepted.
 *
 * ROTATION AND REPLAY DETECTION
 * -----------------------------
 * Refresh tokens are single-use. Presenting one twice means one of the two
 * presenters is not the legitimate user — so the whole session is revoked
 * rather than merely refusing the second call. The real user is logged out and
 * notices; a silent refusal would let the thief keep the session they stole.
 */

const ISSUER = 'loverlink';
const AUDIENCE = 'loverlink-app';
const ACCESS_TYPE = 'access';

/**
 * KEYS[1] = refresh record key
 * Returns: nil (unknown/expired) | {userId, sessionId, 'ok'} | {userId, sessionId, 'replay'}
 *
 * Atomic, because a stolen token racing the real one must produce exactly one
 * winner and one detected replay — a read-then-write would let both succeed.
 */
const ROTATE_SCRIPT = `
  local used = redis.call('HGET', KEYS[1], 'used')
  if not used then
    return nil
  end

  local userId = redis.call('HGET', KEYS[1], 'userId')
  local sessionId = redis.call('HGET', KEYS[1], 'sessionId')

  if used == '1' then
    return {userId, sessionId, 'replay'}
  end

  redis.call('HSET', KEYS[1], 'used', '1')
  return {userId, sessionId, 'ok'}
`;

export interface JwtTokenServiceOptions {
  readonly secret: string;
  readonly accessTtlSeconds: number;
  readonly refreshTtlSeconds: number;
}

export class JwtTokenService implements TokenService {
  private readonly key: Uint8Array;
  private readonly log: Logger;

  constructor(
    private readonly redis: RedisClient,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly options: JwtTokenServiceOptions,
    logger: Logger,
  ) {
    this.key = new TextEncoder().encode(options.secret);
    this.log = logger.child({ component: 'tokens' });
  }

  // -------------------------------------------------------------------------
  // Access tokens
  // -------------------------------------------------------------------------

  async issueAccessToken(
    userId: UserId,
    sessionId: string,
  ): Promise<{ token: string; expiresAt: Date }> {
    const issuedAtSec = Math.floor(this.clock.nowMs() / 1000);
    const expiresAtSec = issuedAtSec + this.options.accessTtlSeconds;

    // Recorded so revokeAllSessions can find every session for a user without
    // scanning the keyspace. TTL matches the refresh window, since a session
    // cannot outlive its refresh token.
    await this.redis
      .multi()
      .sadd(KEY.userSessions(userId), sessionId)
      .expire(KEY.userSessions(userId), this.options.refreshTtlSeconds)
      .exec();

    const token = await new SignJWT({ typ: ACCESS_TYPE, sid: sessionId })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(issuedAtSec)
      .setExpirationTime(expiresAtSec)
      .sign(this.key);

    return { token, expiresAt: new Date(expiresAtSec * 1000) };
  }

  async verifyAccessToken(token: string): Promise<AccessClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        // EXPLICIT. Omitting this is the algorithm-confusion vulnerability.
        algorithms: ['HS256'],
        issuer: ISSUER,
        audience: AUDIENCE,
        // Verify expiry against the INJECTED clock, so tests can advance time
        // and so a skewed process clock is at least consistent with the rest of
        // the application's notion of "now".
        currentDate: this.clock.now(),
      });

      // Type confusion guard. A refresh token has no `typ: 'access'`.
      if (payload.typ !== ACCESS_TYPE) return null;

      const userId = payload.sub;
      const sessionId = payload.sid;
      if (typeof userId !== 'string' || typeof sessionId !== 'string') return null;

      // The stateless token's one weakness: it cannot know it was revoked. A
      // single Redis GET closes the gap between "signed out" / "banned" and the
      // token's natural expiry.
      const revoked = await this.redis.exists(KEY.sessionRevoked(sessionId));
      if (revoked === 1) return null;

      const expSec = typeof payload.exp === 'number' ? payload.exp : 0;
      const iatSec = typeof payload.iat === 'number' ? payload.iat : 0;

      return {
        userId: asUserId(userId),
        sessionId,
        issuedAtMs: iatSec * 1000,
        expiresAtMs: expSec * 1000,
      };
    } catch {
      // Expired, malformed, wrong signature, wrong issuer. The port specifies a
      // null rather than an exception: an invalid token is an ordinary event on
      // a public endpoint, and throwing would fill the logs with stack traces
      // from bots.
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Refresh tokens
  // -------------------------------------------------------------------------

  async issueRefreshToken(
    userId: UserId,
    sessionId: string,
  ): Promise<{ token: string; expiresAt: Date }> {
    // Opaque and unguessable — 32 bytes from a CSPRNG. It carries no claims,
    // so there is nothing in it for an attacker to read or tamper with; its
    // only meaning is the server-side record.
    const token = this.ids.token(32);

    await this.redis
      .multi()
      .hset(KEY.refreshToken(token), { userId, sessionId, used: '0' })
      .expire(KEY.refreshToken(token), this.options.refreshTtlSeconds)
      .sadd(KEY.userSessions(userId), sessionId)
      .expire(KEY.userSessions(userId), this.options.refreshTtlSeconds)
      .exec();

    return {
      token,
      expiresAt: new Date(this.clock.nowMs() + this.options.refreshTtlSeconds * 1000),
    };
  }

  async rotateRefreshToken(token: string): Promise<{ userId: UserId; sessionId: string } | null> {
    const result = (await this.redis.eval(ROTATE_SCRIPT, 1, KEY.refreshToken(token))) as
      [string, string, string] | null;

    if (result === null) return null;

    const [userId, sessionId, outcome] = result;

    if (outcome === 'replay') {
      // Someone presented an already-rotated token. Either the real user's
      // token was stolen, or the thief's was. We cannot tell which — so we end
      // the session, which is safe in both readings and visible to the real
      // user.
      this.log.warn({ userId, sessionId }, 'refresh token replay detected; revoking session');
      await this.revokeSession(sessionId);
      return null;
    }

    // Revoked mid-flight (a ban landing between the rotate and now).
    const revoked = await this.redis.exists(KEY.sessionRevoked(sessionId));
    if (revoked === 1) return null;

    return { userId: asUserId(userId), sessionId };
  }

  // -------------------------------------------------------------------------
  // Revocation
  // -------------------------------------------------------------------------

  async revokeSession(sessionId: string): Promise<void> {
    // The tombstone must outlive any token that could reference it, or a
    // revoked session would quietly become valid again when the marker expired
    // before the credential did. Refresh TTL is the longer of the two.
    await this.redis.set(KEY.sessionRevoked(sessionId), '1', 'EX', this.options.refreshTtlSeconds);
  }

  async revokeAllSessions(userId: UserId): Promise<void> {
    const sessions = await this.redis.smembers(KEY.userSessions(userId));

    if (sessions.length === 0) return;

    const pipeline = this.redis.multi();
    for (const sessionId of sessions) {
      pipeline.set(KEY.sessionRevoked(sessionId), '1', 'EX', this.options.refreshTtlSeconds);
    }
    // The index itself goes too: these sessions are finished, and leaving the
    // set behind would make a later revoke-all re-tombstone dead ids forever.
    pipeline.del(KEY.userSessions(userId));
    await pipeline.exec();

    this.log.info({ userId, count: sessions.length }, 'revoked all sessions');
  }
}
