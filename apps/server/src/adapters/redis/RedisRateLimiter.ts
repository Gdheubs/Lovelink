import type { RateLimiter, RateLimitResult } from '../../domain/ports/RateLimiter.js';
import { KEY, type RedisClient } from './client.js';

/**
 * ADAPTER: RateLimiter over Redis.
 *
 * THE ATOMICITY REQUIREMENT
 * -------------------------
 * The port says `check` is atomic: two concurrent calls at the boundary must
 * not both succeed past the limit. The obvious implementation —
 * `GET`, compare, `SET` — is a read-modify-write and loses that race, which
 * matters because the race is exactly what an attacker creates by firing
 * requests in parallel.
 *
 * So the counter is incremented with a Lua script, which Redis runs atomically:
 * INCR, and set the TTL only on the first increment of a window. Doing the
 * EXPIRE as a separate command would leave a window where a crash between the
 * two produces a counter with NO expiry — a key that blocks that user forever.
 *
 * FIXED WINDOW, deliberately, matching the memory fake. It permits a burst of
 * up to 2x the limit across a window boundary; that is a known and accepted
 * property, documented in both implementations so nobody "fixes" only one.
 */

/**
 * KEYS[1] = counter key, ARGV[1] = window seconds.
 * Returns {count, ttlMs}. The TTL is set only when the counter was created, so
 * a window is not extended by continued hammering.
 */
const INCREMENT_SCRIPT = `
  local count = redis.call('INCR', KEYS[1])
  if count == 1 then
    redis.call('EXPIRE', KEYS[1], ARGV[1])
  end
  local ttl = redis.call('PTTL', KEYS[1])
  return {count, ttl}
`;

export class RedisRateLimiter implements RateLimiter {
  constructor(private readonly redis: RedisClient) {}

  async check(key: string, limit: number, windowSec: number): Promise<RateLimitResult> {
    const redisKey = KEY.rateLimit(key);

    const [count, ttlMs] = (await this.redis.eval(
      INCREMENT_SCRIPT,
      1,
      redisKey,
      String(windowSec),
    )) as [number, number];

    // PTTL returns -1 for a key with no expiry, which should be impossible
    // given the script above. Treating it as a full window is the safe reading:
    // it means the caller is told to back off rather than being let through.
    const resetAtMs = Date.now() + (ttlMs >= 0 ? ttlMs : windowSec * 1000);

    return {
      // The increment happens whether or not the call is allowed, matching
      // INCR semantics: a client that keeps hammering a blocked key does not
      // earn a free window by trying.
      allowed: count <= limit,
      remaining: Math.max(0, limit - count),
      resetAtMs,
    };
  }

  async reset(key: string): Promise<void> {
    await this.redis.del(KEY.rateLimit(key));
  }
}
