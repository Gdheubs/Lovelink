import { createHash, timingSafeEqual } from 'node:crypto';
import type { IdentifierKind } from '../../domain/entities/User.js';
import type { AuthChallengeStore, Challenge } from '../../domain/ports/AuthChallengeStore.js';
import {
  CHALLENGE_TTL_SECONDS,
  MAX_CHALLENGE_ATTEMPTS,
} from '../../domain/ports/AuthChallengeStore.js';
import type { Clock } from '../../domain/ports/Clock.js';

interface StoredChallenge {
  identifier: string;
  identifierKind: IdentifierKind;
  codeHash: string;
  attempts: number;
  expiresAtMs: number;
}

/**
 * ADAPTER (memory): AuthChallengeStore.
 *
 * WHY THE FAKE STILL HASHES
 * -------------------------
 * Storing the plaintext code would be simpler and would make tests marginally
 * easier to write — and it would mean the memory path and the Redis path differ
 * in exactly the property that matters. A developer eyeballing this store
 * during `dev:memory` should not be able to read a stranger's login code, for
 * the same reason a Redis dump should not expose one.
 *
 * Comparison is `timingSafeEqual` over the hashes. The timing channel on a
 * 6-digit code is not a realistic attack, but doing it correctly here is free
 * and the alternative is a pattern that gets copied somewhere it does matter.
 *
 * All three port invariants are enforced: TTL, single-use atomic consume, and
 * destruction after MAX_CHALLENGE_ATTEMPTS.
 */
export class MemoryAuthChallengeStore implements AuthChallengeStore {
  private readonly challenges = new Map<string, StoredChallenge>();

  constructor(private readonly clock: Clock) {}

  private static hash(code: string): string {
    return createHash('sha256').update(code).digest('hex');
  }

  private static matches(storedHash: string, candidate: string): boolean {
    const a = Buffer.from(storedHash, 'hex');
    const b = Buffer.from(MemoryAuthChallengeStore.hash(candidate), 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async issue(
    identifier: string,
    identifierKind: IdentifierKind,
    code: string,
    ttlSeconds: number = CHALLENGE_TTL_SECONDS,
  ): Promise<void> {
    // REPLACES rather than stacks: requesting a new code invalidates the old
    // one, so resending does not widen the guessing surface.
    this.challenges.set(identifier, {
      identifier,
      identifierKind,
      codeHash: MemoryAuthChallengeStore.hash(code),
      attempts: 0,
      expiresAtMs: this.clock.nowMs() + ttlSeconds * 1000,
    });
  }

  async consume(
    identifier: string,
    code: string,
  ): Promise<'ok' | 'invalid' | 'expired' | 'too_many_attempts'> {
    const stored = this.challenges.get(identifier);
    if (stored === undefined) return 'expired';

    if (stored.expiresAtMs <= this.clock.nowMs()) {
      this.challenges.delete(identifier);
      return 'expired';
    }

    if (MemoryAuthChallengeStore.matches(stored.codeHash, code)) {
      // Single-use: destroyed on success, so a replayed code fails.
      this.challenges.delete(identifier);
      return 'ok';
    }

    stored.attempts += 1;
    if (stored.attempts >= MAX_CHALLENGE_ATTEMPTS) {
      this.challenges.delete(identifier);
      return 'too_many_attempts';
    }
    return 'invalid';
  }

  async peek(identifier: string): Promise<Challenge | null> {
    const stored = this.challenges.get(identifier);
    if (stored === undefined) return null;
    if (stored.expiresAtMs <= this.clock.nowMs()) return null;
    // Note the absent codeHash: even the diagnostic view does not leak it.
    return {
      identifier: stored.identifier,
      identifierKind: stored.identifierKind,
      attempts: stored.attempts,
      expiresAtMs: stored.expiresAtMs,
    };
  }

  async discard(identifier: string): Promise<void> {
    this.challenges.delete(identifier);
  }

  /** Test helper. Not part of the port. */
  clear(): void {
    this.challenges.clear();
  }
}
