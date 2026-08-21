import type { Ports } from '../../domain/ports/index.js';

/**
 * The ghost sweeper.
 *
 * WHY THIS EXISTS
 * ---------------
 * The hard part of presence is not joining, it is LEAVING. Phones lock, tunnels
 * collapse, browsers get killed by the OS, processes get OOM-killed — none of
 * which send a clean `room:leave`. Without a sweeper, a room's member list
 * accumulates people who are not there, which is both a bad product (you think
 * you are talking to twelve people and it is three) and a safety problem (a
 * host cannot moderate someone the system believes is present).
 *
 * HOW IT WORKS
 * ------------
 * PresenceStore entries expire unless refreshed by `presence:heartbeat`. This
 * loop asks the store which entries have lapsed and, for each, emits the
 * `user:left` that the vanished client never sent — so the rest of the room
 * sees them go.
 *
 * WHY A SWEEPER AND NOT PURE TTL
 * ------------------------------
 * TTL alone would make the entry disappear silently. Nobody would be told, and
 * every client's member list would drift until its next full snapshot. The
 * expiry removes the record; the sweep announces it.
 *
 * IDEMPOTENCE: `reapExpired` removes what it returns, so two overlapping sweeps
 * cannot double-announce the same departure.
 */
export interface PresenceReaperDeps {
  readonly ports: Ports;
  readonly intervalSeconds: number;
}

export function startPresenceReaper(deps: PresenceReaperDeps): () => void {
  const { ports, intervalSeconds } = deps;
  const log = ports.logger.child({ component: 'presence-reaper' });

  let running = false;

  const sweep = async (): Promise<void> => {
    // A slow sweep must not overlap itself: two concurrent passes would fight
    // over the same entries and produce duplicate `user:left` events.
    if (running) return;
    running = true;

    try {
      const reaped = await ports.presence.reapExpired();
      if (reaped.length === 0) return;

      for (const entry of reaped) {
        await ports.realtime.emitToRoom(entry.roomId, 'user:left', {
          roomId: entry.roomId,
          userId: entry.userId,
        });
        await ports.realtime.leaveRoomChannel(entry.userId, entry.roomId);

        // Close the durable membership row too, so `haveSharedRoomSession`
        // sees a finite interval rather than one that never ends.
        await ports.rooms.recordLeave(entry.roomId, entry.userId, ports.clock.now());

        // Other processes may care (e.g. a host-departure handler).
        await ports.bus.publish('presence', {
          type: 'presence.reaped',
          userId: entry.userId,
          roomId: entry.roomId,
        });

        ports.metrics.increment('room.left');
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
