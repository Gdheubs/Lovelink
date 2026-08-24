import type { AvailabilityStore } from '../../domain/ports/AvailabilityStore.js';
import type { Availability, Intent } from '../../domain/values/presenceIntent.js';
import { CLOSED } from '../../domain/values/presenceIntent.js';
import type { Clock } from '../../domain/ports/Clock.js';
import type { UserId } from '../../domain/values/ids.js';

/**
 * ADAPTER (memory): tonight's intent and open door.
 *
 * IT MODELS EXPIRY, which is the whole reason this port exists. A fake that
 * stored the values forever would let a caller forget that they lapse — and
 * "the door is still open eight hours later" is precisely the bug the real
 * implementation is designed to make impossible.
 *
 * Expiry is checked on READ rather than swept, matching Redis: a lapsed key is
 * simply absent, and absent reads as closed.
 */
export class MemoryAvailabilityStore implements AvailabilityStore {
  private readonly intents = new Map<string, { value: Intent; expiresAtMs: number }>();
  private readonly doors = new Map<string, number>();

  constructor(private readonly clock: Clock) {}

  async get(userId: UserId): Promise<Availability> {
    return this.read(userId);
  }

  async getMany(userIds: readonly UserId[]): Promise<ReadonlyMap<UserId, Availability>> {
    return new Map(userIds.map((id) => [id, this.read(id)]));
  }

  async setIntent(userId: UserId, intent: Intent, ttlSeconds: number): Promise<void> {
    this.intents.set(userId, {
      value: intent,
      expiresAtMs: this.clock.nowMs() + ttlSeconds * 1000,
    });
  }

  async clearIntent(userId: UserId): Promise<void> {
    this.intents.delete(userId);
  }

  async setOpenDoor(userId: UserId, open: boolean, ttlSeconds: number): Promise<void> {
    if (!open) {
      this.doors.delete(userId);
      return;
    }
    this.doors.set(userId, this.clock.nowMs() + ttlSeconds * 1000);
  }

  private read(userId: UserId): Availability {
    const now = this.clock.nowMs();

    const intent = this.intents.get(userId);
    const doorExpiry = this.doors.get(userId);

    return {
      intent: intent !== undefined && intent.expiresAtMs > now ? intent.value : CLOSED.intent,
      openDoor: doorExpiry !== undefined && doorExpiry > now,
    };
  }

  /** Test helper. Not part of the port. */
  clear(): void {
    this.intents.clear();
    this.doors.clear();
  }
}
