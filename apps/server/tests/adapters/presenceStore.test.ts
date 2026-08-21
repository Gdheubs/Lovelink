import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { RedisPresenceStore } from '../../src/adapters/redis/RedisPresenceStore.js';
import { MemoryPresenceStore } from '../../src/adapters/memory/MemoryPresenceStore.js';
import { MemoryClock } from '../../src/adapters/memory/MemoryClock.js';
import type { PresenceStore } from '../../src/domain/ports/PresenceStore.js';
import { asRoomId, asUserId } from '../../src/domain/values/ids.js';
import { clearRedisNamespace, redisAvailable, redisClient } from './support.js';

/**
 * INTEGRATION: the PresenceStore contract, run against BOTH implementations.
 *
 * Presence is the component most likely to be subtly wrong, because its whole
 * difficulty is absence: entries that expire, clients that vanish without
 * saying so, and sweeps that must announce exactly once. None of that is
 * visible from a happy-path test.
 *
 * Running the identical suite against Redis and the memory fake is what keeps
 * the fake trustworthy — every room and chat unit test in the repo depends on
 * it behaving like the real thing, particularly around TTL semantics.
 *
 * The Redis store uses a controllable clock here too, so "thirty-one seconds
 * pass" is arithmetic rather than a sleep.
 */
const available = await redisAvailable();
const TTL_SECONDS = 30;

