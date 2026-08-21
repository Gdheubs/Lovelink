import { createHash, timingSafeEqual } from 'node:crypto';
import type { IdentifierKind } from '../../domain/entities/User.js';
import type { AuthChallengeStore, Challenge } from '../../domain/ports/AuthChallengeStore.js';
import {
  CHALLENGE_TTL_SECONDS,
  MAX_CHALLENGE_ATTEMPTS,
} from '../../domain/ports/AuthChallengeStore.js';
import { KEY, type RedisClient } from './client.js';

/**
 * ADAPTER: AuthChallengeStore over Redis.
 *
 * WHY A LUA SCRIPT FOR `consume`
 * ------------------------------
 * The port requires single-use, atomic consumption with a bounded attempt
 * count. Done as separate commands — HGETALL, compare in Node, then either DEL
 * or HINCRBY — two concurrent submissions of the same correct code would both
 * read "unused" and both succeed. A leaked code would then remain useful for as
 * long as an attacker could keep racing.
 *
 * The script below does the comparison, the attempt increment, and the deletion
 * in one indivisible step.
 *
 * WHY THE HASH AND NOT THE CODE
 * -----------------------------
 * Anyone who can read a Redis dump, a slowlog entry, or a MONITOR stream must
 * not be able to log in as the user. The stored value is SHA-256 of the code;
 * the comparison happens over hashes.
 *
 * Note the script compares hashes with `==`, which is not constant-time. That
 * is acceptable *here* specifically because both sides are already hashes:
 * learning how many leading bytes of a SHA-256 digest matched reveals nothing
 * usable about a 6-digit code, and the attempt counter caps guessing at five.
 * `peek` uses `timingSafeEqual` where it compares in Node.
 */

/**
 * KEYS[1] = challenge hash key
 * ARGV[1] = candidate code hash
 * ARGV[2] = max attempts
 *
 * Returns: 'ok' | 'invalid' | 'expired' | 'too_many_attempts'
 */
const CONSUME_SCRIPT = `
  local stored = redis.call('HGET', KEYS[1], 'hash')
  if not stored then
    return 'expired'
  end

  if stored == ARGV[1] then
    redis.call('DEL', KEYS[1])
    return 'ok'
  end

  local attempts = redis.call('HINCRBY', KEYS[1], 'attempts', 1)
  if attempts >= tonumber(ARGV[2]) then
    redis.call('DEL', KEYS[1])
    return 'too_many_attempts'
  end

  return 'invalid'
`;

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

interface ChallengeHash {
  hash?: string;
  kind?: string;
  attempts?: string;
}

export class RedisAuthChallengeStore implements AuthChallengeStore {
  constructor(private readonly redis: RedisClient) {}

  async issue(
    identifier: string,
    identifierKind: IdentifierKind,
    code: string,
    ttlSeconds: number = CHALLENGE_TTL_SECONDS,
  ): Promise<void> {
    const key = KEY.challenge(identifier);

    // A pipeline, not a transaction: these two commands target one key and the
    // only ordering that matters is that the TTL follows the write. DEL first
    // resets the attempt counter, so requesting a new code genuinely REPLACES
    // the old challenge rather than inheriting its used-up attempts.
    await this.redis
      .multi()
      .del(key)
      .hset(key, { hash: hashCode(code), kind: identifierKind, attempts: '0' })
      .expire(key, ttlSeconds)
      .exec();
  }

  async consume(
    identifier: string,
    code: string,
  ): Promise<'ok' | 'invalid' | 'expired' | 'too_many_attempts'> {
    const result = (await this.redis.eval(
      CONSUME_SCRIPT,
      1,
      KEY.challenge(identifier),
      hashCode(code),
      String(MAX_CHALLENGE_ATTEMPTS),
    )) as string;

    // The script only ever returns one of these four; the default is a
    // belt-and-braces guard against a future edit, and it fails CLOSED.
    switch (result) {
      case 'ok':
      case 'invalid':
      case 'expired':
      case 'too_many_attempts':
        return result;
      default:
        return 'invalid';
    }
  }

  async peek(identifier: string): Promise<Challenge | null> {
    const key = KEY.challenge(identifier);
    const [data, ttlMs] = await Promise.all([
      this.redis.hgetall(key) as Promise<ChallengeHash>,
      this.redis.pttl(key),
    ]);

    if (data.hash === undefined) return null;

    // Note the absent hash in the returned shape: even the diagnostic view
    // does not carry it.
    return {
      identifier,
      identifierKind: (data.kind ?? 'email') as IdentifierKind,
      attempts: Number.parseInt(data.attempts ?? '0', 10),
      expiresAtMs: Date.now() + Math.max(0, ttlMs),
    };
  }

  async discard(identifier: string): Promise<void> {
    await this.redis.del(KEY.challenge(identifier));
  }
}

/**
 * Constant-time hash comparison.
 *
 * Not used by `consume` (the Lua script compares server-side), but exported so
 * that any future in-Node comparison uses it rather than `===`. Kept next to
 * the hashing so the two cannot drift apart.
 */
export function hashesMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}
