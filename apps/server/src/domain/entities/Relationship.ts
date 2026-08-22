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
  /**
   * Who initiated the pending interaction in the CURRENT state.
   *
   *  - `dm_requested` — who asked for the conversation
   *  - `call_open`    — who dialled
   *  - anything else  — null
   *
   * One field rather than two because the two never coexist: a pair cannot have
   * a pending DM request and a live call at the same time, since a call
   * requires the request to have already been accepted. What both cases share
   * is the thing the field actually records — the DIRECTION of an interaction
   * that one side has not yet answered — and that is what makes it a single
   * concept rather than two crammed into one column.
   *
   * It is load-bearing for consent: without it, the person who dialled could
   * also "accept", and the other party's client would be told the call was
   * answered by someone who never picked up.
   */
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
    // call_open -> call_open is ANSWERING: the rung does not change, but the
    // pending direction does. Dialling records who called; picking up clears
    // that, because there is no longer anything waiting to be answered. It is
    // the only self-transition in the machine and it exists so that "ringing"
    // and "connected" are distinguishable without a sixth state that would
    // duplicate every rule attached to call_open.
    call_open: ['call_open', 'dm_open', 'none', 'blocked'],
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

/**
 * How long a call rings before it counts as missed.
 *
 * WHY THIS CONSTANT DECIDES MORE THAN IT LOOKS LIKE
 * -------------------------------------------------
 * `call_open` is written the moment someone dials, which is what stops a second
 * call being placed into a phone that is already ringing. The cost of that
 * choice is a lock: if the caller's browser is closed, crashes, or loses the
 * network before it can send the hang-up, nothing ever moves the pair back to
 * `dm_open` and they can never call each other again.
 *
 * Rather than depending on a cleanup job — which is one more thing that can be
 * down — the lock expires by being IGNORED once it is old enough. Nothing has
 * to run for the pair to recover; the next call simply overwrites the stale
 * row. A missed call is the normal case, not an error path, and it must not
 * need any process to be healthy.
 *
 * Sixty seconds is a real phone's ring: long enough to cross a room, short
 * enough that a pair is never locked out for meaningfully long.
 */
export const CALL_RING_TIMEOUT_MS = 60_000;

/**
 * The backstop for a call that was ANSWERED and never hung up.
 *
 * The ring timeout only rescues a pair whose call was never picked up. A
 * connected call has no such deadline — and must not, since the whole point is
 * to talk for as long as you like — so if both browsers die mid-conversation
 * the pair would be locked in `call_open` permanently by exactly the mechanism
 * that was supposed to prevent that.
 *
 * Two hours is far longer than any real call this product is for, and short
 * enough that the lock is measured in hours rather than forever. As with the
 * ring timeout, nothing has to RUN for this to take effect: the row is simply
 * ignored once it is old enough.
 */
export const CALL_MAX_DURATION_MS = 2 * 60 * 60 * 1000;

/**
 * Whether a ringing call has gone unanswered long enough to be abandoned.
 *
 * Returns false for any state other than `call_open` — a pair sitting at
 * `dm_open` for a year has no ring to be stale, and answering "yes" there would
 * make every caller's staleness check wrong in the safe-looking direction.
 */
export function isRingStale(
  rel: Pick<Relationship, 'state' | 'updatedAt' | 'requestedBy'>,
  now: Date,
): boolean {
  if (rel.state !== 'call_open') return false;
  // A ring requires someone to be ringing. Once the call is answered
  // `requestedBy` is cleared, and a long conversation must never start looking
  // like an abandoned one just because it lasted a minute.
  if (rel.requestedBy === null) return false;
  return now.getTime() - rel.updatedAt.getTime() >= CALL_RING_TIMEOUT_MS;
}

/**
 * Whether an ANSWERED call has been left open long enough to be presumed dead.
 *
 * The mirror image of `isRingStale`: that one covers a call nobody picked up,
 * this one covers a call nobody put down. Together they guarantee that no pair
 * can be locked out of calling each other indefinitely, without any cleanup job
 * needing to be alive.
 */
export function isCallAbandoned(
  rel: Pick<Relationship, 'state' | 'updatedAt' | 'requestedBy'>,
  now: Date,
): boolean {
  if (rel.state !== 'call_open') return false;
  if (rel.requestedBy !== null) return false;
  return now.getTime() - rel.updatedAt.getTime() >= CALL_MAX_DURATION_MS;
}

/** The other party in a relationship, from one user's point of view. */
export function counterpart(rel: Relationship, self: UserId): UserId {
  return rel.userA === self ? rel.userB : rel.userA;
}
