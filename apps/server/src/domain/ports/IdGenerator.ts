/**
 * PORT: IdGenerator
 *
 * WHY THIS EXISTS
 * ---------------
 * Two reasons, and the second is the important one:
 *
 *  1. TESTABILITY — a sequential fake makes assertions readable
 *     (`expect(room.id).toBe('room-1')`) instead of matching UUID regexes.
 *
 *  2. SECURITY — surprise codes and session tokens must come from a
 *     CRYPTOGRAPHIC source. `Math.random()` is seeded predictably enough that a
 *     motivated person can enumerate codes, which is precisely the attack the
 *     original LoveLink page was open to (10 words x 9000 numbers, guessable).
 *     Making code generation a port means the insecure implementation lives in
 *     the test fake where it cannot reach production, and the real adapter can
 *     be audited in one place.
 *
 * INVARIANT: `randomCode` must be backed by a CSPRNG in every non-test
 * implementation, and must use an unambiguous alphabet (no O/0, I/1/l) because
 * these codes get read aloud and typed by hand.
 */
export interface IdGenerator {
  /** Opaque unique id for a persisted entity. UUIDv4/v7 in production. */
  uuid(): string;

  /**
   * A human-shareable claim code for a surprise, e.g. `LOVE7K2M`.
   * @param length number of random characters AFTER the theme word.
   */
  randomCode(length?: number): string;

  /** URL-safe random token for refresh tokens and magic links. */
  token(bytes?: number): string;
}

/**
 * The alphabet for human-typed codes.
 * Excludes I, L, O, U, 0, 1 — visually ambiguous when read off a phone screen,
 * and U is dropped so the generator cannot accidentally spell something rude.
 */
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
