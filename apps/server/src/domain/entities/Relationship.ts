import type { UserId } from '../values/ids.js';
import { orderedPair } from '../values/ids.js';

/**
 * The connection between two users, and the rung of the trust ladder they have
 * reached together.
 *
 * WHY THIS SHAPE
 * --------------
 * The product's safety model is progressive disclosure: strangers meet in a
 * room, then text, then DM, then talk 1:1. That progression is a STATE MACHINE,
 * and modelling it as one (rather than as three booleans) means an invalid
 * combination — "call open but DM never accepted" — is unrepresentable rather
 * than merely unlikely.
 *
 * INVARIANT: one row per unordered pair. `userA` is always the
 * lexicographically smaller id (see `orderedPair`), so a pair cannot acquire
 * two contradictory rows depending on who acted first. `requestedBy` records
 * the direction of a pending request, which the ordering would otherwise lose.
 */
export type RelationshipState = 'none' | 'dm_requested' | 'dm_open' | 'call_open' | 'blocked';

export interface Relationship {
  readonly userA: UserId;
  readonly userB: UserId;
  readonly state: RelationshipState;
  /** Who initiated the pending request. Null unless state is `dm_requested`. */
  readonly requestedBy: UserId | null;
  /** Who applied the block. Null unless state is `blocked`. */
  readonly blockedBy: UserId | null;
  readonly updatedAt: Date;
}

/**
 * Legal transitions. Anything not listed here is rejected by `canTransition`.
 *
 * Note that `blocked` is reachable from every state and is terminal from the
 * blocker's perspective — unblocking is a deliberate separate action that
 * returns the pair to `none`, NOT to whatever they had before. Restoring a
 * previous rung on unblock would let a blocked user regain call access without
 * the other person re-consenting.
 */
const TRANSITIONS: Readonly<Record<RelationshipState, readonly RelationshipState[]>> =
  Object.freeze({
    none: ['dm_requested', 'blocked'],
    dm_requested: ['dm_open', 'none', 'blocked'],
    dm_open: ['call_open', 'none', 'blocked'],
    call_open: ['dm_open', 'none', 'blocked'],
    blocked: ['none'],
  });

export function canTransition(from: RelationshipState, to: RelationshipState): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

/** A relationship row that does not exist yet is semantically `none`. */
export function emptyRelationship(a: UserId, b: UserId, now: Date): Relationship {
  const [userA, userB] = orderedPair(a, b);
  return {
    userA,
    userB,
    state: 'none',
    requestedBy: null,
    blockedBy: null,
    updatedAt: now,
  };
}

export function isBlocked(rel: Pick<Relationship, 'state'>): boolean {
  return rel.state === 'blocked';
}

export function isDmOpen(rel: Pick<Relationship, 'state'>): boolean {
  return rel.state === 'dm_open' || rel.state === 'call_open';
}

export function isCallOpen(rel: Pick<Relationship, 'state'>): boolean {
  return rel.state === 'call_open';
}

/** The other party in a relationship, from one user's point of view. */
export function counterpart(rel: Relationship, self: UserId): UserId {
  return rel.userA === self ? rel.userB : rel.userA;
}
