import type { RoomRole } from '../../domain/entities/RoomMember.js';
import type { Clock } from '../../domain/ports/Clock.js';
import type { PresenceEntry, PresenceStore } from '../../domain/ports/PresenceStore.js';
import type { RoomId, UserId } from '../../domain/values/ids.js';
import { asRoomId, asUserId } from '../../domain/values/ids.js';
import { KEY, type RedisClient } from './client.js';

/**
 * ADAPTER: PresenceStore over Redis.
 *
 * THE DATA LAYOUT, AND WHY IT IS THREE STRUCTURES
 * -----------------------------------------------
 * Presence has to answer three different questions cheaply, and no single Redis
 * structure answers all three:
 *
 *   1. "who is in room R?"          -> HASH  presence:room:<R>   field=userId
 *   2. "which rooms is user U in?"  -> SET   presence:user:<U>
 *   3. "what has expired?"          -> ZSET  presence:expiry     score=deadline
 *
 * A naive design uses one key per member with a native Redis TTL and calls it
 * done. That fails question 3: when a key expires, Redis simply deletes it and
 * NOBODY IS TOLD. The room would never learn that the person left — their name
 * would just quietly vanish from the next snapshot while everyone's live member
 * list stayed wrong.
 *
 * So expiry is explicit. Every write also records a deadline in a sorted set,
 * and `reapExpired` pops everything past `now` — which is what lets the reaper
 * emit the `user:left` the vanished client never sent.
 *
 * CONSEQUENCE: reads must filter by deadline themselves, because an entry can
 * be logically expired but not yet swept. `getRoomMembers` therefore checks the
 * ZSET score rather than trusting the HASH, which means a member is invisible
 * the instant they lapse rather than at the next sweep.
 *
 * ATOMICITY: every multi-key write is a Lua script or a MULTI. A presence entry
 * that exists in the room hash but not the expiry index is a permanent ghost —
 * exactly the bug this whole design exists to prevent.
 */

interface StoredEntry {
  role: RoomRole;
  mutedByHost: boolean;
  handRaisedAtMs: number | null;
}

/**
 * KEYS[1] room hash, KEYS[2] user's room set, KEYS[3] expiry index
 * ARGV[1] userId, ARGV[2] roomId, ARGV[3] payload JSON, ARGV[4] deadline ms,
 * ARGV[5] now ms
 *
 * Returns 1 when this call made the user NEWLY present, 0 when it refreshed an
 * existing entry.
 *
 * The distinction cannot be computed outside the script: reading presence and
 * then writing it is a check-then-act race, and several joins fired at once
 * would each believe they were the first. Here it falls out of HSET's own
 * return value, atomically.
 *
 * An entry whose deadline has already passed counts as ABSENT — the room was
 * told they left, so coming back is a genuine new arrival.
 */
const SET_ONLINE_SCRIPT = `
  local member = ARGV[2] .. '|' .. ARGV[1]
  local previous = redis.call('ZSCORE', KEYS[3], member)
  local wasPresent = 0
  if previous and tonumber(previous) > tonumber(ARGV[5]) then
    wasPresent = 1
  end

  redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
  redis.call('SADD', KEYS[2], ARGV[2])
  redis.call('ZADD', KEYS[3], ARGV[4], member)

  if wasPresent == 1 then
    return 0
  end
  return 1
`;

/**
 * KEYS[1] room hash, KEYS[2] user's room set, KEYS[3] expiry index
 * ARGV[1] userId, ARGV[2] roomId
 */
const SET_OFFLINE_SCRIPT = `
  redis.call('HDEL', KEYS[1], ARGV[1])
  redis.call('SREM', KEYS[2], ARGV[2])
  redis.call('ZREM', KEYS[3], ARGV[2] .. '|' .. ARGV[1])
  return 1
`;

/**
 * Refresh a deadline, but ONLY if the entry is still live.
 *
 * KEYS[1] expiry index, KEYS[2] room hash
 * ARGV[1] member key, ARGV[2] now ms, ARGV[3] new deadline, ARGV[4] userId
 * Returns 1 when refreshed, 0 when the entry had already lapsed or vanished.
 */
