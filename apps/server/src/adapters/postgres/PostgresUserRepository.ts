import type { IdentifierKind, User, UserStatus } from '../../domain/entities/User.js';
import type { TrustEvent } from '../../domain/entities/TrustEvent.js';
import type { TrustReason } from '../../domain/values/trust.js';
import type { CreateUserInput, UserRepository } from '../../domain/ports/UserRepository.js';
import type { UserId } from '../../domain/values/ids.js';
import { asUserId } from '../../domain/values/ids.js';
import { TRUST_MAX, TRUST_MIN } from '../../domain/values/trust.js';
import { ConflictError, NotFoundError } from '../../domain/errors.js';
import { isPgError, PG_ERROR, type Database } from './db.js';

/**
 * ADAPTER: UserRepository over Postgres.
 *
 * THE MAPPING BOUNDARY
 * --------------------
 * `toEntity` below is the only function in the codebase that knows a user's
 * `dob` arrives as a Date from a DATE column, or that `trust_score` is an
 * INTEGER. Everything above this file deals in domain entities. That is the
 * whole point of the port: the shape of the table can change without any use
 * case noticing.
 *
 * WHY EVERY QUERY LISTS ITS COLUMNS
 * ---------------------------------
 * No `SELECT *`. A new column added by a migration would silently start
 * flowing into entities, and — worse — a column REMOVED would produce
 * `undefined` at a call site far from the change. Explicit lists turn both into
 * an immediate, local failure.
 */
interface UserRow {
  id: string;
  identifier: string;
  identifier_kind: string;
  display_name: string;
  avatar_seed: string;
  dob: Date;
  trust_score: number;
  status: string;
  created_at: Date;
}

const USER_COLUMNS = `
  id, identifier, identifier_kind, display_name,
  avatar_seed, dob, trust_score, status, created_at
`;

function toEntity(row: UserRow): User {
  return {
    id: asUserId(row.id),
    identifier: row.identifier,
    identifierKind: row.identifier_kind as IdentifierKind,
    displayName: row.display_name,
    avatarSeed: row.avatar_seed,
    dob: row.dob,
    trustScore: row.trust_score,
    status: row.status as UserStatus,
    createdAt: row.created_at,
  };
}

interface TrustEventRow {
  user_id: string;
  delta: number;
  reason: string;
  context: string | null;
  created_at: Date;
}

function toTrustEvent(row: TrustEventRow): TrustEvent {
  return {
    userId: asUserId(row.user_id),
    delta: row.delta,
    reason: row.reason as TrustReason,
    context: row.context,
    createdAt: row.created_at,
  };
}

export class PostgresUserRepository implements UserRepository {
  constructor(private readonly db: Database) {}

  async create(input: CreateUserInput): Promise<User> {
    try {
      const row = await this.db.queryOne<UserRow>(
        `INSERT INTO users (id, identifier, identifier_kind, display_name, avatar_seed, dob, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING ${USER_COLUMNS}`,
        [
          input.id,
          input.identifier,
          input.identifierKind,
          input.displayName,
          input.avatarSeed,
          // The DATE column stores no time, and the value is already midnight
          // UTC (parseDobUtc). Slicing the ISO string avoids the driver
          // applying a local-timezone conversion on the way in.
          input.dob.toISOString().slice(0, 10),
          input.createdAt,
        ],
      );
      // RETURNING on a successful INSERT always yields a row.
      return toEntity(row!);
    } catch (error) {
      if (isPgError(error, PG_ERROR.UNIQUE_VIOLATION)) {
        // Translated at the boundary: callers above see a domain error, not a
        // Postgres error code. The memory fake throws the same thing.
        throw new ConflictError('An account already exists for that contact.');
      }
      throw error;
    }
  }

  async findById(id: UserId): Promise<User | null> {
    const row = await this.db.queryOne<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [
      id,
    ]);
    return row === null ? null : toEntity(row);
  }

  async findByIdentifier(identifier: string): Promise<User | null> {
    // `identifier` is already canonical — normalizeIdentifier ran in the use
    // case. This query does no case folding of its own, deliberately: doing it
    // here would silently diverge from the unique index, which is over the raw
    // stored value.
    const row = await this.db.queryOne<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users WHERE identifier = $1`,
      [identifier],
    );
    return row === null ? null : toEntity(row);
  }

  async findManyByIds(ids: readonly UserId[]): Promise<readonly User[]> {
    if (ids.length === 0) return [];

    // ANY($1) with an array parameter, NOT an interpolated IN list: one query
    // plan regardless of how many ids, and no string building near SQL.
    const rows = await this.db.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    return rows.map(toEntity);
  }

  async updateProfile(
    id: UserId,
    changes: { displayName?: string; avatarSeed?: string },
  ): Promise<User> {
    // COALESCE rather than a dynamically-built SET clause: one static query,
    // and a NULL parameter means "leave it alone". Building SQL from the keys
    // of an object is how a column name eventually comes from user input.
    const row = await this.db.queryOne<UserRow>(
      `UPDATE users
          SET display_name = COALESCE($2, display_name),
              avatar_seed  = COALESCE($3, avatar_seed)
        WHERE id = $1
        RETURNING ${USER_COLUMNS}`,
      [id, changes.displayName ?? null, changes.avatarSeed ?? null],
    );

    if (row === null) throw new NotFoundError('User');
    return toEntity(row);
  }

  async updateStatus(id: UserId, status: UserStatus): Promise<void> {
    const rows = await this.db.query(`UPDATE users SET status = $2 WHERE id = $1 RETURNING id`, [
      id,
      status,
    ]);
    if (rows.length === 0) throw new NotFoundError('User');
  }

  /**
   * Append to the ledger and refresh the cached projection, atomically.
   *
   * The port requires these two writes to be indivisible: a ledger entry
   * without the projection makes the score wrong until the next recompute; a
   * projection without the ledger makes it unexplainable.
   *
   * Note that the score is RECOMPUTED from the ledger rather than incremented.
   * Incrementing would be one fewer scan but would let the cached value drift
   * from its source forever after a single missed write — and the ledger for
   * one user is a handful of rows behind a covering index.
   */
  async appendTrustEvent(event: TrustEvent): Promise<number> {
    return this.db.transaction(async (tx) => {
      const inserted = await tx.query(
        `INSERT INTO trust_events (user_id, delta, reason, context, created_at)
         SELECT $1, $2, $3, $4, $5
          WHERE EXISTS (SELECT 1 FROM users WHERE id = $1)
         RETURNING id`,
        [event.userId, event.delta, event.reason, event.context, event.createdAt],
      );

      // The guarded INSERT inserts nothing when the user does not exist, which
      // is how we get NotFoundError rather than a foreign-key error message
      // leaking a table name to the caller.
      if (inserted.length === 0) throw new NotFoundError('User');

      const row = await tx.queryOne<{ trust_score: number }>(
        `UPDATE users
            SET trust_score = GREATEST($2, LEAST($3, (
                  SELECT COALESCE(SUM(delta), 0) FROM trust_events WHERE user_id = $1
                )))
          WHERE id = $1
          RETURNING trust_score`,
        [event.userId, TRUST_MIN, TRUST_MAX],
      );

      return row!.trust_score;
    });
  }

  async listTrustEvents(userId: UserId, limit: number): Promise<readonly TrustEvent[]> {
    const rows = await this.db.query<TrustEventRow>(
      `SELECT user_id, delta, reason, context, created_at
         FROM trust_events
        WHERE user_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2`,
      [userId, limit],
    );
    return rows.map(toTrustEvent);
  }
}
