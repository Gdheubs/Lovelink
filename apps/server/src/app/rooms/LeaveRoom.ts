import type { Ports } from '../../domain/ports/index.js';
import type { RoomId, UserId } from '../../domain/values/ids.js';
import { TRUST_DELTAS } from '../../domain/values/trust.js';

/**
 * USE CASE: leave a room.
 *
 * WHY IT TAKES A UserId AND NOT A User
 * ------------------------------------
 * Unlike every other use case here, this one is invoked on behalf of someone
 * who may no longer be reachable — by the presence reaper, on socket
 * disconnect, and on ban enforcement. Requiring a loaded `User` would mean a
 * database read on a path that runs for every dropped connection, and would
 * fail outright for a deleted account whose room we still need to clean up.
 *
 * THE FOUR WAYS SOMEONE LEAVES, AND WHY THEY ALL COME HERE
 * --------------------------------------------------------
 *   1. `room:leave`        they pressed the button
 *   2. socket `disconnect` they closed the tab (the common case)
 *   3. the presence reaper their phone locked and the TTL lapsed (the MOST
 *                          common case on mobile)
 *   4. a kick or a ban     a moderator removed them
 *
 * All four converge here. An earlier version had the reaper do its own partial
 * cleanup, which meant anyone who left by timing out — most mobile users —
 * silently never received session credit toward their trust standing. Routing
 * every path through one use case is what stops that class of divergence.
 *
 * IDEMPOTENCE, AND WHY THE GUARD IS THE DURABLE ROW
 * -------------------------------------------------
 * Paths 1 and 2 routinely fire together for one departure, and 3 can overlap
 * either. Exactly one of them must announce `user:left`, or the room watches
 * the same person leave three times.
 *
 * The guard is `recordLeave`, which reports whether IT closed an open
 * membership row — an atomic compare-and-set in Postgres. Presence cannot serve
 * as the guard, because the reaper has already cleared it by the time it calls
 * us: using presence would make every reaped departure silent, which is the
 * exact opposite of what the reaper exists to do.
 */
export interface LeaveRoomInput {
  readonly userId: UserId;
  readonly roomId: RoomId;
  /**
   * Why they left. Only a voluntary departure earns trust credit — being
   * kicked or banned should not.
   */
  readonly reason?: 'left' | 'disconnected' | 'reaped' | 'kicked' | 'banned';
}

/**
 * A session shorter than this does not count as "showing up".
 *
 * Without a floor, join/leave churn is a trust-farming loop: a script could
 * bounce in and out of a room to accumulate standing and unlock DM rights.
 */
export const MIN_SESSION_MS = 60_000;

/** Departures that reflect the user choosing to be there. */
const CREDITED_REASONS = new Set(['left', 'disconnected', 'reaped']);

export class LeaveRoom {
  constructor(private readonly ports: Ports) {}

  async execute(input: LeaveRoomInput): Promise<void> {
    const { userId, roomId, reason = 'left' } = input;

    // Read the open row BEFORE closing it — `joinedAt` is needed to decide
    // whether the session was long enough to count.
    const membership = await this.ports.rooms.findMembership(roomId, userId);

    // Cheap and idempotent; safe to run even when another path got here first.
    await this.ports.presence.setOffline(roomId, userId);
    await this.ports.realtime.leaveRoomChannel(userId, roomId);

    const now = this.ports.clock.now();
    const closedByThisCall = await this.ports.rooms.recordLeave(roomId, userId, now);

    // Another path already handled this departure and already announced it.
    if (!closedByThisCall) return;

    await this.ports.realtime.emitToRoom(roomId, 'user:left', { roomId, userId });
    this.ports.metrics.increment('room.left');

    if (CREDITED_REASONS.has(reason)) {
      await this.creditSession(userId, membership?.joinedAt ?? null, now);
    }

    this.ports.logger.info({ roomId, userId, reason }, 'user left room');
  }

  /**
   * Credit a completed room session to the trust ledger.
   *
   * Best-effort: a failure here must not fail the departure. Someone whose
   * trust event was lost is mildly under-credited; someone stuck in a room they
   * tried to leave is a bug report.
   */
  private async creditSession(userId: UserId, joinedAt: Date | null, leftAt: Date): Promise<void> {
    if (joinedAt === null) return;
    if (leftAt.getTime() - joinedAt.getTime() < MIN_SESSION_MS) return;

    try {
      await this.ports.users.appendTrustEvent({
        userId,
        delta: TRUST_DELTAS.room_session_completed,
        reason: 'room_session_completed',
        context: null,
        createdAt: leftAt,
      });
    } catch (error) {
      this.ports.logger.warn(
        { userId, err: String(error) },
        'could not credit room session to the trust ledger',
      );
    }
  }
}
