import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../../src/adapters/postgres/db.js';
import { PostgresRoomRepository } from '../../src/adapters/postgres/PostgresRoomRepository.js';
import { PostgresUserRepository } from '../../src/adapters/postgres/PostgresUserRepository.js';
import { MemoryRoomRepository } from '../../src/adapters/memory/MemoryRoomRepository.js';
import type { RoomRepository } from '../../src/domain/ports/RoomRepository.js';
import { nullLogger } from '../../src/domain/ports/Logger.js';
import { asRoomId, asUserId } from '../../src/domain/values/ids.js';
import { DATABASE_URL, postgresAvailable, truncateAll } from './support.js';

/**
 * INTEGRATION: the RoomRepository contract against Postgres and the fake.
 *
 * The centrepiece is `haveSharedRoomSession`, which is the evidence behind the
 * DM rung of the trust ladder. It is an INTERVAL OVERLAP, and the tempting
 * wrong implementation (a plain join on room_id) passes every naive test while
 * letting anyone unlock DMs with a stranger by visiting a room that stranger
 * once used. The cases below are chosen to fail that implementation.
 */
const available = await postgresAvailable();

describe.skipIf(!available)('RoomRepository contract', () => {
  let db: Database;

  beforeAll(() => {
    db = createDatabase({ connectionString: DATABASE_URL, poolMax: 4, logger: nullLogger });
  });

  afterAll(async () => {
    await db?.close();
  });

  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

  const HOST = asUserId(uuid(1));
  const ALICE = asUserId(uuid(2));
  const BOB = asUserId(uuid(3));
  const ROOM = asRoomId(uuid(10));
  const ROOM2 = asRoomId(uuid(11));

  const implementations: readonly [string, () => RoomRepository][] = [
    ['postgres', () => new PostgresRoomRepository(db)],
    ['memory', () => new MemoryRoomRepository()],
  ];

  for (const [name, build] of implementations) {
    describe(name, () => {
      let repo: RoomRepository;

      beforeEach(async () => {
        if (name === 'postgres') {
          await truncateAll(db);
          // Rooms reference users, so the FK needs real rows behind it. The
          // memory fake has no FKs, which is itself a difference worth knowing
          // about — it is why this suite exists.
          const users = new PostgresUserRepository(db);
          for (const [id, displayName] of [
            [HOST, 'Hosty'],
            [ALICE, 'Alice'],
            [BOB, 'Bob'],
          ] as const) {
            await users.create({
              id,
              identifier: `${displayName.toLowerCase()}@example.com`,
              identifierKind: 'email',
              displayName,
              avatarSeed: 'seed',
              dob: new Date('1995-01-01T00:00:00.000Z'),
              createdAt: new Date('2025-01-01T00:00:00.000Z'),
            });
          }
        }
        repo = build();
      });

      const createRoom = (
        id = ROOM,
        slug = 'late-night-talk',
        category: 'late_night' | 'study' = 'late_night',
      ) =>
        repo.create({
          id,
          slug,
          title: 'Late Night Talk',
          category,
          hostUserId: HOST,
          isScheduled: false,
          scheduleCron: null,
          maxSpeakers: 4,
          status: 'live',
          createdAt: new Date('2025-01-01T12:00:00.000Z'),
        });

      const joinAt = (userId: typeof ALICE, at: string, roomId = ROOM) =>
        repo.recordJoin({
          roomId,
          userId,
          role: 'listener',
          joinedAt: new Date(at),
          mutedByHost: false,
        });

      // -- rooms -----------------------------------------------------------

      it('round-trips a room', async () => {
        const room = await createRoom();
        expect(room.title).toBe('Late Night Talk');
        expect((await repo.findById(ROOM))?.slug).toBe('late-night-talk');
        expect((await repo.findBySlug('late-night-talk'))?.id).toBe(ROOM);
      });

      it('enforces slug uniqueness', async () => {
        await createRoom();
        await expect(createRoom(ROOM2, 'late-night-talk')).rejects.toThrow(/already exists/i);
      });

      it('filters the list by status and category', async () => {
        await createRoom();
        await createRoom(ROOM2, 'study-hall', 'study');
        await repo.updateStatus(ROOM2, 'closed');

        const live = await repo.list({ status: 'live', limit: 10, offset: 0 });
        expect(live.map((r) => r.id)).toEqual([ROOM]);

        const byCategory = await repo.list({ category: 'late_night', limit: 10, offset: 0 });
        expect(byCategory).toHaveLength(1);
      });

      it('lists rooms hosted by a user', async () => {
        await createRoom();
        expect(await repo.listHostedBy(HOST, 10)).toHaveLength(1);
        expect(await repo.listHostedBy(ALICE, 10)).toHaveLength(0);
      });

      // -- membership ------------------------------------------------------

      it('opens and closes a membership', async () => {
        await createRoom();
        await joinAt(ALICE, '2025-01-01T12:00:00Z');

        expect(await repo.findMembership(ROOM, ALICE)).not.toBeNull();

        const closed = await repo.recordLeave(ROOM, ALICE, new Date('2025-01-01T13:00:00Z'));
        expect(closed).toBe(true);
        expect(await repo.findMembership(ROOM, ALICE)).toBeNull();
      });

      it('recordLeave reports FALSE when there was nothing open to close', async () => {
        // This boolean is the idempotence guard for the whole departure path:
        // exactly one of leave / disconnect / reap gets to announce user:left.
        await createRoom();
        expect(await repo.recordLeave(ROOM, ALICE, new Date())).toBe(false);

        await joinAt(ALICE, '2025-01-01T12:00:00Z');
        expect(await repo.recordLeave(ROOM, ALICE, new Date())).toBe(true);
        expect(await repo.recordLeave(ROOM, ALICE, new Date())).toBe(false);
      });

      it('a reconnect refreshes the open row rather than opening a second', async () => {
        await createRoom();
        await joinAt(ALICE, '2025-01-01T12:00:00Z');
        await joinAt(ALICE, '2025-01-01T12:05:00Z');

        // One open row: closing it once leaves nothing behind.
        expect(await repo.recordLeave(ROOM, ALICE, new Date('2025-01-01T13:00:00Z'))).toBe(true);
        expect(await repo.recordLeave(ROOM, ALICE, new Date('2025-01-01T13:00:00Z'))).toBe(false);
      });

      it('does NOT reset joined_at on reconnect', async () => {
        // Otherwise a two-hour conversation shrinks to the last thirty seconds,
        // and both session credit and the shared-session window are wrong.
        await createRoom();
        await joinAt(ALICE, '2025-01-01T12:00:00Z');
        await joinAt(ALICE, '2025-01-01T12:45:00Z');

        const membership = await repo.findMembership(ROOM, ALICE);
        expect(membership?.joinedAt.toISOString()).toBe('2025-01-01T12:00:00.000Z');
      });

      it('updates role and mute on the open row', async () => {
        await createRoom();
        await joinAt(ALICE, '2025-01-01T12:00:00Z');

        await repo.updateRole(ROOM, ALICE, 'speaker');
        await repo.setMutedByHost(ROOM, ALICE, true);

        const membership = await repo.findMembership(ROOM, ALICE);
        expect(membership?.role).toBe('speaker');
        expect(membership?.mutedByHost).toBe(true);
      });

      // -- the trust-ladder query -----------------------------------------

      describe('haveSharedRoomSession', () => {
        beforeEach(async () => {
          await createRoom();
        });

        it('is false for strangers', async () => {
          expect(await repo.haveSharedRoomSession(ALICE, BOB)).toBe(false);
        });

        it('is false for a user with themselves', async () => {
          await joinAt(ALICE, '2025-01-01T12:00:00Z');
          expect(await repo.haveSharedRoomSession(ALICE, ALICE)).toBe(false);
        });

        it('is TRUE while both are currently present', async () => {
          // Two open sessions: both extend to "now", so they overlap.
          await joinAt(ALICE, '2025-01-01T12:00:00Z');
          await joinAt(BOB, '2025-01-01T12:01:00Z');

          expect(await repo.haveSharedRoomSession(ALICE, BOB)).toBe(true);
        });

        it('is FALSE when they used the same room at different times', async () => {
          // THE case a plain room_id join gets wrong. Without this rule, anyone
          // could unlock DMs with a stranger by joining a room the stranger
          // visited last week.
          await joinAt(ALICE, '2025-01-01T12:00:00Z');
          await repo.recordLeave(ROOM, ALICE, new Date('2025-01-01T12:30:00Z'));

          await joinAt(BOB, '2025-01-01T14:00:00Z');
          await repo.recordLeave(ROOM, BOB, new Date('2025-01-01T14:30:00Z'));

          expect(await repo.haveSharedRoomSession(ALICE, BOB)).toBe(false);
        });

        it('is true for partially overlapping sessions', async () => {
          await joinAt(ALICE, '2025-01-01T12:00:00Z');
          await joinAt(BOB, '2025-01-01T12:20:00Z');
          await repo.recordLeave(ROOM, ALICE, new Date('2025-01-01T12:30:00Z'));
          await repo.recordLeave(ROOM, BOB, new Date('2025-01-01T13:00:00Z'));

          expect(await repo.haveSharedRoomSession(ALICE, BOB)).toBe(true);
        });

        it('is FALSE for sessions that merely touch at the boundary', async () => {
          // Alice leaves at exactly the moment Bob arrives. They did not meet.
          await joinAt(ALICE, '2025-01-01T12:00:00Z');
          await repo.recordLeave(ROOM, ALICE, new Date('2025-01-01T12:30:00Z'));
          await joinAt(BOB, '2025-01-01T12:30:00Z');

          expect(await repo.haveSharedRoomSession(ALICE, BOB)).toBe(false);
        });

        it('is false when they were in DIFFERENT rooms at the same time', async () => {
          await createRoom(ROOM2, 'study-hall');
          await joinAt(ALICE, '2025-01-01T12:00:00Z', ROOM);
          await joinAt(BOB, '2025-01-01T12:00:00Z', ROOM2);

          expect(await repo.haveSharedRoomSession(ALICE, BOB)).toBe(false);
        });

        it('is symmetric', async () => {
          await joinAt(ALICE, '2025-01-01T12:00:00Z');
          await joinAt(BOB, '2025-01-01T12:10:00Z');

          expect(await repo.haveSharedRoomSession(ALICE, BOB)).toBe(true);
          expect(await repo.haveSharedRoomSession(BOB, ALICE)).toBe(true);
        });

        it('finds an overlap in ANY room, not just the most recent', async () => {
          await createRoom(ROOM2, 'study-hall');

          // They overlapped once, long ago, in a different room.
          await joinAt(ALICE, '2025-01-01T09:00:00Z', ROOM2);
          await joinAt(BOB, '2025-01-01T09:10:00Z', ROOM2);
          await repo.recordLeave(ROOM2, ALICE, new Date('2025-01-01T09:30:00Z'));
          await repo.recordLeave(ROOM2, BOB, new Date('2025-01-01T09:30:00Z'));

          // And separately, at different times, in this one.
          await joinAt(ALICE, '2025-01-01T12:00:00Z');
          await repo.recordLeave(ROOM, ALICE, new Date('2025-01-01T12:30:00Z'));
          await joinAt(BOB, '2025-01-01T14:00:00Z');

          expect(await repo.haveSharedRoomSession(ALICE, BOB)).toBe(true);
        });
      });

      // -- scheduling (phase 6) ------------------------------------------

      describe('claiming a scheduled occurrence', () => {
        const SCHEDULED = asRoomId('55555555-5555-4555-8555-555555555555');

        const scheduleAt = (nextOccurrenceAt: Date) =>
          repo.create({
            id: SCHEDULED,
            slug: 'nightly',
            title: 'Nightly',
            category: 'late_night',
            hostUserId: HOST,
            isScheduled: true,
            scheduleCron: '0 22 * * *',
            scheduleTimeZone: 'UTC',
            nextOccurrenceAt,
            maxSpeakers: 4,
            status: 'scheduled',
            createdAt: new Date('2026-03-01T00:00:00.000Z'),
          });

        const NOW = new Date('2026-03-14T22:00:30.000Z');

        it('lists a room whose time has come', async () => {
          await scheduleAt(new Date('2026-03-14T22:00:00.000Z'));
          const due = await repo.listDueSchedules(NOW, 10);
          expect(due.map((room) => room.id)).toContain(SCHEDULED);
        });

        it('does not list one whose time has not', async () => {
          await scheduleAt(new Date('2026-03-15T22:00:00.000Z'));
          expect(await repo.listDueSchedules(NOW, 10)).toHaveLength(0);
        });

        it('claims it, moves the occurrence on, and marks it live', async () => {
          await scheduleAt(new Date('2026-03-14T22:00:00.000Z'));

          const claimed = await repo.claimOccurrence({
            roomId: SCHEDULED,
            now: NOW,
            nextOccurrenceAt: new Date('2026-03-15T22:00:00.000Z'),
            openedAt: NOW,
          });

          expect(claimed).toBe(true);

          const after = await repo.findById(SCHEDULED);
          expect(after?.status).toBe('live');
          expect(after?.nextOccurrenceAt?.toISOString()).toBe('2026-03-15T22:00:00.000Z');
          expect(after?.lastOpenedAt).not.toBeNull();
        });

        it('A SECOND CLAIM ON THE SAME OCCURRENCE LOSES', async () => {
          await scheduleAt(new Date('2026-03-14T22:00:00.000Z'));

          const first = await repo.claimOccurrence({
            roomId: SCHEDULED,
            now: NOW,
            nextOccurrenceAt: new Date('2026-03-15T22:00:00.000Z'),
            openedAt: NOW,
          });
          const second = await repo.claimOccurrence({
            roomId: SCHEDULED,
            now: NOW,
            nextOccurrenceAt: new Date('2026-03-15T22:00:00.000Z'),
            openedAt: NOW,
          });

          expect(first).toBe(true);
          expect(second).toBe(false);
        });

        it('TWO CLAIMS RACING PRODUCE EXACTLY ONE WINNER', async () => {
          await scheduleAt(new Date('2026-03-14T22:00:00.000Z'));

          const results = await Promise.all([
            repo.claimOccurrence({
              roomId: SCHEDULED,
              now: NOW,
              nextOccurrenceAt: new Date('2026-03-15T22:00:00.000Z'),
              openedAt: NOW,
            }),
            repo.claimOccurrence({
              roomId: SCHEDULED,
              now: NOW,
              nextOccurrenceAt: new Date('2026-03-15T22:00:00.000Z'),
              openedAt: NOW,
            }),
          ]);

          expect(results.filter(Boolean)).toHaveLength(1);
        });

        it('refuses to claim one that is not due yet', async () => {
          await scheduleAt(new Date('2026-03-15T22:00:00.000Z'));

          const claimed = await repo.claimOccurrence({
            roomId: SCHEDULED,
            now: NOW,
            nextOccurrenceAt: new Date('2026-03-16T22:00:00.000Z'),
            openedAt: NOW,
          });

          expect(claimed).toBe(false);
        });

        it('claims the NEXT occurrence when its turn comes', async () => {
          await scheduleAt(new Date('2026-03-14T22:00:00.000Z'));

          await repo.claimOccurrence({
            roomId: SCHEDULED,
            now: NOW,
            nextOccurrenceAt: new Date('2026-03-15T22:00:00.000Z'),
            openedAt: NOW,
          });

          const tomorrow = new Date('2026-03-15T22:00:30.000Z');
          const again = await repo.claimOccurrence({
            roomId: SCHEDULED,
            now: tomorrow,
            nextOccurrenceAt: new Date('2026-03-16T22:00:00.000Z'),
            openedAt: tomorrow,
          });

          expect(again).toBe(true);
        });

        it('disabling takes it out of the sweep for good', async () => {
          await scheduleAt(new Date('2026-03-14T22:00:00.000Z'));

          await repo.disableSchedule(SCHEDULED);

          expect(await repo.listDueSchedules(new Date('2027-01-01T00:00:00.000Z'), 10)).toHaveLength(
            0,
          );
        });

        it('DISABLING KEEPS THE HOST’S INTENT ON THE ROW', async () => {
          await scheduleAt(new Date('2026-03-14T22:00:00.000Z'));
          await repo.disableSchedule(SCHEDULED);

          // Someone looking at this row has to be able to see what was asked
          // for and that it is no longer happening. Clearing the expression
          // would leave an ordinary ad-hoc room and no explanation.
          const after = await repo.findById(SCHEDULED);
          expect(after).not.toBeNull();
          expect(after?.isScheduled).toBe(false);
          expect(after?.scheduleCron).toBe('0 22 * * *');
          expect(after?.nextOccurrenceAt).toBeNull();
        });

        it('disabling a room that does not exist is not an error', async () => {
          await expect(
            repo.disableSchedule(asRoomId('99999999-9999-4999-8999-999999999999')),
          ).resolves.toBeUndefined();
        });

        /**
         * THE BUG THIS EXISTS TO PREVENT.
         *
         * Postgres TIMESTAMPTZ keeps microseconds; a JavaScript Date keeps
         * milliseconds. A value written by SQL — `now()`, a backfill, a manual
         * edit, a restore — round-trips through JS as `.949` against a stored
         * `.949147`, so any compare-and-set keyed on timestamp EQUALITY silently
         * never matches.
         *
         * The failure is invisible in the worst way: the sweep reports the room
         * as "claimed by another server", which is a lie, and the room is
         * stranded forever with nothing logged as an error.
         */
        it('CLAIMS A ROOM WHOSE OCCURRENCE HAS SUB-MILLISECOND PRECISION', async () => {
          if (name !== 'postgres') return;

          await scheduleAt(new Date('2026-03-14T22:00:00.000Z'));

          // Write a timestamp only Postgres can represent.
          await db.query(
            `UPDATE rooms SET next_occurrence_at = TIMESTAMPTZ '2026-03-14 22:00:00.123456+00'
              WHERE id = $1`,
            [SCHEDULED],
          );

          const claimed = await repo.claimOccurrence({
            roomId: SCHEDULED,
            now: NOW,
            nextOccurrenceAt: new Date('2026-03-15T22:00:00.000Z'),
            openedAt: NOW,
          });

          expect(claimed).toBe(true);
        });
      });
    });
  }
});

describe.skipIf(available)('RoomRepository contract', () => {
  it.skip('skipped: Postgres is not reachable (docker compose up -d && npm run migrate)', () => {});
});
