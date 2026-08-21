import type { Clock } from '../../domain/ports/Clock.js';
import type { CounterName, Metrics } from '../../domain/ports/Metrics.js';

/**
 * ADAPTER (memory): counters in two Maps.
 *
 * Mirrors the Redis adapter's key layout — a lifetime total per counter plus a
 * `counter:YYYY-MM-DD` bucket per day — so the admin dashboard renders the same
 * shape in memory mode as in production.
 *
 * Per the port, `increment` never throws: a dashboard number is never worth
 * failing a user's action for.
 */
export class MemoryMetrics implements Metrics {
  private readonly totals = new Map<string, number>();
  private readonly byDay = new Map<string, number>();

  constructor(private readonly clock: Clock) {}

  private dayKey(name: string, at: Date): string {
    return `${name}:${at.toISOString().slice(0, 10)}`;
  }

  increment(name: CounterName, by = 1): void {
    try {
      this.totals.set(name, (this.totals.get(name) ?? 0) + by);
      const key = this.dayKey(name, this.clock.now());
      this.byDay.set(key, (this.byDay.get(key) ?? 0) + by);
    } catch {
      // Deliberately swallowed — see the port's fire-and-forget invariant.
    }
  }

  async snapshot(): Promise<Readonly<Record<string, number>>> {
    return Object.fromEntries(this.totals);
  }

  async daily(name: CounterName, days: number): Promise<Readonly<Record<string, number>>> {
    const out: Record<string, number> = {};
    const todayMs = this.clock.nowMs();
    for (let i = days - 1; i >= 0; i -= 1) {
      const day = new Date(todayMs - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      out[day] = this.byDay.get(`${name}:${day}`) ?? 0;
    }
    return out;
  }

  /** Test helper. Not part of the port. */
  clear(): void {
    this.totals.clear();
    this.byDay.clear();
  }
}
