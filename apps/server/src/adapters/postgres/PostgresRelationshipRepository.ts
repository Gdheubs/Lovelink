import type { Relationship, RelationshipState } from '../../domain/entities/Relationship.js';
import { emptyRelationship } from '../../domain/entities/Relationship.js';
import type { RelationshipRepository } from '../../domain/ports/RelationshipRepository.js';
import type { UserId } from '../../domain/values/ids.js';
import { asUserId, orderedPair } from '../../domain/values/ids.js';
import type { Clock } from '../../domain/ports/Clock.js';
import type { Database } from './db.js';

/**
 * ADAPTER: RelationshipRepository over Postgres.
 *
 * ONE ROW PER UNORDERED PAIR
 * --------------------------
 * Every query normalises through `orderedPair`, so `(a,b)` and `(b,a)` address
 * the same record. The database enforces it too — `relationships_ordered_pair`
 * CHECKs `user_a < user_b` — which means a bug in this file surfaces as a
 * constraint violation rather than as a second, contradictory row.
 *
 * That matters more than it looks: without it, A could block B while B still
 * saw an open DM, because each would be reading their own row.
 *
 * WHY `transition` TAKES AN EXPECTED STATE
 * ----------------------------------------
 * It is a compare-and-set. Consider a `dm:accept` racing a `block`: both read
 * `dm_requested`, both decide, and whichever writes last wins — which could
 * silently reopen a conversation the other person just closed. Passing the
 * state the caller decided from turns that into one winner and one refusal.
 */
interface RelationshipRow {
  user_a: string;
  user_b: string;
  state: string;
  requested_by: string | null;
  blocked_by: string | null;
  updated_at: Date;
}

const COLUMNS = `user_a, user_b, state, requested_by, blocked_by, updated_at`;

function toRelationship(row: RelationshipRow): Relationship {
  return {
    userA: asUserId(row.user_a),
    userB: asUserId(row.user_b),
    state: row.state as RelationshipState,
    requestedBy: row.requested_by === null ? null : asUserId(row.requested_by),
    blockedBy: row.blocked_by === null ? null : asUserId(row.blocked_by),
    updatedAt: row.updated_at,
  };
}

export class PostgresRelationshipRepository implements RelationshipRepository {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  /**
   * Never null: an unrecorded pair is `none`.
   *
   * Returning a synthetic relationship rather than null means every
   * trust-ladder call site can ask a question without a null check first — and
   * one of them would eventually forget and treat `undefined.state` as
   * permission.
   */
  async get(a: UserId, b: UserId): Promise<Relationship> {
    const [userA, userB] = orderedPair(a, b);

    const row = await this.db.queryOne<RelationshipRow>(
      `SELECT ${COLUMNS} FROM relationships WHERE user_a = $1 AND user_b = $2`,
      [userA, userB],
    );

    return row === null ? emptyRelationship(a, b, this.clock.now()) : toRelationship(row);
  }

  async transition(
    a: UserId,
    b: UserId,
    expectedFrom: RelationshipState,
    to: RelationshipState,
    actor: { requestedBy: UserId | null; blockedBy: UserId | null },
    at: Date,
  ): Promise<Relationship | null> {
    const [userA, userB] = orderedPair(a, b);

    /**
     * One statement, so the compare and the set cannot be separated.
     *
     * The INSERT branch handles a pair with no row yet, which is semantically
     * `none`; `WHERE relationships.state = $3` guards the UPDATE branch. A
     * caller expecting `none` on a pair that already has a row therefore fails
     * correctly, and a caller expecting a real state on a missing row inserts
     * nothing — hence the `WHERE $3 = 'none'` guard on the values.
     */
    const row = await this.db.queryOne<RelationshipRow>(
      `INSERT INTO relationships (user_a, user_b, state, requested_by, blocked_by, updated_at)
       SELECT $1, $2, $4, $5, $6, $7
        WHERE $3 = 'none'
       ON CONFLICT (user_a, user_b) DO UPDATE
          SET state = EXCLUDED.state,
              requested_by = EXCLUDED.requested_by,
              blocked_by = EXCLUDED.blocked_by,
              updated_at = EXCLUDED.updated_at
        WHERE relationships.state = $3
       RETURNING ${COLUMNS}`,
      [userA, userB, expectedFrom, to, actor.requestedBy, actor.blockedBy, at],
    );

    if (row !== null) return toRelationship(row);

    // The INSERT was skipped because `expectedFrom` was not 'none'. Fall back
    // to a plain guarded UPDATE for the existing-row case.
    const updated = await this.db.queryOne<RelationshipRow>(
      `UPDATE relationships
          SET state = $4, requested_by = $5, blocked_by = $6, updated_at = $7
        WHERE user_a = $1 AND user_b = $2 AND state = $3
        RETURNING ${COLUMNS}`,
      [userA, userB, expectedFrom, to, actor.requestedBy, actor.blockedBy, at],
    );

    return updated === null ? null : toRelationship(updated);
  }

  async listForUser(
    userId: UserId,
    states: readonly RelationshipState[],
    limit: number,
  ): Promise<readonly Relationship[]> {
    if (states.length === 0) return [];

    const rows = await this.db.query<RelationshipRow>(
      `SELECT ${COLUMNS}
         FROM relationships
        WHERE (user_a = $1 OR user_b = $1)
          AND state = ANY($2::text[])
        ORDER BY updated_at DESC
        LIMIT $3`,
      [userId, states, limit],
    );
    return rows.map(toRelationship);
  }

  /**
   * Everyone this user cannot see, in BOTH directions.
   *
   * Blocking is mutual by design: the blocked party also stops seeing the
   * blocker. Returning only one direction would let a blocked user keep
   * watching someone who wanted to be rid of them.
   */
  async listBlockedIds(userId: UserId): Promise<readonly UserId[]> {
    const rows = await this.db.query<{ other: string }>(
      `SELECT CASE WHEN user_a = $1 THEN user_b ELSE user_a END AS other
         FROM relationships
        WHERE (user_a = $1 OR user_b = $1) AND state = 'blocked'`,
      [userId],
    );
    return rows.map((row) => asUserId(row.other));
  }
}
