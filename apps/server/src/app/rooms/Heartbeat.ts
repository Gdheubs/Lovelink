import type { Ports } from '../../domain/ports/index.js';
import type { RoomId, UserId } from '../../domain/values/ids.js';

/**
 * USE CASE: refresh a user's presence, and tell them where they have fallen out.
 *
 * THE PROBLEM THIS SOLVES IS ASYMMETRIC KNOWLEDGE
 * -----------------------------------------------
 * After a lapse, the client and the server disagree, and NEITHER can detect it
 * alone:
 *
 *   - the SERVER has expired and reaped the entry. As far as it is concerned
 *     this user is in no rooms at all, so it has nothing to report.
 *   - the CLIENT is still rendering the room, still showing the member list,
 *     and has no idea it has been dropped.
 *
 * An earlier version asked only the server ("which rooms is this user in?"),
 * which meant a lapsed room was invisible to the heartbeat by construction —
 * the one situation it most needed to catch.
 *
 * So the client OPTIONALLY names the rooms it believes it is in, and the server
 * answers for the union of both views. Anything the client claims but the
 * server cannot refresh comes back as stale, and the client re-joins.
 *
 * WHY TRUSTING THE CLIENT'S LIST IS SAFE HERE
 * -------------------------------------------
 * Because naming a room never CREATES presence. `heartbeat` refreshes an
 * existing live entry or reports failure; it has no path that inserts one. A
 * client claiming a room it was never in simply gets told that room is stale.
 * The list is a question, not an assertion — which is exactly the distinction
 * that makes it different from trusting a client-supplied role or identity.
 */
export interface HeartbeatInput {
  readonly userId: UserId;
  /**
   * Rooms the CLIENT believes it is in. Optional: an older client that sends
   * nothing still gets its known rooms refreshed, it just cannot be told about
   * a lapse it does not know to ask about.
   */
  readonly claimedRooms?: readonly RoomId[];
}

export interface HeartbeatResult {
  /** Rooms still live after the refresh. */
  readonly refreshed: readonly RoomId[];
  /** Rooms the client must re-join: it thinks it is there and it is not. */
  readonly staleRooms: readonly RoomId[];
}

/** A client claiming more rooms than this is malfunctioning or probing. */
const MAX_CLAIMED_ROOMS = 20;

export class Heartbeat {
  constructor(private readonly ports: Ports) {}

  async execute(input: HeartbeatInput): Promise<HeartbeatResult> {
    const { userId } = input;

    const known = await this.ports.presence.getRoomsForUser(userId);

    // Union of what the server knows and what the client claims. The server's
    // view catches rooms an old client forgot to name; the client's view is the
    // only thing that can surface a room the server has already forgotten.
    const claimed = (input.claimedRooms ?? []).slice(0, MAX_CLAIMED_ROOMS);
    const candidates = [...new Set<RoomId>([...known, ...claimed])];

    if (candidates.length === 0) {
      return { refreshed: [], staleRooms: [] };
    }

    // Concurrent: a user in three rooms should not pay three sequential round
    // trips on a path that runs every fifteen seconds for every connected user.
    const results = await Promise.all(
      candidates.map(async (roomId) => ({
        roomId,
        alive: await this.ports.presence.heartbeat(roomId, userId),
      })),
    );

    const refreshed = results.filter((r) => r.alive).map((r) => r.roomId);
    const staleRooms = results.filter((r) => !r.alive).map((r) => r.roomId);

    if (staleRooms.length > 0) {
      // Worth a log line: a pattern of these is the signal that
      // PRESENCE_TTL_SECONDS is tuned too tight for real mobile networks.
      this.ports.logger.debug({ userId, staleRooms }, 'heartbeat found lapsed presence');
    }

    return { refreshed, staleRooms };
  }
}
