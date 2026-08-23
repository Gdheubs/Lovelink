import pg from 'pg';
import type { Logger } from '../../domain/ports/Logger.js';

const { Pool, types } = pg;

/**
 * The Postgres connection pool and the thin query surface the repositories use.
 *
 * WHY A HAND-ROLLED HELPER RATHER THAN A QUERY BUILDER
 * ----------------------------------------------------
 * See ADR 0003. What the repositories actually need is: run parameterised SQL,
 * get typed rows back, and occasionally do several statements in one
 * transaction. That is three functions. A query builder would add a dependency,
 * an abstraction, and a temptation to build queries dynamically — and dynamic
 * SQL construction is where injection bugs come from.
 *
 * PARAMETERS ARE THE ONLY WAY VALUES ENTER A QUERY. There is no string
 * interpolation helper here, deliberately: if one existed, someone would use it.
 */

// ---------------------------------------------------------------------------
// Type parsing
// ---------------------------------------------------------------------------

/**
 * `pg` returns BIGINT (OID 20) as a string, because a 64-bit integer does not
 * fit in a JS number. Our bigints are surrogate keys and counters that will
 * never approach 2^53, and returning them as strings makes every count a
 * `Number()` call at the call site — one of which will eventually be forgotten
 * and produce `"5" + 1 === "51"`.
 */
types.setTypeParser(types.builtins.INT8, (value) => Number.parseInt(value, 10));

/**
 * NUMERIC (OID 1700) likewise arrives as a string. `trust_score` is the only
 * numeric-adjacent column and it is an INTEGER, so this is defensive: if a
 * NUMERIC column is ever added, it should behave like a number.
 */
types.setTypeParser(types.builtins.NUMERIC, (value) => Number.parseFloat(value));

/**
 * DATE (OID 1082) — `users.dob`.
 *
 * By default `pg` parses a bare DATE using the LOCAL timezone, which shifts a
 * date of birth by a day either side of UTC depending on where the process
 * runs. That is precisely the bug `parseDobUtc` exists to prevent on the way
 * in, so we must not reintroduce it on the way out. Parse as midnight UTC.
 */
types.setTypeParser(types.builtins.DATE, (value) => new Date(`${value}T00:00:00.000Z`));

// ---------------------------------------------------------------------------

export interface Database {
  /** Run a parameterised query and return the rows. */
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<R[]>;

  /** Run a query expected to return at most one row. */
  queryOne<R extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<R | null>;

  /**
   * Run several statements atomically.
   *
   * The callback receives a client bound to a single connection; every query it
   * runs is inside the same transaction. Commits on return, rolls back on throw.
   * This is what makes "append a trust event AND update the cached score" a
   * single indivisible operation, as UserRepository's contract requires.
   */
  transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;

  /** True when the database answers. Used by /readyz. */
  ping(): Promise<boolean>;

  close(): Promise<void>;
}

export interface Transaction {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<R[]>;
  queryOne<R extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<R | null>;
}

export interface DatabaseOptions {
  readonly connectionString: string;
  readonly poolMax: number;
  readonly logger: Logger;
  /**
   * Require TLS, and whether to verify the server's certificate.
   *
   * Managed Postgres — Supabase, Neon, RDS — is reached over the public
   * internet, so TLS is not optional there. It is optional against a local
   * container, which has no certificate at all.
   */
  readonly ssl?: { readonly rejectUnauthorized: boolean } | false;
}