describe.skipIf(!available)('PresenceStore contract', () => {
  const clients: Redis[] = [];
  const room = asRoomId('11111111-1111-4111-8111-111111111111');
  const otherRoom = asRoomId('22222222-2222-4222-8222-222222222222');
  const alice = asUserId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  const bob = asUserId('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');

  afterAll(async () => {
    await Promise.allSettled(clients.map((c) => c.quit()));
  });

  const implementations: readonly [string, (clock: MemoryClock) => PresenceStore][] = [
    [
      'redis',
      (clock) => {
        const client = redisClient();
        clients.push(client);
        return new RedisPresenceStore(client, clock, TTL_SECONDS);
      },
    ],
    ['memory', (clock) => new MemoryPresenceStore(clock, TTL_SECONDS)],
  ];

  for (const [name, build] of implementations) {
    describe(name, () => {
      let clock: MemoryClock;
      let store: PresenceStore;

      beforeEach(async () => {
        if (name === 'redis') {
          const cleaner = redisClient();
          await clearRedisNamespace(cleaner);
          await cleaner.quit();
        }
        clock = new MemoryClock();
        store = build(clock);
      });

      const join = (userId = alice, roomId = room, role: 'listener' | 'host' = 'listener') =>
        store.setOnline({ userId, roomId, role, mutedByHost: false });

      // -- the basics -----------------------------------------------------

      it('reports a member as present', async () => {
        await join();
        expect(await store.getMember(room, alice)).not.toBeNull();
        expect(await store.countRoomMembers(room)).toBe(1);
      });

      it('lists every member of a room', async () => {
        await join(alice);
        await join(bob);

        const members = await store.getRoomMembers(room);
        expect(members.map((m) => m.userId).sort()).toEqual([alice, bob].sort());
      });

      it('is idempotent: joining twice does not duplicate', async () => {
        await join();
        await join();
        expect(await store.countRoomMembers(room)).toBe(1);
      });

      it('removes a member on setOffline', async () => {
        await join();
        await store.setOffline(room, alice);
        expect(await store.getMember(room, alice)).toBeNull();
        expect(await store.countRoomMembers(room)).toBe(0);
      });

      it('tracks which rooms a user is in', async () => {
        await join(alice, room);
        await join(alice, otherRoom);

        const rooms = [...(await store.getRoomsForUser(alice))];
        expect(rooms.sort()).toEqual([room, otherRoom].sort());
      });

      // -- expiry: the part that actually matters -------------------------

      it('EXPIRES a member who stops heartbeating', async () => {
        await join();
        clock.advanceSeconds(TTL_SECONDS + 1);

        expect(await store.getMember(room, alice)).toBeNull();
        expect(await store.countRoomMembers(room)).toBe(0);
        expect(await store.getRoomMembers(room)).toHaveLength(0);
      });

      it('makes a lapsed member invisible IMMEDIATELY, before any sweep', async () => {
        // Reads must filter by deadline themselves. If they trusted the stored
        // record, a member would linger in the list until the reaper next ran.
        await join();
        clock.advanceSeconds(TTL_SECONDS + 1);

        expect(await store.countRoomMembers(room)).toBe(0);
        // ...and only now does the sweep run.
        expect(await store.reapExpired()).toHaveLength(1);
      });

      it('a heartbeat extends the deadline', async () => {
        await join();

        for (let i = 0; i < 5; i += 1) {
          clock.advanceSeconds(TTL_SECONDS - 5);
          expect(await store.heartbeat(room, alice)).toBe(true);
        }
        expect(await store.countRoomMembers(room)).toBe(1);
      });

      it('a heartbeat on a LAPSED entry returns false and does not revive it', async () => {
        await join();
        clock.advanceSeconds(TTL_SECONDS + 1);

        expect(await store.heartbeat(room, alice)).toBe(false);
        expect(await store.getMember(room, alice)).toBeNull();
      });

      it('a heartbeat for a room the user was never in returns false', async () => {
        expect(await store.heartbeat(room, alice)).toBe(false);
        // And crucially, it did not create anything.
        expect(await store.countRoomMembers(room)).toBe(0);
      });

      it('drops lapsed rooms from the user index', async () => {
        await join(alice, room);
        await join(alice, otherRoom);
        clock.advanceSeconds(TTL_SECONDS + 1);

        expect(await store.getRoomsForUser(alice)).toHaveLength(0);
      });

      // -- the reaper ------------------------------------------------------

      it('returns what it reaped so departures can be announced', async () => {
        await join(alice);
        await join(bob);
        clock.advanceSeconds(TTL_SECONDS + 1);

        const reaped = await store.reapExpired();
        expect(reaped.map((e) => e.userId).sort()).toEqual([alice, bob].sort());
        expect(reaped.every((e) => e.roomId === room)).toBe(true);
      });

      it('claims each departure ONCE, so two sweeps cannot double-announce', async () => {
        await join();
        clock.advanceSeconds(TTL_SECONDS + 1);

        expect(await store.reapExpired()).toHaveLength(1);
        expect(await store.reapExpired()).toHaveLength(0);
      });

      it('leaves live members alone', async () => {
        await join(alice);
        clock.advanceSeconds(TTL_SECONDS - 5);
        await join(bob); // bob arrives later, so his deadline is further out
        clock.advanceSeconds(6); // alice has now lapsed; bob has not

        const reaped = await store.reapExpired();
        expect(reaped.map((e) => e.userId)).toEqual([alice]);
        expect(await store.countRoomMembers(room)).toBe(1);
      });

      it('preserves the reaped member’s role, for a meaningful user:left', async () => {
        await join(alice, room, 'host');
        clock.advanceSeconds(TTL_SECONDS + 1);

        const [reaped] = await store.reapExpired();
        expect(reaped?.role).toBe('host');
      });

      // -- role, mute and raised hands ------------------------------------

      it('updates a role in place', async () => {
        await join();
        await store.updateRole(room, alice, 'speaker');
        expect((await store.getMember(room, alice))?.role).toBe('speaker');
      });

      it('applies and clears a host mute', async () => {
        await join();
        await store.setMutedByHost(room, alice, true);
        expect((await store.getMember(room, alice))?.mutedByHost).toBe(true);

        await store.setMutedByHost(room, alice, false);
        expect((await store.getMember(room, alice))?.mutedByHost).toBe(false);
      });

      it('ignores a mutation for someone who is not there', async () => {
        // Presence mutations race with departures constantly; throwing would
        // fill the logs with errors from a host muting someone who just left.
        await expect(store.setMutedByHost(room, alice, true)).resolves.toBeUndefined();
        await expect(store.updateRole(room, alice, 'speaker')).resolves.toBeUndefined();
      });

      it('orders raised hands oldest first', async () => {
        await join(alice);
        await join(bob);

        await store.setHandRaised(room, bob, true);
        clock.advanceSeconds(1);
        await store.setHandRaised(room, alice, true);

        const hands = await store.getRaisedHands(room);
        expect(hands.map((h) => h.userId)).toEqual([bob, alice]);
      });

      it('re-raising does NOT jump the queue', async () => {
        await join(alice);
        await store.setHandRaised(room, alice, true);
        const first = (await store.getMember(room, alice))?.handRaisedAtMs;

        clock.advanceSeconds(5);
        await store.setHandRaised(room, alice, true);
        expect((await store.getMember(room, alice))?.handRaisedAtMs).toBe(first);
      });

      it('lowers a hand', async () => {
        await join();
        await store.setHandRaised(room, alice, true);
        await store.setHandRaised(room, alice, false);

        expect(await store.getRaisedHands(room)).toHaveLength(0);
      });

      it('does not carry a raised hand into a fresh session', async () => {
        // A hand that survived a lapse would sit in the host's queue belonging
        // to someone who no longer remembers raising it.
        await join();
        await store.setHandRaised(room, alice, true);

        clock.advanceSeconds(TTL_SECONDS + 1);
        await store.reapExpired();
        await join();

        expect((await store.getMember(room, alice))?.handRaisedAtMs).toBeNull();
      });
    });
  }
});

describe.skipIf(available)('PresenceStore contract', () => {
  it.skip('skipped: Redis is not reachable (run `docker compose up -d`)', () => {});
});