const HEARTBEAT_SCRIPT = `
  local score = redis.call('ZSCORE', KEYS[1], ARGV[1])
  if not score then
    return 0
  end
  if tonumber(score) <= tonumber(ARGV[2]) then
    return 0
  end
  if not redis.call('HEXISTS', KEYS[2], ARGV[4]) then
    return 0
  end
  redis.call('ZADD', KEYS[1], ARGV[3], ARGV[1])
  return 1
`;

/**
 * Atomically claim expired members.
 *
 * ZRANGEBYSCORE then ZREM in ONE script, so two concurrent reaper passes (two
 * app instances, say) cannot both claim the same member and emit two
 * `user:left` events for one departure.
 */
const REAP_SCRIPT = `
  local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))
  if #expired == 0 then
    return {}
  end
  for i = 1, #expired do
    redis.call('ZREM', KEYS[1], expired[i])
  end
  return expired
`;

/** Cap per sweep, so one pass cannot block Redis after a mass disconnect. */
const REAP_BATCH_SIZE = 500;

export class RedisPresenceStore implements PresenceStore {
  constructor(
    private readonly redis: RedisClient,
    private readonly clock: Clock,
    private readonly ttlSeconds: number,
  ) {}

  private deadline(): number {
    return this.clock.nowMs() + this.ttlSeconds * 1000;
  }

  /** The composite value stored in the expiry ZSET. */
  private static memberKey(roomId: RoomId, userId: UserId): string {
    return `${roomId}|${userId}`;
  }

  private static parseMemberKey(value: string): { roomId: RoomId; userId: UserId } | null {
    const separator = value.indexOf('|');
    if (separator < 0) return null;
    return {
      roomId: asRoomId(value.slice(0, separator)),
      userId: asUserId(value.slice(separator + 1)),
    };
  }

  async setOnline(entry: Omit<PresenceEntry, 'lastSeenMs' | 'handRaisedAtMs'>): Promise<boolean> {
    // Re-joining does not inherit a raised hand from a previous session: a hand
    // that survived a reconnect would sit in the host's queue belonging to
    // someone who no longer remembers raising it.
    //
    // This read is OUTSIDE the atomic section, and that is acceptable: the
    // worst case is a raised hand carried across a reconnect that raced a
    // rejoin, which is cosmetic. The part that must be atomic — whether this
    // call made the user newly present — is decided inside the script.
    const existing = await this.getMember(entry.roomId, entry.userId);

    const payload: StoredEntry = {
      role: entry.role,
      mutedByHost: entry.mutedByHost,
      handRaisedAtMs: existing?.handRaisedAtMs ?? null,
    };

    const isNewArrival = (await this.redis.eval(
      SET_ONLINE_SCRIPT,
      3,
      KEY.presenceRoom(entry.roomId),
      KEY.presenceUserRooms(entry.userId),
      KEY.presenceExpiryIndex,
      entry.userId,
      entry.roomId,
      JSON.stringify(payload),
      String(this.deadline()),
      String(this.clock.nowMs()),
    )) as number;

    return isNewArrival === 1;
  }

  async setOffline(roomId: RoomId, userId: UserId): Promise<void> {
    await this.redis.eval(
      SET_OFFLINE_SCRIPT,
      3,
      KEY.presenceRoom(roomId),
      KEY.presenceUserRooms(userId),
      KEY.presenceExpiryIndex,
      userId,
      roomId,
    );
  }

  async heartbeat(roomId: RoomId, userId: UserId): Promise<boolean> {
    const refreshed = (await this.redis.eval(
      HEARTBEAT_SCRIPT,
      2,
      KEY.presenceExpiryIndex,
      KEY.presenceRoom(roomId),
      RedisPresenceStore.memberKey(roomId, userId),
      String(this.clock.nowMs()),
      String(this.deadline()),
      userId,
    )) as number;

    return refreshed === 1;
  }

