import type { Ports } from '../../domain/ports/index.js';
import type { UseCases } from '../../app/index.js';

/**
 * The ghost sweeper.
 *
 * WHY THIS EXISTS
 * ---------------
 * The hard part of presence is not joining, it is LEAVING. Phones lock, tunnels
 * collapse, browsers get killed by the OS, processes get OOM-killed — none of
 * which send a clean `room:leave`, and on mobile this is the MOST common way a
 * session ends, not an edge case.
 *
 * Without a sweeper, a room's member list accumulates people who are not there.
 * That is both a bad product (you think you are talking to twelve people and it
 * is three) and a safety problem (a host cannot moderate someone the system
 * believes is present).
 *
 * WHY IT DELEGATES TO THE LeaveRoom USE CASE
 * ------------------------------------------
 * An earlier version of this file did its own cleanup — emit `user:left`, close
 * the membership row, leave the channel. That was three of the four things
 * `LeaveRoom` does, and the missing fourth was crediting the session to the
 * trust ledger. The result was that everyone who left by timing out silently
 * never earned standing, while everyone who pressed the button did.
 *
 * That is the general hazard with a background job: it quietly becomes a second,
 * worse implementation of a path that already exists. So the reaper's only job
 * is DETECTION — it finds who lapsed and hands each one to the same use case
 * every other departure goes through.
 *
 * WHY A SWEEPER AND NOT PURE TTL
 * ------------------------------
 * A native Redis TTL would delete the key and tell nobody. The room would never
 * learn the person left; their name would just vanish from the next snapshot
 * while every connected client's member list stayed wrong. The expiry removes
 * the record; the sweep is what ANNOUNCES it.
 *
 * IDEMPOTENCE: `reapExpired` atomically claims what it returns, and `LeaveRoom`
 * guards on the durable row, so two overlapping sweeps — or a sweep racing a
 * real disconnect — cannot double-announce one departure.
 */
export interface PresenceReaperDeps {
  readonly ports: Ports;
  readonly useCases: UseCases;
  readonly intervalSeconds: number;
}

export function startPresenceReaper(deps: PresenceReaperDeps): () => void {
  const { ports, useCases, intervalSeconds } = deps;
  const log = ports.logger.child({ component: 'presence-reaper' });

  let running = false;

  const sweep = async (): Promise<void> => {
    // A slow sweep must not overlap itself. `reapExpired` is atomic, so this is
    // belt-and-braces — but a pile-up of overlapping sweeps under load is its
    // own problem regardless of correctness.
    if (running) return;
    running = true;

    try {
      const reaped = await ports.presence.reapExpired();
      if (reaped.length === 0) return;

      for (const entry of reaped) {
        // `reaped` rather than `disconnected` only so the logs distinguish
        // them. Both are voluntary departures and both earn session credit.
        await useCases.leaveRoom.execute({
          userId: entry.userId,
          roomId: entry.roomId,
          reason: 'reaped',
        });

        // Other processes may care — a future host-departure handler, for
        // instance. Published after the leave so subscribers see settled state.
        await ports.bus.publish('presence', {
          type: 'presence.reaped',
          userId: entry.userId,
          roomId: entry.roomId,
        });
      }

      log.info({ count: reaped.length }, 'reaped stale presence entries');
    } catch (error) {
      // A failed sweep must never kill the process: the next tick retries, and
      // the entries are still expired in the meantime.
      log.error({ err: String(error) }, 'presence sweep failed');
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void sweep(), intervalSeconds * 1000);
  // Do not hold the event loop open during shutdown.
  timer.unref();

  return () => clearInterval(timer);
}
