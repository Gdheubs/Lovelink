import type { Redis } from 'ioredis';
import type { RoomPulseStore } from '../../domain/ports/RoomPulseStore.js';
import type { RoomFeeling } from '../../domain/values/roomFeeling.js';
import { isRoomFeeling } from '../../domain/values/roomFeeling.js';
import type { RoomId, UserId } from '../../domain/values/ids.js';
import { KEY } from './client.js';

/**
 * ADAPTER: room pulse, in Redis.
 *
 * ONE HASH PER ROOM — field is the user, value is the feeling — with a TTL on
 * the whole key.
 *
 * WHY A HASH AND NOT A COUNTER PER FEELING
 * ----------------------------------------
 * Counters would be smaller and cannot support changing your mind. Someone who
 * votes `playful` and then finds the room turning heavy should be able to say
 * so, and with counters that means decrementing the old value — which requires
 * remembering what they said, which is the hash again with extra steps and a
 * race condition.
 *
 * The hash also makes one-vote-per-person automatic rather than enforced: a
 * second vote overwrites a field.
 *
 * WHY THE TTL IS ON THE KEY AND REFRESHED ON EVERY VOTE
 * -----------------------------------------------------
 * Redis expires whole keys, not fields, so the window applies to the room
 * rather than to each vote. That is the behaviour we want: a room being
 * actively voted in stays live, and a room nobody has commented on for
 * forty-five minutes stops describing itself at all.
 *
 * The cost is a vote cast at minute 44 living slightly longer than one cast at
 * minute 1. For "does this room feel calm" that imprecision is invisible, and
 * per-field expiry would mean a sorted set plus a pruning pass on every read.
 */
export class RedisRoomPulseStore implements RoomPulseStore {
  constructor(private readonly redis: Redis) {}

  async vote(
    roomId: RoomId,
    userId: UserId,
    feeling: RoomFeeling,
    windowSeconds: number,
  ): Promise<void> {
    const key = KEY.roomPulse(roomId);

    // Pipelined: the write and the expiry refresh are one round trip. Not a
    // transaction, because the two cannot meaningfully disagree — a vote
    // recorded without its refresh simply expires on the old schedule.
    await this.redis.multi().hset(key, userId, feeling).expire(key, windowSeconds).exec();
  }

  async currentVotes(roomId: RoomId): Promise<readonly RoomFeeling[]> {
    const raw = await this.redis.hvals(KEY.roomPulse(roomId));

    // HVALS, not HGETALL. The identities are not merely unused — they are never
    // read, so there is no point in the process where a caller could reach
    // them by accident.
    return raw.filter(isRoomFeeling);
  }

  async voteOf(roomId: RoomId, userId: UserId): Promise<RoomFeeling | null> {
    const value = await this.redis.hget(KEY.roomPulse(roomId), userId);
    return value !== null && isRoomFeeling(value) ? value : null;
  }

  async clear(roomId: RoomId): Promise<void> {
    await this.redis.del(KEY.roomPulse(roomId));
  }
}
