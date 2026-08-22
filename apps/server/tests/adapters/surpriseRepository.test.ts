import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../../src/adapters/postgres/db.js';
import { PostgresSurpriseRepository } from '../../src/adapters/postgres/PostgresSurpriseRepository.js';
import { PostgresUserRepository } from '../../src/adapters/postgres/PostgresUserRepository.js';
import { MemorySurpriseRepository } from '../../src/adapters/memory/MemorySurpriseRepository.js';
import type { SurpriseRepository } from '../../src/domain/ports/SurpriseRepository.js';
import { nullLogger } from '../../src/domain/ports/Logger.js';
import { asSurpriseId, asUserId } from '../../src/domain/values/ids.js';
import { ConflictError, NotFoundError, ValidationError } from '../../src/domain/errors.js';
import { DATABASE_URL, postgresAvailable, truncateAll } from './support.js';

/**
 * INTEGRATION: SurpriseRepository, run against BOTH implementations.
 *
 * WHY THIS SUITE IS THE ONE THAT MATTERS FOR PHASE 5
 * --------------------------------------------------
 * `surprises` was the last port still falling back to the in-memory fake in
 * production wiring (see container.ts). Everything else in Phase 5 - the DM
 * ladder, the call gate - sits on top of a surprise actually being redeemable
 * exactly once, by exactly one person, and surviving a restart.
 *
 * The invariant under test is REDEEM-ONCE. It is not a nicety: two people
 * opening the same code and both being told "this was for you" is a broken
 * promise, and worse, it hands one stranger a relationship edge they did not
 * earn. The fake gets it right for free because JavaScript is single-threaded;
 * Postgres has to earn it with a conditional UPDATE, and only this suite can
 * tell the difference.
 *
 * A NOTE ON TIME
 * --------------
 * The fake judges expiry against its injected clock; the adapter judges it
 * against the `openedAt` the caller passes. Those are the same value in every
 * real call (the use case passes `clock.now()`), and the test pins both to NOW
 * so the contract is compared like for like rather than papering over a drift.
 */
const available = await postgresAvailable();

const SENDER = asUserId('11111111-1111-4111-8111-111111111111');
const RECIPIENT = asUserId('22222222-2222-4222-8222-222222222222');
const OTHER = asUserId('33333333-3333-4333-8333-333333333333');

const NOW = new Date('2025-06-01T12:00:00.000Z');
const LATER = new Date('2025-07-01T12:00:00.000Z');

