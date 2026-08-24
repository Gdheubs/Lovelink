import type { RoomPulseStore } from '../../domain/ports/RoomPulseStore.js';
import type { RoomFeeling } from '../../domain/values/roomFeeling.js';
import type { Clock } from '../../domain/ports/Clock.js';
import type { RoomId, UserId } from '../../domain/values/ids.js';

/**
 * ADAPTER (memory): room pulse.
 *
 * Mirrors the Redis shape exactly — a map per room keyed by user, with one
 * expiry for the whole room — including the small imprecision that the window
 * is refreshed by any vote. A fake that expired each vote individually would be
 * MORE correct than production, which is its own kind of bug: it would hide the
 * behaviour a test is supposed to be describing.
 */
export class MemoryRoomPulseStore implements RoomPulseStore {
  private readonly rooms = new Map<string, { votes: Map<string, RoomFeeling>; expiresAtMs: number }>();

  constructor(private readonly clock: Clock) {}

  async vote(
    roomId: RoomId,
    userId: UserId,
    feeling: RoomFeeling,
    windowSeconds: number,
  ): Promise<void> {
    const existing = this.live(roomId);
    const votes = existing?.votes ?? new Map<string, RoomFeeling>();

    // A second vote overwrites the first, which is what makes one-vote-per-
    // person a property of the structure rather than a check.
    votes.set(userId, feeling);

    this.rooms.set(roomId, {
      votes,
      expiresAtMs: this.clock.nowMs() + windowSeconds * 1000,
    });
  }

  async currentVotes(roomId: RoomId): Promise<readonly RoomFeeling[]> {
    return [...(this.live(roomId)?.votes.values() ?? [])];
  }

  async voteOf(roomId: RoomId, userId: UserId): Promise<RoomFeeling | null> {
    return this.live(roomId)?.votes.get(userId) ?? null;
  }

  async clear(roomId: RoomId): Promise<void> {
    this.rooms.delete(roomId);
  }

  /** The room's votes if they have not expired. Checked on read, as Redis does. */
  private live(roomId: RoomId): { votes: Map<string, RoomFeeling>; expiresAtMs: number } | null {
    const entry = this.rooms.get(roomId);
    if (entry === undefined) return null;

    if (entry.expiresAtMs <= this.clock.nowMs()) {
      this.rooms.delete(roomId);
      return null;
    }
    return entry;
  }

  /** Test helper. Not part of the port. */
  clearAll(): void {
    this.rooms.clear();
  }
}
