import type { Redis } from 'ioredis';
import type { AvailabilityStore } from '../../domain/ports/AvailabilityStore.js';
import type { Availability, Intent } from '../../domain/values/presenceIntent.js';
import { CLOSED, isIntent } from '../../domain/values/presenceIntent.js';
import type { UserId } from '../../domain/values/ids.js';
import { KEY } from './client.js';

/**
 * ADAPTER: tonight's intent and open door, in Redis.
 *
 * TWO KEYS RATHER THAN ONE HASH, and the reason is the TTLs.
 *
 * An intent lasts about an evening; an open door lasts a little longer. A hash
 * carries ONE expiry for the whole thing, so combining them would mean either
 * the door closing when the intent lapses, or the intent outliving the evening
 * it was about. Two keys let each mean what it says.
 *
 * Expiry is the storage mechanism, not a cleanup pass. There is no reaper here
 * and nothing to schedule: a key that has lapsed is simply absent, and absent
 * reads as closed.
 */
export class RedisAvailabilityStore implements AvailabilityStore {
  constructor(private readonly redis: Redis) {}

  async get(userId: UserId): Promise<Availability> {
    // One round trip for both keys. On managed Redis the round trip dominates
    // the work by orders of magnitude.
    const values = await this.redis.mget(KEY.intent(userId), KEY.openDoor(userId));

    // `mget` is typed as possibly-sparse; a missing key reads as absent, which
    // is the same thing as closed.
    const intent = values[0] ?? null;
    const door = values[1] ?? null;

    return {
      intent: intent !== null && isIntent(intent) ? intent : null,
      openDoor: door === '1',
    };
  }

  async getMany(userIds: readonly UserId[]): Promise<ReadonlyMap<UserId, Availability>> {
    const result = new Map<UserId, Availability>();
    if (userIds.length === 0) return result;

    // Interleaved so one MGET covers everyone: [intent(a), door(a), intent(b), …]
    const keys = userIds.flatMap((id) => [KEY.intent(id), KEY.openDoor(id)]);
    const values = await this.redis.mget(...keys);

    userIds.forEach((id, index) => {
      const intent = values[index * 2] ?? null;
      const door = values[index * 2 + 1] ?? null;

      result.set(id, {
        intent: intent !== null && isIntent(intent) ? intent : null,
        openDoor: door === '1',
      });
    });

    return result;
  }

  async setIntent(userId: UserId, intent: Intent, ttlSeconds: number): Promise<void> {
    // SET with EX replaces value and expiry together, which is what "changing
    // your mind restarts the clock" means.
    await this.redis.set(KEY.intent(userId), intent, 'EX', ttlSeconds);
  }

  async clearIntent(userId: UserId): Promise<void> {
    await this.redis.del(KEY.intent(userId));
  }

  async setOpenDoor(userId: UserId, open: boolean, ttlSeconds: number): Promise<void> {
    if (!open) {
      // DELETED, not set to '0'. Closing must be immediate and total — leaving
      // a falsy value behind invites a future reader that treats "present" as
      // "open" and keeps someone visible after they asked not to be.
      await this.redis.del(KEY.openDoor(userId));
      return;
    }

    await this.redis.set(KEY.openDoor(userId), '1', 'EX', ttlSeconds);
  }
}

/** The closed default, exported so callers can express "nothing known". */
export { CLOSED };
