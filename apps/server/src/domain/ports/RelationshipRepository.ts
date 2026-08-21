import type { Relationship, RelationshipState } from '../entities/Relationship.js';
import type { UserId } from '../values/ids.js';

/**
 * PORT: RelationshipRepository
 *
 * WHY `get` NEVER RETURNS NULL
 * ----------------------------
 * Two users who have never interacted have a relationship — it is `none`. If
 * this method returned null, every trust-ladder call site would need a null
 * check before it could ask a question, and one of them would eventually forget
 * and treat `undefined.state` as permission. Returning a synthetic `none`
 * relationship makes the absent case indistinguishable from the explicit one at
 * every point of use.
 *
 * INVARIANT: exactly one row per unordered pair. Implementations MUST key on
 * `orderedPair(a, b)` (see values/ids.ts) so that `get(a, b)` and `get(b, a)`
 * are the same record — otherwise A can block B while B still sees an open DM.
 */

export interface RelationshipRepository {
  /** Never null: an unrecorded pair is returned as state `none`. */
  get(a: UserId, b: UserId): Promise<Relationship>;

  /**
   * Move a pair to a new state.
   *
   * The `expectedFrom` parameter makes this a compare-and-set: the write only
   * lands if the relationship is still in the state the caller decided from.
   * Without it, two racing `dm:accept` and `dm:block` actions resolve by
   * whichever query returns last, and a block can be silently overwritten by an
   * accept. Returns null when the expectation failed.
   */
  transition(
    a: UserId,
    b: UserId,
    expectedFrom: RelationshipState,
    to: RelationshipState,
    actor: { requestedBy: UserId | null; blockedBy: UserId | null },
    at: Date,
  ): Promise<Relationship | null>;

  /** Every relationship involving a user in the given states. Powers the DM list. */
  listForUser(
    userId: UserId,
    states: readonly RelationshipState[],
    limit: number,
  ): Promise<readonly Relationship[]>;

  /**
   * Users this person has blocked, or who have blocked them.
   * Loaded once per room join so the member list and chat can suppress both
   * directions without a query per message.
   */
  listBlockedIds(userId: UserId): Promise<readonly UserId[]>;
}