  async getRoomMembers(roomId: RoomId): Promise<readonly PresenceEntry[]> {
    const raw = await this.redis.hgetall(KEY.presenceRoom(roomId));
    const userIds = Object.keys(raw);
    if (userIds.length === 0) return [];

    // Deadlines for the whole room in one round trip, rather than one ZSCORE
    // per member.
    const deadlines = await this.redis.zmscore(
      KEY.presenceExpiryIndex,
      ...userIds.map((userId) => RedisPresenceStore.memberKey(roomId, asUserId(userId))),
    );

    const now = this.clock.nowMs();
    const entries: PresenceEntry[] = [];

    userIds.forEach((userId, index) => {
      const deadline = Number(deadlines[index] ?? 0);
      // Logically expired but not yet swept — invisible immediately, rather
      // than lingering until the next reaper pass.
      if (!Number.isFinite(deadline) || deadline <= now) return;

      const stored = parseStored(raw[userId]);
      if (stored === null) return;

      entries.push({
        userId: asUserId(userId),
        roomId,
        role: stored.role,
        mutedByHost: stored.mutedByHost,
        lastSeenMs: deadline - this.ttlSeconds * 1000,
        handRaisedAtMs: stored.handRaisedAtMs,
      });
    });

    return entries;
  }

  async getMember(roomId: RoomId, userId: UserId): Promise<PresenceEntry | null> {
    const [stored, deadline] = await Promise.all([
      this.readEntry(roomId, userId),
      this.redis.zscore(KEY.presenceExpiryIndex, RedisPresenceStore.memberKey(roomId, userId)),
    ]);

    if (stored === null || deadline === null) return null;

    const deadlineMs = Number(deadline);
    if (!Number.isFinite(deadlineMs) || deadlineMs <= this.clock.nowMs()) return null;

    return {
      userId,
      roomId,
      role: stored.role,
      mutedByHost: stored.mutedByHost,
      lastSeenMs: deadlineMs - this.ttlSeconds * 1000,
      handRaisedAtMs: stored.handRaisedAtMs,
    };
  }

  async countRoomMembers(roomId: RoomId): Promise<number> {
    // Not HLEN: the hash can contain entries that have lapsed but not been
    // swept, and a room list showing phantom occupants is worse than a slightly
    // more expensive count.
    return (await this.getRoomMembers(roomId)).length;
  }

  async getRoomsForUser(userId: UserId): Promise<readonly RoomId[]> {
    const roomIds = await this.redis.smembers(KEY.presenceUserRooms(userId));
    if (roomIds.length === 0) return [];

    const deadlines = await this.redis.zmscore(
      KEY.presenceExpiryIndex,
      ...roomIds.map((roomId) => RedisPresenceStore.memberKey(asRoomId(roomId), userId)),
    );

    const now = this.clock.nowMs();
    const live: RoomId[] = [];
    const stale: string[] = [];

    roomIds.forEach((roomId, index) => {
      const deadline = Number(deadlines[index] ?? 0);
      if (Number.isFinite(deadline) && deadline > now) live.push(asRoomId(roomId));
      else stale.push(roomId);
    });

    // Opportunistic cleanup: the user's room set is the one structure with no
    // expiry of its own, so without this it would accumulate every room they
    // ever visited and slow this query down forever.
    if (stale.length > 0) {
      await this.redis.srem(KEY.presenceUserRooms(userId), ...stale);
    }

    return live;
  }

  async updateRole(roomId: RoomId, userId: UserId, role: RoomRole): Promise<void> {
    await this.patch(roomId, userId, (entry) => ({ ...entry, role }));
  }

  async setMutedByHost(roomId: RoomId, userId: UserId, muted: boolean): Promise<void> {
    await this.patch(roomId, userId, (entry) => ({ ...entry, mutedByHost: muted }));
  }

  async setHandRaised(roomId: RoomId, userId: UserId, raised: boolean): Promise<void> {
    await this.patch(roomId, userId, (entry) => ({
      ...entry,
      // Keeps the ORIGINAL timestamp when re-raising, so the host's queue stays
      // ordered by who asked first. Re-raising must not jump the queue.
      handRaisedAtMs: raised ? (entry.handRaisedAtMs ?? this.clock.nowMs()) : null,
    }));
  }

