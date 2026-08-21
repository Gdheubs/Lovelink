import { randomBytes, randomUUID } from 'node:crypto';
import type { IdGenerator } from '../../domain/ports/IdGenerator.js';
import { CODE_ALPHABET } from '../../domain/ports/IdGenerator.js';

/**
 * ADAPTER (memory): deterministic, sequential ids for tests.
 *
 * WHY: `expect(room.id).toBe('room-1')` is a readable assertion; matching a
 * UUID regex is not. Determinism also makes a failing test reproduce exactly
 * rather than "sometimes".
 *
 * NOT FOR PRODUCTION. Codes from this generator are guessable by design; the
 * crypto-backed CryptoIdGenerator below is what the composition root wires up
 * outside tests, and the two are kept in the same directory so that the
 * difference is impossible to miss.
 */
export class MemoryIdGenerator implements IdGenerator {
  private counter = 0;

  constructor(private readonly prefix = 'id') {}

  uuid(): string {
    this.counter += 1;
    return `${this.prefix}-${this.counter}`;
  }

  randomCode(length = 6): string {
    this.counter += 1;
    const suffix = String(this.counter).padStart(length, '0');
    return suffix.slice(-length);
  }

  token(bytes = 32): string {
    this.counter += 1;
    return `token-${this.counter}-${bytes}`;
  }

  /** Reset between tests so ids restart at 1. */
  reset(): void {
    this.counter = 0;
  }
}

/**
 * ADAPTER: the real generator. Lives here rather than in its own directory
 * because it has no vendor dependency — only `node:crypto`.
 *
 * INVARIANT (from the port): `randomCode` uses a CSPRNG and an unambiguous
 * alphabet. `randomBytes` is rejection-free here because CODE_ALPHABET has 30
 * characters and we take the byte modulo 30 — a negligible bias over a 6
 * character code, but noted so nobody "fixes" it into something worse.
 */
export class CryptoIdGenerator implements IdGenerator {
  uuid(): string {
    return randomUUID();
  }

  randomCode(length = 6): string {
    const bytes = randomBytes(length);
    let out = '';
    for (let i = 0; i < length; i += 1) {
      out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
    }
    return out;
  }

  token(bytes = 32): string {
    return randomBytes(bytes).toString('base64url');
  }
}
