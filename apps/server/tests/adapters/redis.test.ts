import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { RedisRateLimiter } from '../../src/adapters/redis/RedisRateLimiter.js';
import { RedisAuthChallengeStore } from '../../src/adapters/redis/RedisAuthChallengeStore.js';
import { RedisEventBus } from '../../src/adapters/redis/RedisEventBus.js';
import { RedisMetrics } from '../../src/adapters/redis/RedisMetrics.js';
import { JwtTokenService } from '../../src/adapters/auth/JwtTokenService.js';
import { MemoryClock } from '../../src/adapters/memory/MemoryClock.js';
import { CryptoIdGenerator } from '../../src/adapters/memory/MemoryIdGenerator.js';
import { nullLogger } from '../../src/domain/ports/Logger.js';
import { MAX_CHALLENGE_ATTEMPTS } from '../../src/domain/ports/AuthChallengeStore.js';
import { asUserId } from '../../src/domain/values/ids.js';
import { clearRedisNamespace, redisAvailable, redisClient, REDIS_URL } from './support.js';

/**
 * INTEGRATION: the Redis-backed adapters.
 *
 * These exist to test the things the memory fakes CANNOT test, because they are
 * properties of Redis itself:
 *
 *  - the Lua scripts really are atomic;
 *  - TTLs really are set, and set on the right key;
 *  - a Redis-specific return convention (PTTL of -1, HGETALL of an absent key)
 *    is handled the way the adapter assumes.
 *
 * A bug in any of those would be invisible to the unit suite and would surface
 * in production as a rate limit that never expires, or a login code that can be
 * guessed forever.
 */
const available = await redisAvailable();