  async getRaisedHands(roomId: RoomId): Promise<readonly PresenceEntry[]> {
    const members = await this.getRoomMembers(roomId);
    return members
      .filter((entry) => entry.handRaisedAtMs !== null)
      .sort((a, b) => (a.handRaisedAtMs ?? 0) - (b.handRaisedAtMs ?? 0));
  }

  async countLive(): Promise<{ entries: number; users: number; rooms: number }> {
    // Scores at or below now are expired but not yet reaped — the reaper runs
    // on an interval, so they are still in the index. Excluding them here means
    // the dashboard agrees with what people can actually see in a room, rather
    // than with what has not been cleaned up yet.
    const live = await this.redis.zrangebyscore(
      KEY.presenceExpiryIndex,
      `(${this.clock.nowMs()}`,
      '+inf',
    );

    const users = new Set<string>();
    const rooms = new Set<string>();

    for (const value of live) {
      const parsed = RedisPresenceStore.parseMemberKey(value);
      if (parsed === null) continue;
      users.add(parsed.userId);
      rooms.add(parsed.roomId);
    }

    return { entries: live.length, users: users.size, rooms: rooms.size };
  }

  async reapExpired(): Promise<readonly PresenceEntry[]> {
    const expired = (await this.redis.eval(
      REAP_SCRIPT,
      1,
      KEY.presenceExpiryIndex,
      String(this.clock.nowMs()),
      String(REAP_BATCH_SIZE),
    )) as string[];

    if (expired.length === 0) return [];

    const reaped: PresenceEntry[] = [];

    for (const value of expired) {
      const parsed = RedisPresenceStore.parseMemberKey(value);
      if (parsed === null) continue;

      const { roomId, userId } = parsed;

      // Read the stored fields BEFORE deleting, so the caller can build a
      // meaningful `user:left` and knows what role the departing member had.
      const stored = await this.readEntry(roomId, userId);

      await this.redis
        .multi()
        .hdel(KEY.presenceRoom(roomId), userId)
        .srem(KEY.presenceUserRooms(userId), roomId)
        .exec();

      reaped.push({
        userId,
        roomId,
        role: stored?.role ?? 'listener',
        mutedByHost: stored?.mutedByHost ?? false,
        lastSeenMs: this.clock.nowMs() - this.ttlSeconds * 1000,
        handRaisedAtMs: stored?.handRaisedAtMs ?? null,
      });
    }

    return reaped;
  }

  // -------------------------------------------------------------------------

  private async readEntry(roomId: RoomId, userId: UserId): Promise<StoredEntry | null> {
    const raw = await this.redis.hget(KEY.presenceRoom(roomId), userId);
    return raw === null ? null : parseStored(raw);
  }

  /**
   * Read-modify-write on one member's stored fields.
   *
   * Not atomic, and that is a considered choice. The fields it mutates (role,
   * mute, raised hand) are each changed by exactly one actor — the host, or the
   * member themselves — so concurrent writes to the same field do not occur in
   * practice. Making it a Lua script would mean encoding JSON manipulation in
   * Lua for no real gain.
   *
   * A missing entry is IGNORED rather than throwing: presence mutations race
   * with departures constantly, and a host muting someone who just left should
   * not produce an error in the logs.
   */
  private async patch(
    roomId: RoomId,
    userId: UserId,
    change: (entry: StoredEntry) => StoredEntry,
  ): Promise<void> {
    const existing = await this.readEntry(roomId, userId);
    if (existing === null) return;

    await this.redis.hset(KEY.presenceRoom(roomId), userId, JSON.stringify(change(existing)));
  }
}

function parseStored(raw: string | undefined): StoredEntry | null {
  if (raw === undefined) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredEntry>;
    return {
      role: parsed.role ?? 'listener',
      mutedByHost: parsed.mutedByHost ?? false,
      handRaisedAtMs: parsed.handRaisedAtMs ?? null,
    };
  } catch {
    // Corrupt or written by an older version. Treating it as absent is safer
    // than throwing on a read path that runs for every member of every room.
    return null;
  }
}
