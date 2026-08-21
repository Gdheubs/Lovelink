import type { Clock } from '../../domain/ports/Clock.js';
import type { CounterName, Metrics } from '../../domain/ports/Metrics.js';
import type { Logger } from '../../domain/ports/Logger.js';
import { KEY, type RedisClient } from './client.js';

/** Daily buckets are kept for a quarter — enough for a trend, not a warehouse. */
const DAILY_TTL_SECONDS = 90 * 24 * 60 * 60;

/**
 * ADAPTER: Metrics over Redis.
 *
 * FIRE AND FORGET, ENFORCED
 * -------------------------
 * The port says `increment` never throws, and this implementation takes that
 * seriously: it is not `async`, it does not return a promise the caller could
 * await, and every failure path is swallowed with only a debug log.
 *
 * The reason is worth stating plainly. `increment('room.joined')` sits inside
 * JoinRoom. If a dashboard counter could fail a join, then a Redis hiccup would
 * stop people entering rooms — trading the product's core function for a number
 * nobody is looking at right now. A metric is never worth a user's action.
 *
 * Two keys per counter, matching the memory fake so the admin dashboard renders
 * identically in either mode: a lifetime total, and a per-day bucket with a TTL.
 */
export class RedisMetrics implements Metrics {
  private readonly log: Logger;

  constructor(
    private readonly redis: RedisClient,
    private readonly clock: Clock,
    logger: Logger,
  ) {
    this.log = logger.child({ component: 'metrics' });
  }

  private today(): string {
    return this.clock.now().toISOString().slice(0, 10);
  }

  increment(name: CounterName, by = 1): void {
    const day = this.today();

    // Deliberately not awaited. `void` plus a catch means an unreachable Redis
    // produces a debug line, not an unhandled rejection that kills the process.
    void this.redis
      .multi()
      .incrby(KEY.metricTotal(name), by)
      .incrby(KEY.metricDaily(name, day), by)
      .expire(KEY.metricDaily(name, day), DAILY_TTL_SECONDS)
      .exec()
      .catch((error: unknown) => {
        this.log.debug({ name, err: String(error) }, 'metric increment failed (ignored)');
      });
  }

  async snapshot(): Promise<Readonly<Record<string, number>>> {
    // SCAN, never KEYS: KEYS blocks the whole Redis server while it walks the
    // keyspace, which on a shared instance is an outage caused by loading an
    // admin page.
    const totals: Record<string, number> = {};
    const prefix = KEY.metricTotal('');

    let cursor = '0';
    do {
      const [next, keys]: [string, string[]] = await this.redis.scan(
        cursor,
        'MATCH',
        `${prefix}*`,
        'COUNT',
        200,
      );
      cursor = next;

      if (keys.length > 0) {
        const values = await this.redis.mget(...keys);
        keys.forEach((key, index) => {
          totals[key.slice(prefix.length)] = Number.parseInt(values[index] ?? '0', 10);
        });
      }
    } while (cursor !== '0');

    return totals;
  }

  async daily(name: CounterName, days: number): Promise<Readonly<Record<string, number>>> {
    const dayKeys: string[] = [];
    const nowMs = this.clock.nowMs();

    for (let i = days - 1; i >= 0; i -= 1) {
      dayKeys.push(new Date(nowMs - i * 86_400_000).toISOString().slice(0, 10));
    }

    const values = await this.redis.mget(...dayKeys.map((day) => KEY.metricDaily(name, day)));

    const out: Record<string, number> = {};
    dayKeys.forEach((day, index) => {
      out[day] = Number.parseInt(values[index] ?? '0', 10);
    });
    return out;
  }
}
