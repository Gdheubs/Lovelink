import type { Logger } from '../../domain/ports/Logger.js';
import type { OpenScheduledRooms } from '../../app/rooms/OpenScheduledRooms.js';

/**
 * ADAPTER: the thing that makes the sweep happen on time.
 *
 * WHY THIS IS AN ADAPTER AND NOT PART OF THE USE CASE
 * ---------------------------------------------------
 * `OpenScheduledRooms` answers "which rooms are due, and open them". This
 * answers "run that periodically, and stop cleanly" — which is a fact about
 * the runtime, not about the product, and involves `setTimeout`, process
 * signals and overlap protection. Keeping them apart is what lets the use case
 * be tested by calling it, with no clock to advance and no timer to fake.
 *
 * WHY A SELF-RESCHEDULING TIMEOUT AND NOT setInterval
 * ---------------------------------------------------
 * `setInterval` fires on a fixed cadence regardless of how long the work takes.
 * If a sweep ever runs slower than the interval — a slow query, a cold
 * connection pool — the callbacks pile up and overlap, and two overlapping
 * sweeps both see the same room as due. The compare-and-set inside the use case
 * means the room still opens only once, so this is a performance problem rather
 * than a correctness one, but it is one that gets worse exactly when the system
 * is already struggling.
 *
 * Scheduling the next run only after the previous one finishes makes overlap
 * structurally impossible.
 *
 * WHY THE INTERVAL IS A MINUTE
 * ----------------------------
 * A cron expression's finest resolution is one minute, so sweeping faster
 * cannot open anything sooner. Sweeping slower means a room advertised for
 * 22:00 opens at 22:04, which people notice.
 */

const SWEEP_INTERVAL_MS = 60_000;

/**
 * How long after a failure to try again.
 *
 * Shorter than the normal interval on purpose. The most likely cause of a
 * failed sweep is the database being briefly unavailable, and when it comes
 * back there may be a room already overdue — waiting a full minute would make a
 * blip into a visibly late room.
 */
const RETRY_INTERVAL_MS = 15_000;

export interface RoomScheduler {
  /** Stop sweeping. Waits for any sweep in flight, so shutdown is not a tear. */
  stop(): Promise<void>;
}

export function startRoomScheduler(deps: {
  openScheduledRooms: OpenScheduledRooms;
  logger: Logger;
}): RoomScheduler {
  const log = deps.logger.child({ component: 'scheduler' });

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopping = false;
  /** The sweep currently running, so `stop` can wait for it. */
  let inFlight: Promise<void> = Promise.resolve();

  const scheduleNext = (delayMs: number): void => {
    if (stopping) return;
    timer = setTimeout(() => void run(), delayMs);
    // Do not hold the process open for the sake of a sweep. Without this a
    // `node dist/main.js` that has finished everything else would sit waiting
    // for a timer nobody is watching.
    timer.unref?.();
  };

  const run = async (): Promise<void> => {
    if (stopping) return;

    inFlight = (async () => {
      try {
        const result = await deps.openScheduledRooms.execute();
        if (result.opened > 0) {
          log.debug({ opened: result.opened }, 'opened scheduled rooms');
        }
        scheduleNext(SWEEP_INTERVAL_MS);
      } catch (error) {
        // NEVER let this throw out of the timer. An unhandled rejection here
        // takes the whole process down, which would turn a transient database
        // blip into an outage — and the sweep is the least important thing
        // running.
        log.error({ err: String(error) }, 'scheduled room sweep failed; will retry');
        scheduleNext(RETRY_INTERVAL_MS);
      }
    })();

    await inFlight;
  };

  // The FIRST sweep runs almost immediately rather than after a full interval.
  //
  // This is the restart-survival path: a server coming back after being down
  // finds whatever it missed and opens it now, instead of leaving an overdue
  // room closed for another minute on top of however long the outage was.
  scheduleNext(1_000);

  log.info({ intervalMs: SWEEP_INTERVAL_MS }, 'room scheduler started');

  return {
    async stop(): Promise<void> {
      stopping = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      // Wait for a sweep already in flight. Cutting one off mid-way would not
      // corrupt anything — every write is a single atomic statement — but it
      // would leave a claimed occurrence unannounced, so the room opens with
      // nobody told.
      await inFlight;
      log.info({}, 'room scheduler stopped');
    },
  };
}
