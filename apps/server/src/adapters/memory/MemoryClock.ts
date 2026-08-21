import type { Clock } from '../../domain/ports/Clock.js';

/**
 * ADAPTER (memory): a Clock you control.
 *
 * WHY: every time-dependent rule in the system — the 18+ boundary on someone's
 * exact birthday, surprise expiry, presence TTL, rate-limit windows, refresh
 * token rotation — is tested by moving this forward, not by sleeping. A test
 * suite that sleeps is a test suite people stop running.
 */
export class MemoryClock implements Clock {
  private current: number;

  /** Default is a fixed, memorable instant so failures are reproducible. */
  constructor(start: Date | number = new Date('2025-06-01T12:00:00.000Z')) {
    this.current = typeof start === 'number' ? start : start.getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  nowMs(): number {
    return this.current;
  }

  /** Move time forward. Negative values are rejected: time does not go back. */
  advanceMs(ms: number): void {
    if (ms < 0) throw new Error('MemoryClock cannot move backwards.');
    this.current += ms;
  }

  advanceSeconds(seconds: number): void {
    this.advanceMs(seconds * 1000);
  }

  advanceDays(days: number): void {
    this.advanceMs(days * 24 * 60 * 60 * 1000);
  }

  /** Jump to an absolute instant, e.g. to a specific birthday. */
  set(at: Date): void {
    this.current = at.getTime();
  }
}
