import { Redis } from 'ioredis';
import pg from 'pg';

/**
 * Shared setup for adapter integration tests.
 *
 * THE SKIP-IF-UNREACHABLE RULE
 * ----------------------------
 * These suites need real Postgres and Redis. A contributor who has just cloned
 * the repo has neither, and a red test suite on first run teaches them that red
 * is normal — which is far more expensive than the coverage we would gain by
 * failing loudly.
 *
 * So each suite probes its service and skips when it is absent. CI starts the
 * services first (see .github/workflows/ci.yml), so nothing is skipped there,
 * and the `integration` job would fail if an adapter genuinely broke.
 *
 * The distinction that makes this safe: `npm run ci` — the fast gate — does not
 * include these at all. A green local `ci` never depended on them in the first
 * place.
 */

export const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://loverlink:loverlink@localhost:5432/loverlink';

export const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

/** True when a Postgres accepting our schema is reachable. */
export async function postgresAvailable(): Promise<boolean> {
  const client = new pg.Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    // Not merely "is something listening" — the migrations must have run, or
    // every test would fail with a confusing missing-relation error instead of
    // a clean skip.
    const { rows } = await client.query(`SELECT to_regclass('public.users') AS t`);
    return rows[0]?.t !== null;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function redisAvailable(): Promise<boolean> {
  const client = new Redis(REDIS_URL, {
    lazyConnect: true,
    connectTimeout: 2000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  try {
    await client.connect();
    await client.ping();
    return true;
  } catch {
    return false;
  } finally {
    client.disconnect();
  }
}

export function redisClient(): Redis {
  return new Redis(REDIS_URL, { maxRetriesPerRequest: 3 });
}

/**
 * Wipe the tables these tests touch, in foreign-key-safe order.
 *
 * TRUNCATE ... CASCADE rather than DELETE: it is faster, it resets the identity
 * sequences, and CASCADE saves us from having to keep this list in dependency
 * order as the schema grows.
 */
export async function truncateAll(db: {
  query: (sql: string, params?: readonly unknown[]) => Promise<unknown>;
}): Promise<void> {
  await db.query(`
    TRUNCATE TABLE
      trust_events, bans, reports, direct_messages,
      surprises, relationships, room_members, rooms, users
    RESTART IDENTITY CASCADE
  `);
}

/** Clear only the keys this project owns, never the whole Redis. */
export async function clearRedisNamespace(client: Redis): Promise<void> {
  let cursor = '0';
  do {
    const [next, keys]: [string, string[]] = await client.scan(
      cursor,
      'MATCH',
      'loverlink:*',
      'COUNT',
      500,
    );
    cursor = next;
    if (keys.length > 0) await client.del(...keys);
  } while (cursor !== '0');
}
