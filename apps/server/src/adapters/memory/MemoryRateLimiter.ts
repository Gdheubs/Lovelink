import type { Clock } from '../../domain/ports/Clock.js';
import type { RateLimiter, RateLimitResult } from '../../domain/ports/RateLimiter.js';

interface Window {
  count: number;
  resetAtMs: number;
}

/**
 * ADAPTER (memory): fixed-window rate limiter.
 *
 * WHY FIXED WINDOW AND NOT SOMETHING CLEVERER
 * -------------------------------------------
 * It matches what the Redis adapter does (INCR + EXPIRE), and a fake that is
 * more forgiving OR stricter than production produces tests that lie. Fixed
 * windows allow a burst of up to 2x the limit across a window boundary; that is
 * a known and accepted property, documented here so nobody discovers it as a
 * surprise and "fixes" only one of the two implementations.
 *
 * Time comes from the injected Clock, so a test can prove that a limit resets
 * by advancing time rather than by waiting for it.
 */
export class MemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, Window>();

  /** When true, every check passes. For tests that are not about limiting. */
  disabled = false;

  constructor(private readonly clock: Clock) {}

  async check(key: string, limit: number, windowSec: number): Promise<RateLimitResult> {
    const now = this.clock.nowMs();

    if (this.disabled) {
      return { allowed: true, remaining: limit, resetAtMs: now + windowSec * 1000 };
    }

    const existing = this.windows.get(key);

    if (existing === undefined || existing.resetAtMs <= now) {
      const fresh: Window = { count: 1, resetAtMs: now + windowSec * 1000 };
      this.windows.set(key, fresh);
      return { allowed: true, remaining: limit - 1, resetAtMs: fresh.resetAtMs };
    }

    // The consume happens whether or not it is allowed, matching INCR: a client
    // that keeps hammering a blocked key does not get a free window by trying.
    existing.count += 1;
    const allowed = existing.count <= limit;
    return {
      allowed,
      remaining: Math.max(0, limit - existing.count),
      resetAtMs: existing.resetAtMs,
    };
  }

  async reset(key: string): Promise<void> {
    this.windows.delete(key);
  }

  /** Test helper. Not part of the port. */
  clear(): void {
    this.windows.clear();
  }
}
