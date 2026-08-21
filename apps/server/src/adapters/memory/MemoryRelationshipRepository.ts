import type { Relationship, RelationshipState } from '../../domain/entities/Relationship.js';
import { emptyRelationship } from '../../domain/entities/Relationship.js';
import type { RelationshipRepository } from '../../domain/ports/RelationshipRepository.js';
import type { UserId } from '../../domain/values/ids.js';
import { orderedPair, pairKey } from '../../domain/values/ids.js';

/**
 * ADAPTER (memory): RelationshipRepository.
 *
 * THE INVARIANT THIS FAKE EXISTS TO PROVE
 * ---------------------------------------
 * One row per unordered pair. Every method keys on `pairKey(a, b)`, which
 * normalizes ordering — so `get(a, b)` and `get(b, a)` are provably the same
 * record. A test that blocks in one direction and reads in the other will pass
 * here and in Postgres for the same reason, rather than by coincidence.
 *
 * `transition` is a compare-and-set. As with the surprise redemption, the
 * atomicity comes from there being no `await` between the read and the write.
 */
export class MemoryRelationshipRepository implements RelationshipRepository {
  private readonly rows = new Map<string, Relationship>();

  constructor(private readonly nowFn: () => Date) {}

  async get(a: UserId, b: UserId): Promise<Relationship> {
    // Never null: an unrecorded pair is `none`. See the port's doc comment.
    return this.rows.get(pairKey(a, b)) ?? emptyRelationship(a, b, this.nowFn());
  }

  async transition(
    a: UserId,
    b: UserId,
    expectedFrom: RelationshipState,
    to: RelationshipState,
    actor: { requestedBy: UserId | null; blockedBy: UserId | null },
    at: Date,
  ): Promise<Relationship | null> {
    const key = pairKey(a, b);

    // --- compare-and-set: no await between read and write ---
    const current = this.rows.get(key) ?? emptyRelationship(a, b, at);
    if (current.state !== expectedFrom) return null;

    const [userA, userB] = orderedPair(a, b);
    const updated: Relationship = Object.freeze({
      userA,
      userB,
      state: to,
      requestedBy: actor.requestedBy,
      blockedBy: actor.blockedBy,
      updatedAt: at,
    });
    this.rows.set(key, updated);
    // --- end ---
    return updated;
  }

  async listForUser(
    userId: UserId,
    states: readonly RelationshipState[],
    limit: number,
  ): Promise<readonly Relationship[]> {
    return [...this.rows.values()]
      .filter((r) => (r.userA === userId || r.userB === userId) && states.includes(r.state))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, limit);
  }

  async listBlockedIds(userId: UserId): Promise<readonly UserId[]> {
    const out: UserId[] = [];
    for (const rel of this.rows.values()) {
      if (rel.state !== 'blocked') continue;
      // Both directions: whoever applied the block, neither party sees the other.
      if (rel.userA === userId) out.push(rel.userB);
      else if (rel.userB === userId) out.push(rel.userA);
    }
    return out;
  }

  /** Test helper. Not part of the port. */
  clear(): void {
    this.rows.clear();
  }
}
