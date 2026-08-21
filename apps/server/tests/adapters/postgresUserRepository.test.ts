import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../../src/adapters/postgres/db.js';
import { PostgresUserRepository } from '../../src/adapters/postgres/PostgresUserRepository.js';
import { MemoryUserRepository } from '../../src/adapters/memory/MemoryUserRepository.js';
import type { UserRepository } from '../../src/domain/ports/UserRepository.js';
import { nullLogger } from '../../src/domain/ports/Logger.js';
import { asUserId } from '../../src/domain/values/ids.js';
import { TRUST_MAX, TRUST_MIN } from '../../src/domain/values/trust.js';
import { DATABASE_URL, postgresAvailable, truncateAll } from './support.js';

/**
 * INTEGRATION: PostgresUserRepository against a real database.
 *
 * WHY IT RUNS EVERY ASSERTION TWICE
 * ---------------------------------
 * Each behaviour is checked against BOTH the Postgres adapter and the in-memory
 * fake. That is the whole safety net behind ADR 0001: unit tests everywhere
 * else in the repo run against the fake, and they are only trustworthy if the
 * fake behaves like the real thing.
 *
 * Running the same suite against both is what catches drift — a unique
 * constraint the fake forgot to model, an atomicity guarantee it accidentally
 * provides for free, a trust score the fake clamps and Postgres does not.
 * Without this, a fake slowly becomes "the convenient version" and the unit
 * suite becomes decorative.
 */
const available = await postgresAvailable();