describe.skipIf(!available)('SurpriseRepository contract', () => {
  let db: Database;

  beforeAll(() => {
    db = createDatabase({ connectionString: DATABASE_URL, poolMax: 4, logger: nullLogger });
  });

  afterAll(async () => {
    await db?.close();
  });

  const implementations: readonly [string, () => SurpriseRepository][] = [
    ['postgres', () => new PostgresSurpriseRepository(db)],
    ['memory', () => new MemorySurpriseRepository(() => NOW)],
  ];

  for (const [name, build] of implementations) {
    describe(name, () => {
      let repo: SurpriseRepository;

      beforeEach(async () => {
        if (name === 'postgres') {
          await truncateAll(db);
          // sender_id and recipient_id are real foreign keys. The fake has no
          // FKs at all, which is exactly the sort of difference this suite is
          // here to surface.
          const users = new PostgresUserRepository(db);
          for (const [id, displayName] of [
            [SENDER, 'Sender'],
            [RECIPIENT, 'Recipient'],
            [OTHER, 'Other'],
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

      const create = (code = 'LOVE7K2M', overrides: Record<string, unknown> = {}) =>
        repo.create({
          id: asSurpriseId(crypto.randomUUID()),
          code,
          senderId: SENDER,
          theme: 'love',
          message: 'thinking of you',
          tasks: [
            { text: 'drink water', done: false },
            { text: 'go outside', done: false },
          ],
          createdAt: NOW,
          expiresAt: LATER,
          ...overrides,
        });

      // -- storage ---------------------------------------------------------

      it('round-trips every field it was given', async () => {
        const created = await create();
        const found = await repo.findById(created.id);

        expect(found).not.toBeNull();
        expect(found?.code).toBe('LOVE7K2M');
        expect(found?.senderId).toBe(SENDER);
        expect(found?.theme).toBe('love');
        expect(found?.message).toBe('thinking of you');
        expect(found?.tasks).toEqual([
          { text: 'drink water', done: false },
          { text: 'go outside', done: false },
        ]);
        expect(found?.createdAt.toISOString()).toBe(NOW.toISOString());
        expect(found?.expiresAt.toISOString()).toBe(LATER.toISOString());
      });

      it('starts unredeemed, with all three redemption fields null', async () => {
        const created = await create();
        expect(created.recipientId).toBeNull();
        expect(created.moodSelected).toBeNull();
        expect(created.openedAt).toBeNull();
      });

      it('finds by code and returns null for a code that was never minted', async () => {
        await create('MISS4B7N');
        expect((await repo.findByCode('MISS4B7N'))?.code).toBe('MISS4B7N');
        expect(await repo.findByCode('MISS0000')).toBeNull();
      });

      it('refuses a duplicate code', async () => {
        await create('SRRY9X3P');
        await expect(create('SRRY9X3P')).rejects.toBeInstanceOf(ConflictError);
      });

      // -- the redeem-once invariant ---------------------------------------

      it('redeem sets recipient, mood and openedAt together', async () => {
        await create('HEYA2M4K');
        const claimed = await repo.redeem('HEYA2M4K', RECIPIENT, 'tired', NOW);

        expect(claimed).not.toBeNull();
        expect(claimed?.recipientId).toBe(RECIPIENT);
        expect(claimed?.moodSelected).toBe('tired');
        expect(claimed?.openedAt?.toISOString()).toBe(NOW.toISOString());
      });

      it('the redemption is durable, not just returned', async () => {
        const created = await create('YAYY7Q2R');
        await repo.redeem('YAYY7Q2R', RECIPIENT, 'happy', NOW);

        const reread = await repo.findById(created.id);
        expect(reread?.recipientId).toBe(RECIPIENT);
        expect(reread?.moodSelected).toBe('happy');
      });

      it('A SECOND REDEMPTION RETURNS NULL', async () => {
        await create('LOVE3H8T');
        const first = await repo.redeem('LOVE3H8T', RECIPIENT, 'soft', NOW);
        const second = await repo.redeem('LOVE3H8T', OTHER, 'happy', NOW);

        expect(first).not.toBeNull();
        expect(second).toBeNull();
      });

      it('a second redemption does not overwrite the first recipient', async () => {
        const created = await create('LOVE5J9W');
        await repo.redeem('LOVE5J9W', RECIPIENT, 'soft', NOW);
        await repo.redeem('LOVE5J9W', OTHER, 'angry', NOW);

        const reread = await repo.findById(created.id);
        expect(reread?.recipientId).toBe(RECIPIENT);
        expect(reread?.moodSelected).toBe('soft');
      });

      it('TWO PEOPLE RACING PRODUCE EXACTLY ONE WINNER', async () => {
        await create('MISS8K3D');

        // Fired without awaiting in between: this is the check-then-act window
        // that a naive "find, then update" implementation loses.
        const results = await Promise.all([
          repo.redeem('MISS8K3D', RECIPIENT, 'sad', NOW),
          repo.redeem('MISS8K3D', OTHER, 'happy', NOW),
        ]);

        expect(results.filter((r) => r !== null)).toHaveLength(1);
      });

      it('refuses to redeem an expired surprise', async () => {
        await create('SRRY1P6V', { expiresAt: new Date('2025-05-01T00:00:00.000Z') });
        expect(await repo.redeem('SRRY1P6V', RECIPIENT, 'meh', NOW)).toBeNull();
      });

      it('returns null rather than throwing for an unknown code', async () => {
        expect(await repo.redeem('NOPE0000', RECIPIENT, 'meh', NOW)).toBeNull();
      });

      // -- tasks -----------------------------------------------------------

      it('toggles one task by index and leaves the others alone', async () => {
        const created = await create('HEYA6R2L');
        const updated = await repo.setTaskDone(created.id, 1, true);

        expect(updated.tasks[0]).toEqual({ text: 'drink water', done: false });
        expect(updated.tasks[1]).toEqual({ text: 'go outside', done: true });
      });

      it('the toggle persists', async () => {
        const created = await create('HEYA8T4M');
        await repo.setTaskDone(created.id, 0, true);
        const reread = await repo.findById(created.id);
        expect(reread?.tasks[0]?.done).toBe(true);
      });

      it('rejects an out-of-range task index', async () => {
        const created = await create('YAYY2W7B');
        await expect(repo.setTaskDone(created.id, 9, true)).rejects.toBeInstanceOf(ValidationError);
        await expect(repo.setTaskDone(created.id, -1, true)).rejects.toBeInstanceOf(ValidationError);
      });

      it('rejects a task toggle on a surprise that does not exist', async () => {
        await expect(
          repo.setTaskDone(asSurpriseId(crypto.randomUUID()), 0, true),
        ).rejects.toBeInstanceOf(NotFoundError);
      });

      // -- listings --------------------------------------------------------

      it('lists what a sender sent, newest first, honouring the limit', async () => {
        await create('LOVE1A1A', { createdAt: new Date('2025-06-01T10:00:00.000Z') });
        await create('LOVE2B2B', { createdAt: new Date('2025-06-01T11:00:00.000Z') });
        await create('LOVE3C3C', { createdAt: new Date('2025-06-01T12:00:00.000Z') });

        const listed = await repo.listSentBy(SENDER, 2);
        expect(listed.map((s) => s.code)).toEqual(['LOVE3C3C', 'LOVE2B2B']);
      });

      it('lists only what a recipient actually opened', async () => {
        await create('MISS1A1A');
        await create('MISS2B2B');
        await repo.redeem('MISS2B2B', RECIPIENT, 'happy', NOW);

        const listed = await repo.listReceivedBy(RECIPIENT, 10);
        expect(listed.map((s) => s.code)).toEqual(['MISS2B2B']);
      });

      it('does not leak one senders surprises into anothers list', async () => {
        await create('LOVE9Z9Z');
        expect(await repo.listSentBy(OTHER, 10)).toHaveLength(0);
      });
    });
  }
});
