import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryPorts, type MemoryPorts } from '../../src/adapters/memory/index.js';
import { createUseCases, type UseCases } from '../../src/app/index.js';
import type { User } from '../../src/domain/entities/User.js';
import { asRoomId, asUserId } from '../../src/domain/values/ids.js';
import { TRUST_DELTAS } from '../../src/domain/values/trust.js';
import type { DomainError } from '../../src/domain/errors.js';

/**
 * RECURRING ROOMS — the phase 6 criterion is that they SURVIVE A RESTART.
 *
 * WHAT "SURVIVES A RESTART" ACTUALLY MEANS
 * ----------------------------------------
 * Not that a timer is re-created on boot — that would still lose an occurrence
 * that fell during the outage. It means the schedule is a ROW, so a server
 * coming back after two hours down asks "what is due?" and finds exactly what
 * it missed, with no memory of what it was doing before.
 *
 * The tests below simulate that by throwing the whole container away and
 * building a new one over the same storage, which is the closest an in-process
 * test can get to a process restart — and is precisely what a restart is from
 * the database's point of view.
 *
 * THE OTHER THING THAT MUST HOLD: a room opens ONCE. During a rolling deploy
 * two servers sweep at the same instant and both see the same room as due.
 */
describe('scheduled rooms', () => {
  let ports: MemoryPorts;
  let useCases: UseCases;
  let host: User;

  const makeUser = async (name: string, timeZone = 'UTC'): Promise<User> => {
    const user = await ports.users.create({
      id: asUserId(ports.ids.uuid()),
      identifier: `${name.toLowerCase()}@example.com`,
      identifierKind: 'email',
      displayName: name,
      avatarSeed: `seed-${name}`,
      dob: new Date('1995-01-01T00:00:00.000Z'),
      createdAt: ports.clock.now(),
    });
    await ports.users.appendTrustEvent({
      userId: user.id,
      delta: TRUST_DELTAS.account_created,
      reason: 'account_created',
      context: null,
      createdAt: ports.clock.now(),
    });
    await ports.users.updateTimeZone(user.id, timeZone);
    return (await ports.users.findById(user.id)) ?? user;
  };

  /**
   * Throw the application away and build it again over the same storage.
   *
   * This is the restart. The ports keep their data — as Postgres and Redis
   * would — and every use case, every timer and every piece of in-memory
   * bookkeeping is new.
   */
  const restart = (): void => {
    useCases = createUseCases(ports, { echoLoginCode: true, moderatorUserIds: [] });
  };

  const errorOf = async (fn: () => Promise<unknown>): Promise<DomainError> => {
    try {
      await fn();
    } catch (error) {
      return error as DomainError;
    }
    throw new Error('expected that to be refused');
  };

  beforeEach(async () => {
    ports = createMemoryPorts({ presenceTtlSeconds: 60 });
    useCases = createUseCases(ports, { echoLoginCode: true, moderatorUserIds: [] });

    // A fixed, known instant: 2026-03-14 is a Saturday, 09:00 UTC.
    ports.clock.setNow(new Date('2026-03-14T09:00:00.000Z'));

    host = await makeUser('Hosty');
  });

  // =========================================================================
  describe('creating one', () => {
    it('books the first occurrence up front', async () => {
      const room = await useCases.createRoom.execute(host, {
        title: 'Late Night Talk',
        category: 'late_night',
        scheduleCron: '0 22 * * *',
      });

      expect(room.isScheduled).toBe(true);
      expect(room.status).toBe('scheduled');
      expect(room.nextOccurrenceAt?.toISOString()).toBe('2026-03-14T22:00:00.000Z');
    });

    it('uses the HOST’s timezone, not the server’s', async () => {
      const kiwi = await makeUser('Kiwi', 'Pacific/Auckland');

      const room = await useCases.createRoom.execute(kiwi, {
        title: 'Auckland Nights',
        category: 'late_night',
        scheduleCron: '0 22 * * *',
      });

      // 22:00 NZDT on the 14th is 09:00 UTC that day — which has just passed,
      // so the first occurrence is the following night.
      expect(room.scheduleTimeZone).toBe('Pacific/Auckland');
      expect(room.nextOccurrenceAt?.toISOString()).toBe('2026-03-15T09:00:00.000Z');
    });

    it('REFUSES A SCHEDULE THAT CANNOT FIRE, RATHER THAN ACCEPTING IT', async () => {
      // The failure this prevents: a room that says "scheduled" forever and
      // never opens. Nobody reports it — the host assumes nobody came, and the
      // people assume there was no room.
      const error = await errorOf(async () =>
        useCases.createRoom.execute(host, {
          title: 'Never',
          category: 'casual',
          scheduleCron: 'every night please',
        }),
      );
      expect(error.code).toBe('VALIDATION_FAILED');
    });

    it('refuses a schedule that parses but matches no real date', async () => {
      const error = await errorOf(async () =>
        useCases.createRoom.execute(host, {
          title: 'Feb 30',
          category: 'casual',
          scheduleCron: '0 12 30 2 *',
        }),
      );
      expect(error.code).toBe('VALIDATION_FAILED');
    });

    it('leaves an ad-hoc room live and unscheduled', async () => {
      const room = await useCases.createRoom.execute(host, {
        title: 'Right Now',
        category: 'casual',
      });

      expect(room.isScheduled).toBe(false);
      expect(room.nextOccurrenceAt).toBeNull();
      expect(room.status).toBe('live');
    });
  });

  // =========================================================================
  describe('the sweep', () => {
    const nightly = () =>
      useCases.createRoom.execute(host, {
        title: 'Late Night Talk',
        category: 'late_night',
        scheduleCron: '0 22 * * *',
      });

    it('does nothing before the time comes', async () => {
      await nightly();
      expect(await useCases.openScheduledRooms.execute()).toMatchObject({ opened: 0 });
    });

    it('opens the room when its time arrives', async () => {
      const room = await nightly();
      ports.clock.setNow(new Date('2026-03-14T22:00:30.000Z'));

      expect(await useCases.openScheduledRooms.execute()).toMatchObject({ opened: 1 });
      expect((await ports.rooms.findById(room.id))?.status).toBe('live');
    });

    it('books the following night', async () => {
      const room = await nightly();
      ports.clock.setNow(new Date('2026-03-14T22:00:30.000Z'));
      await useCases.openScheduledRooms.execute();

      expect((await ports.rooms.findById(room.id))?.nextOccurrenceAt?.toISOString()).toBe(
        '2026-03-15T22:00:00.000Z',
      );
    });

    it('DOES NOT OPEN THE SAME OCCURRENCE TWICE', async () => {
      await nightly();
      ports.clock.setNow(new Date('2026-03-14T22:00:30.000Z'));

      expect(await useCases.openScheduledRooms.execute()).toMatchObject({ opened: 1 });
      // A second sweep a moment later: the occurrence has moved on.
      expect(await useCases.openScheduledRooms.execute()).toMatchObject({ opened: 0 });
    });

    it('TWO SERVERS SWEEPING AT ONCE OPEN IT ONCE', async () => {
      await nightly();
      ports.clock.setNow(new Date('2026-03-14T22:00:30.000Z'));

      // A rolling deploy. Both see the room as due within the same instant.
      const [a, b] = await Promise.all([
        useCases.openScheduledRooms.execute(),
        useCases.openScheduledRooms.execute(),
      ]);

      expect(a.opened + b.opened).toBe(1);
    });

    it('announces it exactly once', async () => {
      await nightly();
      ports.clock.setNow(new Date('2026-03-14T22:00:30.000Z'));

      await Promise.all([
        useCases.openScheduledRooms.execute(),
        useCases.openScheduledRooms.execute(),
      ]);

      const announcements = ports.bus.published.filter(
        (entry) => entry.event.type === 'room.opened',
      );
      expect(announcements).toHaveLength(1);
    });

    it('DOES NOT REPLAY A BACKLOG AFTER AN OUTAGE', async () => {
      const room = await nightly();

      // Down for three days. A nightly room must not open three times to catch
      // up — coming back from an outage into a flood of rooms nobody asked for
      // is worse than the outage.
      ports.clock.setNow(new Date('2026-03-17T23:00:00.000Z'));

      expect(await useCases.openScheduledRooms.execute()).toMatchObject({ opened: 1 });
      expect(await useCases.openScheduledRooms.execute()).toMatchObject({ opened: 0 });

      // And it resumes normally: the next slot is computed from NOW, so it is
      // tomorrow night rather than a missed one from the past.
      expect((await ports.rooms.findById(room.id))?.nextOccurrenceAt?.toISOString()).toBe(
        '2026-03-18T22:00:00.000Z',
      );
    });

    it('sweeps several rooms in one pass', async () => {
      await nightly();
      await useCases.createRoom.execute(host, {
        title: 'Also Nightly',
        category: 'study',
        scheduleCron: '0 22 * * *',
      });

      ports.clock.setNow(new Date('2026-03-14T22:00:30.000Z'));
      expect(await useCases.openScheduledRooms.execute()).toMatchObject({ opened: 2 });
    });

    it('leaves ad-hoc rooms entirely alone', async () => {
      await useCases.createRoom.execute(host, { title: 'Right Now', category: 'casual' });
      ports.clock.setNow(new Date('2026-03-14T22:00:30.000Z'));

      expect(await useCases.openScheduledRooms.execute()).toMatchObject({ opened: 0 });
    });
  });

  // =========================================================================
  describe('SURVIVING A RESTART', () => {
    it('opens a room whose time came while the server was down', async () => {
      const room = await useCases.createRoom.execute(host, {
        title: 'Late Night Talk',
        category: 'late_night',
        scheduleCron: '0 22 * * *',
      });

      // The server goes away before 22:00 and comes back after it. Everything
      // in memory is gone; only the row remains.
      restart();
      ports.clock.setNow(new Date('2026-03-14T23:30:00.000Z'));

      expect(await useCases.openScheduledRooms.execute()).toMatchObject({ opened: 1 });
      expect((await ports.rooms.findById(room.id))?.status).toBe('live');
    });

    it('the new process knows the next occurrence without being told', async () => {
      await useCases.createRoom.execute(host, {
        title: 'Late Night Talk',
        category: 'late_night',
        scheduleCron: '0 22 * * *',
      });

      restart();
      ports.clock.setNow(new Date('2026-03-14T22:00:30.000Z'));
      await useCases.openScheduledRooms.execute();

      // A fresh process, a fresh sweep, and the schedule continues — because
      // the answer was written down rather than held in a timer.
      restart();
      ports.clock.setNow(new Date('2026-03-15T22:00:30.000Z'));
      expect(await useCases.openScheduledRooms.execute()).toMatchObject({ opened: 1 });
    });

    it('does not re-open an occurrence that was already claimed before the restart', async () => {
      await useCases.createRoom.execute(host, {
        title: 'Late Night Talk',
        category: 'late_night',
        scheduleCron: '0 22 * * *',
      });

      ports.clock.setNow(new Date('2026-03-14T22:00:30.000Z'));
      await useCases.openScheduledRooms.execute();

      // Crash immediately after opening, then come back within the same slot.
      restart();
      ports.clock.setNow(new Date('2026-03-14T22:05:00.000Z'));

      expect(await useCases.openScheduledRooms.execute()).toMatchObject({ opened: 0 });
    });
  });

  // =========================================================================
  describe('a schedule that can never fire again', () => {
    /**
     * CreateRoom refuses a bad expression, so a row like this can only arrive
     * by a route that bypasses it — a bad migration, a manual edit, or an
     * expression that was valid under an older parser. The sweep still has to
     * cope, because the alternative is re-reading the same unusable row on
     * every sweep for the life of the deployment.
     */
    const brokenRoom = async (cron: string) =>
      ports.rooms.create({
        id: asRoomId(ports.ids.uuid()),
        slug: `broken-${ports.ids.uuid().slice(0, 8)}`,
        title: 'Broken Schedule',
        category: 'casual',
        hostUserId: host.id,
        isScheduled: true,
        scheduleCron: cron,
        nextOccurrenceAt: new Date('2026-03-14T08:00:00.000Z'),
        scheduleTimeZone: 'UTC',
        maxSpeakers: 4,
        status: 'scheduled',
        createdAt: ports.clock.now(),
      });

    it('IS DISABLED RATHER THAN RETRIED FOREVER', async () => {
      const room = await brokenRoom('not a cron');
      ports.clock.setNow(new Date('2026-03-14T22:00:30.000Z'));

      expect(await useCases.openScheduledRooms.execute()).toMatchObject({
        opened: 0,
        disabled: 1,
      });

      // Taken out of the sweep, so it is not re-read every minute forever.
      expect((await ports.rooms.findById(room.id))?.nextOccurrenceAt).toBeNull();
      expect(await useCases.openScheduledRooms.execute()).toMatchObject({ disabled: 0 });
    });

    it('keeps the host’s intent on the row so a human can see what happened', async () => {
      const room = await brokenRoom('not a cron');
      ports.clock.setNow(new Date('2026-03-14T22:00:30.000Z'));
      await useCases.openScheduledRooms.execute();

      // The room is not deleted and the expression is not cleared: someone
      // looking at this row needs to see both what was asked for and that it
      // is not firing.
      const after = await ports.rooms.findById(room.id);
      expect(after).not.toBeNull();
      expect(after?.scheduleCron).toBe('not a cron');
    });

    it('one broken row does not stop the others opening', async () => {
      await brokenRoom('not a cron');
      await useCases.createRoom.execute(host, {
        title: 'Late Night Talk',
        category: 'late_night',
        scheduleCron: '0 22 * * *',
      });

      ports.clock.setNow(new Date('2026-03-14T22:00:30.000Z'));
      const result = await useCases.openScheduledRooms.execute();

      expect(result.opened).toBe(1);
      expect(result.disabled).toBe(1);
    });
  });
});
