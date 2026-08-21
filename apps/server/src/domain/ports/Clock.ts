/**
 * PORT: Clock
 *
 * WHY THIS EXISTS
 * ---------------
 * `new Date()` inside a use case makes that use case untestable in every way
 * that matters: you cannot test the 18+ boundary on someone's exact birthday,
 * you cannot test that a surprise expires, and you cannot test a rate-limit
 * window without sleeping. Injecting time turns all of those into arithmetic.
 *
 * INVARIANT: nothing in /src/domain or /src/app calls `Date.now()` or
 * `new Date()` directly. If you need "now", take a Clock.
 */
export interface Clock {
  now(): Date;
  /** Milliseconds since epoch. Convenience for TTL arithmetic. */
  nowMs(): number;
}

/** The production implementation. Trivial, but it belongs behind the port. */
export const systemClock: Clock = {
  now: () => new Date(),
  nowMs: () => Date.now(),
};
