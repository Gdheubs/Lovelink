import type { Ports } from '../../domain/ports/index.js';
import type { CounterName } from '../../domain/ports/Metrics.js';

/**
 * USE CASE: the numbers on the admin dashboard.
 *
 * WHAT THIS IS FOR
 * ----------------
 * One question, asked at 3am when something feels wrong: IS THE PRODUCT
 * WORKING? Not "how is growth" — that is a different tool and a different day.
 * The numbers here are chosen so that a person who has just been woken up can
 * tell within a few seconds whether people are in rooms, whether anyone can
 * sign in, and whether the safety queue is being kept up with.
 *
 * WHY LIVE AND CUMULATIVE ARE SEPARATED
 * -------------------------------------
 * "412 rooms joined" and "6 people in rooms right now" answer completely
 * different questions, and putting them in one list is how a dashboard starts
 * lying. The first is a counter since the beginning of time; the second is a
 * fact about this instant, and it is the one that tells you the product is up.
 *
 * WHY `users` AND `entries` ARE BOTH SHOWN
 * ----------------------------------------
 * One person sitting in two rooms is two entries and one user. Reporting only
 * entries overstates the audience — and on a night when a handful of people are
 * each in three rooms, it overstates it enormously.
 *
 * NOT AUTHORIZATION. The route decides who may see this. This use case assumes
 * the caller has already been established as a moderator.
 */

/** The counters worth a sparkline. Deliberately few. */
const TRENDED: readonly CounterName[] = Object.freeze([
  'user.registered',
  'room.joined',
  'chat.message',
  'report.submitted',
]);

const TREND_DAYS = 14;

export interface DashboardView {
  /** True right now, from presence. The "is it up" number. */
  readonly live: {
    readonly usersInRooms: number;
    readonly roomEntries: number;
    readonly activeRooms: number;
  };
  /** The safety backlog. The number that means a person is waiting. */
  readonly safety: {
    readonly openReports: number;
    readonly underReview: number;
  };
  /** Cumulative counters since the beginning. */
  readonly totals: Readonly<Record<string, number>>;
  /** Per-day series for a small number of counters, oldest key first. */
  readonly trends: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly generatedAt: string;
}

export class GetDashboard {
  constructor(private readonly ports: Ports) {}

  async execute(): Promise<DashboardView> {
    // Every read is independent, so they go together. A dashboard that takes
    // four sequential round trips is one people stop opening.
    const [live, totals, openReports, underReview, trendEntries] = await Promise.all([
      this.ports.presence.countLive(),
      this.ports.metrics.snapshot(),
      this.ports.reports.countByStatus('open'),
      this.ports.reports.countByStatus('reviewing'),
      Promise.all(
        TRENDED.map(async (name) => [name, await this.ports.metrics.daily(name, TREND_DAYS)] as const),
      ),
    ]);

    return {
      live: {
        usersInRooms: live.users,
        roomEntries: live.entries,
        activeRooms: live.rooms,
      },
      safety: { openReports, underReview },
      totals,
      trends: Object.fromEntries(trendEntries),
      generatedAt: this.ports.clock.now().toISOString(),
    };
  }
}