describe.skipIf(!available)('UserRepository contract', () => {
  let db: Database;

  beforeAll(() => {
    db = createDatabase({ connectionString: DATABASE_URL, poolMax: 4, logger: nullLogger });
  });

  afterAll(async () => {
    await db?.close();
  });

  /**
   * The two implementations under test. `postgres` is the real one; `memory` is
   * the fake every other test in the repo relies on.
   */
  const implementations: readonly [string, () => UserRepository][] = [
    ['postgres', () => new PostgresUserRepository(db)],
    ['memory', () => new MemoryUserRepository()],
  ];

  for (const [name, build] of implementations) {
    describe(name, () => {
      let repo: UserRepository;

      beforeEach(async () => {
        if (name === 'postgres') await truncateAll(db);
        repo = build();
      });

      const create = (id: string, identifier: string) =>
        repo.create({
          id: asUserId(id),
          identifier,
          identifierKind: identifier.includes('@') ? 'email' : 'phone',
          displayName: 'Priya',
          avatarSeed: 'seed-abc123',
          dob: new Date('1995-06-15T00:00:00.000Z'),
          createdAt: new Date('2025-01-01T10:00:00.000Z'),
        });

      const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

      it('round-trips a user', async () => {
        const created = await create(uuid(1), 'priya@example.com');

        expect(created.displayName).toBe('Priya');
        expect(created.status).toBe('active');
        expect(created.trustScore).toBe(0);

        const found = await repo.findById(created.id);
        expect(found?.identifier).toBe('priya@example.com');
      });

      it('preserves the date of birth EXACTLY, with no timezone drift', async () => {
        // The whole point of parseDobUtc. A DATE column parsed in local time
        // shifts a birthday by a day, which can flip an 18th-birthday signup
        // depending on where the server happens to run.
        const created = await create(uuid(2), 'dob@example.com');
        const found = await repo.findById(created.id);

        expect(found?.dob.toISOString()).toBe('1995-06-15T00:00:00.000Z');
        expect(found?.dob.getUTCDate()).toBe(15);
        expect(found?.dob.getUTCMonth()).toBe(5);
      });

      it('enforces one account per identifier', async () => {
        await create(uuid(3), 'dup@example.com');
        // Both implementations must produce the SAME domain error, not a
        // Postgres error code in one and a hand-rolled one in the other.
        await expect(create(uuid(4), 'dup@example.com')).rejects.toThrow(/already exists/i);
      });

      it('finds by identifier without any case folding of its own', async () => {
        // Normalization is the use case's job; the repository must not silently
        // do a second, different version of it.
        await create(uuid(5), 'exact@example.com');
        expect(await repo.findByIdentifier('exact@example.com')).not.toBeNull();
        expect(await repo.findByIdentifier('EXACT@example.com')).toBeNull();
      });

      it('batch loads, skipping ids that do not exist', async () => {
        await create(uuid(6), 'a@example.com');
        await create(uuid(7), 'b@example.com');

        const found = await repo.findManyByIds([
          asUserId(uuid(6)),
          asUserId(uuid(7)),
          asUserId(uuid(99)),
        ]);
        expect(found).toHaveLength(2);
      });

      it('returns an empty array for an empty id list', async () => {
        expect(await repo.findManyByIds([])).toEqual([]);
      });

      it('updates only the fields provided', async () => {
        const created = await create(uuid(8), 'patch@example.com');

        const renamed = await repo.updateProfile(created.id, { displayName: 'Priya S' });
        expect(renamed.displayName).toBe('Priya S');
        // Untouched field survives.
        expect(renamed.avatarSeed).toBe('seed-abc123');

        const reseeded = await repo.updateProfile(created.id, { avatarSeed: 'seed-xyz789' });
        expect(reseeded.avatarSeed).toBe('seed-xyz789');
        expect(reseeded.displayName).toBe('Priya S');
      });

      it('throws when updating a user that does not exist', async () => {
        await expect(
          repo.updateProfile(asUserId(uuid(404)), { displayName: 'Ghost' }),
        ).rejects.toThrow(/not found/i);
      });

      it('updates status', async () => {
        const created = await create(uuid(9), 'status@example.com');
        await repo.updateStatus(created.id, 'banned');
        expect((await repo.findById(created.id))?.status).toBe('banned');
      });

      // -- the trust ledger ------------------------------------------------

      it('derives trust_score from the ledger, atomically', async () => {
        const created = await create(uuid(10), 'trust@example.com');

        const after1 = await repo.appendTrustEvent({
          userId: created.id,
          delta: 3,
          reason: 'promoted_to_speaker',
          context: null,
          createdAt: new Date('2025-01-02T10:00:00.000Z'),
        });
        expect(after1).toBe(3);

        const after2 = await repo.appendTrustEvent({
          userId: created.id,
          delta: -25,
          reason: 'report_upheld',
          context: 'report-7',
          createdAt: new Date('2025-01-03T10:00:00.000Z'),
        });
        expect(after2).toBe(-22);

        // The cached projection on the row agrees with the returned value.
        expect((await repo.findById(created.id))?.trustScore).toBe(-22);
      });

      it('clamps the projection at both ends', async () => {
        const created = await create(uuid(11), 'clamp@example.com');

        await repo.appendTrustEvent({
          userId: created.id,
          delta: 5000,
          reason: 'manual_adjustment',
          context: null,
          createdAt: new Date(),
        });
        expect((await repo.findById(created.id))?.trustScore).toBe(TRUST_MAX);

        await repo.appendTrustEvent({
          userId: created.id,
          delta: -10_000,
          reason: 'manual_adjustment',
          context: null,
          createdAt: new Date(),
        });
        expect((await repo.findById(created.id))?.trustScore).toBe(TRUST_MIN);
      });

      it('refuses a trust event for a user that does not exist', async () => {
        await expect(
          repo.appendTrustEvent({
            userId: asUserId(uuid(404)),
            delta: 1,
            reason: 'manual_adjustment',
            context: null,
            createdAt: new Date(),
          }),
        ).rejects.toThrow(/not found/i);
      });

      it('lists the ledger newest first, so a user can be shown why', async () => {
        const created = await create(uuid(12), 'ledger@example.com');

        await repo.appendTrustEvent({
          userId: created.id,
          delta: 2,
          reason: 'room_session_completed',
          context: null,
          createdAt: new Date('2025-01-01T10:00:00.000Z'),
        });
        await repo.appendTrustEvent({
          userId: created.id,
          delta: -25,
          reason: 'report_upheld',
          context: 'report-9',
          createdAt: new Date('2025-02-01T10:00:00.000Z'),
        });

        const events = await repo.listTrustEvents(created.id, 10);
        expect(events).toHaveLength(2);
        expect(events[0]?.reason).toBe('report_upheld');
        expect(events[0]?.context).toBe('report-9');
        expect(events[1]?.reason).toBe('room_session_completed');
      });

      it('honours the ledger limit', async () => {
        const created = await create(uuid(13), 'limit@example.com');
        for (let i = 0; i < 5; i += 1) {
          await repo.appendTrustEvent({
            userId: created.id,
            delta: 1,
            reason: 'surprise_sent',
            context: null,
            createdAt: new Date(Date.UTC(2025, 0, i + 1)),
          });
        }
        expect(await repo.listTrustEvents(created.id, 3)).toHaveLength(3);
      });
    });
  }
});

describe.skipIf(available)('UserRepository contract', () => {
  it.skip('skipped: Postgres is not reachable (run `docker compose up -d` and `npm run migrate`)', () => {
    // Placeholder so the reason appears in the test output rather than the
    // suite silently vanishing.
  });
});