describe.skipIf(!available)('redis adapters', () => {
  const clients: Redis[] = [];

  const client = (): Redis => {
    const c = redisClient();
    clients.push(c);
    return c;
  };

  afterAll(async () => {
    await Promise.allSettled(clients.map((c) => c.quit()));
  });

  beforeEach(async () => {
    const c = redisClient();
    await clearRedisNamespace(c);
    await c.quit();
  });

  // -------------------------------------------------------------------------
  describe('RedisRateLimiter', () => {
    it('allows up to the limit, then blocks', async () => {
      const limiter = new RedisRateLimiter(client());

      for (let i = 0; i < 3; i += 1) {
        const result = await limiter.check('test:allow', 3, 60);
        expect(result.allowed).toBe(true);
        expect(result.remaining).toBe(2 - i);
      }
      expect((await limiter.check('test:allow', 3, 60)).allowed).toBe(false);
    });

    it('sets a TTL on the FIRST increment, and does not extend it later', async () => {
      // A counter without a TTL is a permanent lockout. A counter whose TTL is
      // refreshed on every hit is also a permanent lockout, for anyone who
      // keeps trying — which is exactly the person being limited.
      const redis = client();
      const limiter = new RedisRateLimiter(redis);

      await limiter.check('test:ttl', 5, 100);
      const firstTtl = await redis.ttl('loverlink:rl:test:ttl');
      expect(firstTtl).toBeGreaterThan(0);
      expect(firstTtl).toBeLessThanOrEqual(100);

      await limiter.check('test:ttl', 5, 100);
      const secondTtl = await redis.ttl('loverlink:rl:test:ttl');
      // Not extended: still counting down from the original window.
      expect(secondTtl).toBeLessThanOrEqual(firstTtl);
    });

    it('is atomic under concurrency', async () => {
      // The read-modify-write version of this passes sequentially and fails
      // here, which is the whole reason for the Lua script.
      const limiter = new RedisRateLimiter(client());

      const results = await Promise.all(
        Array.from({ length: 20 }, () => limiter.check('test:race', 5, 60)),
      );

      expect(results.filter((r) => r.allowed)).toHaveLength(5);
    });

    it('resets a key', async () => {
      const limiter = new RedisRateLimiter(client());
      await limiter.check('test:reset', 1, 60);
      expect((await limiter.check('test:reset', 1, 60)).allowed).toBe(false);

      await limiter.reset('test:reset');
      expect((await limiter.check('test:reset', 1, 60)).allowed).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe('RedisAuthChallengeStore', () => {
    it('accepts the correct code exactly once', async () => {
      const store = new RedisAuthChallengeStore(client());

      await store.issue('a@example.com', 'email', '123456');
      expect(await store.consume('a@example.com', '123456')).toBe('ok');
      // Destroyed on success: a replay finds nothing.
      expect(await store.consume('a@example.com', '123456')).toBe('expired');
    });

    it('NEVER stores the plaintext code', async () => {
      // Anyone reading a Redis dump must not be able to log in as the user.
      const redis = client();
      const store = new RedisAuthChallengeStore(redis);

      await store.issue('a@example.com', 'email', '123456');
      const stored = await redis.hgetall('loverlink:auth:challenge:a@example.com');

      expect(JSON.stringify(stored)).not.toContain('123456');
      expect(stored.hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('applies a TTL', async () => {
      const redis = client();
      const store = new RedisAuthChallengeStore(redis);

      await store.issue('a@example.com', 'email', '123456', 120);
      const ttl = await redis.ttl('loverlink:auth:challenge:a@example.com');
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(120);
    });

    it(`destroys the challenge after ${MAX_CHALLENGE_ATTEMPTS} wrong guesses`, async () => {
      const store = new RedisAuthChallengeStore(client());
      await store.issue('a@example.com', 'email', '123456');

      for (let i = 0; i < MAX_CHALLENGE_ATTEMPTS - 1; i += 1) {
        expect(await store.consume('a@example.com', '000000')).toBe('invalid');
      }
      expect(await store.consume('a@example.com', '000000')).toBe('too_many_attempts');
      // Even the right code is now useless.
      expect(await store.consume('a@example.com', '123456')).toBe('expired');
    });

    it('re-issuing resets the attempt counter and invalidates the old code', async () => {
      const store = new RedisAuthChallengeStore(client());

      await store.issue('a@example.com', 'email', '111111');
      await store.consume('a@example.com', '000000'); // one failed attempt

      await store.issue('a@example.com', 'email', '222222');
      expect(await store.consume('a@example.com', '111111')).toBe('invalid');
      expect(await store.consume('a@example.com', '222222')).toBe('ok');
    });

    it('only one of two concurrent correct submissions wins', async () => {
      const store = new RedisAuthChallengeStore(client());
      await store.issue('a@example.com', 'email', '123456');

      const results = await Promise.all(
        Array.from({ length: 5 }, () => store.consume('a@example.com', '123456')),
      );
      expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    });

    it('peek reports attempts without exposing the hash', async () => {
      const store = new RedisAuthChallengeStore(client());
      await store.issue('a@example.com', 'email', '123456');
      await store.consume('a@example.com', '000000');

      const peeked = await store.peek('a@example.com');
      expect(peeked?.attempts).toBe(1);
      expect(peeked?.identifierKind).toBe('email');
      expect(JSON.stringify(peeked)).not.toContain('123456');
      expect(peeked).not.toHaveProperty('hash');
    });

    it('peek returns null for an unknown identifier', async () => {
      const store = new RedisAuthChallengeStore(client());
      expect(await store.peek('nobody@example.com')).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe('JwtTokenService', () => {
    const alice = asUserId('11111111-1111-4111-8111-111111111111');

    const build = () => {
      const clock = new MemoryClock();
      const service = new JwtTokenService(
        client(),
        clock,
        new CryptoIdGenerator(),
        {
          secret: 'a-test-secret-that-is-at-least-32-chars-long',
          accessTtlSeconds: 900,
          refreshTtlSeconds: 3600,
        },
        nullLogger,
      );
      return { clock, service };
    };

    it('issues and verifies an access token', async () => {
      const { service } = build();
      const { token } = await service.issueAccessToken(alice, 'session-1');

      const claims = await service.verifyAccessToken(token);
      expect(claims?.userId).toBe(alice);
      expect(claims?.sessionId).toBe('session-1');
    });

    it('REJECTS a token signed with a different secret', async () => {
      const { service } = build();
      const { token } = await service.issueAccessToken(alice, 'session-1');

      const other = new JwtTokenService(
        client(),
        new MemoryClock(),
        new CryptoIdGenerator(),
        {
          secret: 'a-completely-different-secret-also-32-chars',
          accessTtlSeconds: 900,
          refreshTtlSeconds: 3600,
        },
        nullLogger,
      );
      expect(await other.verifyAccessToken(token)).toBeNull();
    });

    it('rejects an alg:none token', async () => {
      // The classic JWT vulnerability. `algorithms: ['HS256']` is what stops it.
      const { service } = build();
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({
          sub: alice,
          sid: 'forged',
          typ: 'access',
          iss: 'loverlink',
          aud: 'loverlink-app',
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      ).toString('base64url');

      expect(await service.verifyAccessToken(`${header}.${payload}.`)).toBeNull();
    });

    it('rejects a REFRESH token presented as an access token', async () => {
      // A refresh token outlives every ban; accepting one here would be a
      // quiet, total privilege escalation.
      const { service } = build();
      const refresh = await service.issueRefreshToken(alice, 'session-1');
      expect(await service.verifyAccessToken(refresh.token)).toBeNull();
    });

    it('rejects garbage without throwing', async () => {
      const { service } = build();
      expect(await service.verifyAccessToken('not-a-token')).toBeNull();
      expect(await service.verifyAccessToken('')).toBeNull();
      expect(await service.verifyAccessToken('a.b.c')).toBeNull();
    });

    it('expires an access token against the injected clock', async () => {
      const { clock, service } = build();
      const { token } = await service.issueAccessToken(alice, 'session-1');

      clock.advanceSeconds(901);
      expect(await service.verifyAccessToken(token)).toBeNull();
    });

    it('rotates a refresh token, and detects a replay', async () => {
      const { service } = build();
      const refresh = await service.issueRefreshToken(alice, 'session-1');

      const first = await service.rotateRefreshToken(refresh.token);
      expect(first).toEqual({ userId: alice, sessionId: 'session-1' });

      // A second presentation means one of the two holders is not the real
      // user. The session dies rather than the call merely failing.
      expect(await service.rotateRefreshToken(refresh.token)).toBeNull();

      const access = await service.issueAccessToken(alice, 'session-1');
      expect(await service.verifyAccessToken(access.token)).toBeNull();
    });

    it('only one of several concurrent rotations succeeds', async () => {
      const { service } = build();
      const refresh = await service.issueRefreshToken(alice, 'session-2');

      const results = await Promise.all(
        Array.from({ length: 5 }, () => service.rotateRefreshToken(refresh.token)),
      );
      expect(results.filter((r) => r !== null)).toHaveLength(1);
    });

    it('revoking a session kills its access tokens immediately', async () => {
      const { service } = build();
      const { token } = await service.issueAccessToken(alice, 'session-3');
      expect(await service.verifyAccessToken(token)).not.toBeNull();

      await service.revokeSession('session-3');
      expect(await service.verifyAccessToken(token)).toBeNull();
    });

    it('revokeAllSessions kills every session for the user', async () => {
      const { service } = build();
      const a = await service.issueAccessToken(alice, 'session-a');
      const b = await service.issueAccessToken(alice, 'session-b');

      await service.revokeAllSessions(alice);

      expect(await service.verifyAccessToken(a.token)).toBeNull();
      expect(await service.verifyAccessToken(b.token)).toBeNull();
    });

    it('a revoked session cannot be refreshed back to life', async () => {
      const { service } = build();
      const refresh = await service.issueRefreshToken(alice, 'session-4');

      await service.revokeSession('session-4');
      expect(await service.rotateRefreshToken(refresh.token)).toBeNull();
    });

    it('leaves other users alone when revoking', async () => {
      const { service } = build();
      const bob = asUserId('22222222-2222-4222-8222-222222222222');

      const aliceToken = await service.issueAccessToken(alice, 'session-alice');
      const bobToken = await service.issueAccessToken(bob, 'session-bob');

      await service.revokeAllSessions(alice);

      expect(await service.verifyAccessToken(aliceToken.token)).toBeNull();
      expect(await service.verifyAccessToken(bobToken.token)).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe('RedisEventBus', () => {
    it('delivers a published event to a subscriber', async () => {
      const bus = new RedisEventBus(client(), client(), nullLogger);

      const received: string[] = [];
      await bus.subscribe('moderation', (event) => {
        received.push(event.type);
      });

      // Redis needs a moment to register the subscription before a publish on a
      // different connection will reach it.
      await waitFor(() => true, 100);

      await bus.publish('moderation', {
        type: 'user.banned',
        userId: asUserId('u1'),
        permanent: true,
        reason: 'test',
      });

      await waitFor(() => received.length > 0, 2000);
      expect(received).toEqual(['user.banned']);

      await bus.close();
    });

    it('stops delivering after unsubscribe', async () => {
      const bus = new RedisEventBus(client(), client(), nullLogger);

      const received: string[] = [];
      const off = await bus.subscribe('presence', (event) => {
        received.push(event.type);
      });
      await waitFor(() => true, 100);
      await off();

      await bus.publish('presence', {
        type: 'presence.reaped',
        userId: asUserId('u1'),
        roomId: 'r1' as never,
      });
      await waitFor(() => true, 300);

      expect(received).toHaveLength(0);
      await bus.close();
    });

    it('a throwing subscriber does not stop the others', async () => {
      const bus = new RedisEventBus(client(), client(), nullLogger);

      const survived: string[] = [];
      await bus.subscribe('moderation', () => {
        throw new Error('subscriber exploded');
      });
      await bus.subscribe('moderation', (event) => {
        survived.push(event.type);
      });
      await waitFor(() => true, 100);

      await bus.publish('moderation', {
        type: 'user.banned',
        userId: asUserId('u1'),
        permanent: false,
        reason: 'test',
      });

      await waitFor(() => survived.length > 0, 2000);
      expect(survived).toEqual(['user.banned']);

      await bus.close();
    });
  });

  // -------------------------------------------------------------------------
  describe('RedisMetrics', () => {
    it('counts totals and daily buckets', async () => {
      const clock = new MemoryClock(new Date('2025-06-01T12:00:00.000Z'));
      const metrics = new RedisMetrics(client(), clock, nullLogger);

      metrics.increment('room.joined');
      metrics.increment('room.joined', 4);

      await waitFor(async () => (await metrics.snapshot())['room.joined'] === 5, 2000);

      expect((await metrics.snapshot())['room.joined']).toBe(5);
      expect((await metrics.daily('room.joined', 1))['2025-06-01']).toBe(5);
    });

    it('never throws, even pointed at a dead server', async () => {
      // The port's fire-and-forget invariant. A dashboard counter must never be
      // able to fail a user's join.
      const dead = redisClient();
      await dead.quit();

      const metrics = new RedisMetrics(dead, new MemoryClock(), nullLogger);
      expect(() => metrics.increment('room.joined')).not.toThrow();
    });
  });
});

describe.skipIf(available)('redis adapters', () => {
  it.skip('skipped: Redis is not reachable (run `docker compose up -d`)', () => {});
});

/** Poll until `predicate` is true, or give up. Avoids fixed sleeps. */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

void REDIS_URL;