/**
 * Whether this connection string points at a TRANSACTION-mode connection
 * pooler, which changes what the driver is allowed to do.
 *
 * WHY THIS MATTERS, AND WHY IT IS DETECTED RATHER THAN CONFIGURED
 * --------------------------------------------------------------
 * Supabase offers three ways in, and they are not interchangeable:
 *
 *   - :5432 direct        — a real session. Everything works.
 *   - :5432 via Supavisor — session mode. Everything works.
 *   - :6543 via Supavisor — TRANSACTION mode. A connection is handed to
 *                           whichever query needs it and taken back at COMMIT,
 *                           so no session state survives between statements.
 *
 * Transaction mode is what you want for a high-connection deployment, and it
 * silently breaks anything that assumes a session survives between statements:
 *
 *   - LISTEN / NOTIFY          (we use Redis pub/sub instead — see EventBus)
 *   - session-level SET        (we set nothing)
 *   - advisory locks held across statements
 *   - temporary tables
 *   - NAMED prepared statements
 *
 * THIS DRIVER IS SAFE ON ALL FIVE, and the last one is worth being precise
 * about because it is where the folklore is wrong: `node-postgres` only creates
 * a named prepared statement when a query is given an explicit `name`, which
 * nothing here does. The famous "prepared statement s1 already exists" error
 * belongs to drivers and ORMs that promote statements automatically. We are not
 * one, so no workaround is needed — but a future change that adds a `name`, a
 * `LISTEN`, or a session-level `SET` would break in production only, under
 * load, on one connection out of many.
 *
 * Hence this function and the boot log: the constraint is invisible in the
 * code, so it is stated where someone will see it.
 *
 * `transaction()` below is fine either way — a pooler holds one backend for the
 * duration of a BEGIN/COMMIT, which is exactly what it is for.
 *
 * Detected from the URL rather than configured, because the port number IS the
 * mode and a separate flag is one more thing to get wrong.
 */
export function usesTransactionPooler(connectionString: string): boolean {
  try {
    const url = new URL(connectionString);
    // Supavisor's transaction port, and pgBouncer's conventional one.
    if (url.port === '6543') return true;
    // An explicit marker some providers document.
    return url.searchParams.get('pgbouncer') === 'true';
  } catch {
    return false;
  }
}

export function createDatabase(options: DatabaseOptions): Database {
  const log = options.logger.child({ component: 'postgres' });

  const pooled = usesTransactionPooler(options.connectionString);

  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.poolMax,
    // A connection that has been idle this long is probably held by a proxy
    // that has already forgotten about it.
    idleTimeoutMillis: 30_000,
    // Fail fast rather than hanging a request forever when the pool is
    // exhausted or the database is unreachable.
    connectionTimeoutMillis: 5_000,
    ...(options.ssl === undefined ? {} : { ssl: options.ssl }),
  });

  if (pooled) {
    log.info(
      { mode: 'transaction-pooler' },
      'connected through a transaction pooler: no session state survives between statements',
    );
  }

  /**
   * An idle client erroring (a network blip, a server restart) emits on the
   * pool. Without a listener, Node treats it as an unhandled 'error' event and
   * kills the process — so this listener is not optional politeness, it is what
   * stops a transient database hiccup from taking down the API.
   */
  pool.on('error', (error) => {
    log.error({ err: error.message }, 'idle postgres client error');
  });

  return {
    async query(sql, params = []) {
      const result = await pool.query(sql, params as unknown[]);
      return result.rows;
    },

    async queryOne(sql, params = []) {
      const result = await pool.query(sql, params as unknown[]);
      return result.rows[0] ?? null;
    },

    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const tx: Transaction = {
          async query(sql, params = []) {
            const result = await client.query(sql, params as unknown[]);
            return result.rows;
          },
          async queryOne(sql, params = []) {
            const result = await client.query(sql, params as unknown[]);
            return result.rows[0] ?? null;
          },
        };

        const value = await fn(tx);
        await client.query('COMMIT');
        return value;
      } catch (error) {
        // Rollback is itself allowed to fail (the connection may already be
        // gone). Swallow that so the ORIGINAL error is what propagates —
        // otherwise the useful message is replaced by a confusing one.
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        // Always returned to the pool, including on failure. A leaked client
        // is invisible until the pool is exhausted, at which point every
        // request hangs.
        client.release();
      }
    },

    async ping() {
      try {
        await pool.query('SELECT 1');
        return true;
      } catch {
        return false;
      }
    },

    async close() {
      await pool.end();
    },
  };
}

/**
 * Postgres error codes we translate into domain errors.
 * Full list: https://www.postgresql.org/docs/current/errcodes-appendix.html
 */
export const PG_ERROR = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
} as const;

export function isPgError(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}
