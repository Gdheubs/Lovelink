/**
 * PORT: Metrics
 *
 * WHY THIS EXISTS
 * ---------------
 * The observability requirement is "count key events (joins, messages, reports)
 * for a basic admin dashboard". That is a counter store, and in production it
 * is Redis — but a use case that increments a Redis key directly cannot be
 * tested and cannot run in memory mode.
 *
 * Deliberately NOT a general-purpose metrics library. There are no histograms
 * or gauges here because the product does not yet need them, and a port should
 * describe what is actually required rather than everything a future might
 * want.
 *
 * INVARIANT: metrics are FIRE-AND-FORGET. An implementation must swallow its
 * own errors — a dashboard counter failing must never fail a user's join.
 */

/** The fixed counter catalogue. A closed set keeps the dashboard meaningful. */
export type CounterName =
  | 'user.registered'
  | 'user.login'
  | 'room.created'
  | 'room.joined'
  | 'room.left'
  | 'chat.message'
  | 'reaction.sent'
  | 'hand.raised'
  | 'speaker.promoted'
  | 'surprise.created'
  | 'surprise.redeemed'
  | 'dm.requested'
  | 'dm.opened'
  | 'dm.message'
  | 'call.invited'
  | 'call.accepted'
  | 'report.submitted'
  | 'report.resolved'
  | 'user.banned'
  | 'ratelimit.blocked'
  | 'error.domain'
  | 'error.unexpected';

export interface Metrics {
  /** Increment a counter. Never throws. */
  increment(name: CounterName, by?: number): void;

  /** Read the totals, for the admin dashboard. */
  snapshot(): Promise<Readonly<Record<string, number>>>;

  /**
   * Per-day totals for the last `days` days, keyed `YYYY-MM-DD`.
   * Enough for a sparkline; anything more is a real metrics system's job.
   */
  daily(name: CounterName, days: number): Promise<Readonly<Record<string, number>>>;
}

/** No-op implementation for tests. */
export const nullMetrics: Metrics = {
  increment: () => {},
  snapshot: async () => ({}),
  daily: async () => ({}),
};
