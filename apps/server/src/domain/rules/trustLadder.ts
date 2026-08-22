import type { User } from '../entities/User.js';
import type { UserId } from '../values/ids.js';
import type { Relationship } from '../entities/Relationship.js';
import type { RoomMember, RoomRole } from '../entities/RoomMember.js';
import type { Room } from '../entities/Room.js';
import { atLeast } from '../entities/RoomMember.js';
import { isCallAbandoned, isCallOpen, isDmOpen, isRingStale } from '../entities/Relationship.js';
import { isActive } from '../entities/User.js';
import { isRestricted } from '../values/trust.js';
import type { DomainError } from '../errors.js';
import { AuthorizationError, ConflictError } from '../errors.js';

/**
 * THE TRUST LADDER — the single most important rule set in the product.
 *
 * WHY THIS EXISTS
 * ---------------
 * Contact between strangers escalates in fixed rungs, and each rung requires
 * evidence that the previous one happened:
 *
 *     be in a room together  ->  text in room
 *              |
 *              v
 *     host approves you      ->  publish audio to the room
 *              |
 *              v
 *     shared a room session  ->  request a DM  ->  (they accept) DM open
 *              |
 *              v
 *          DM is open        ->  invite to a 1:1 call
 *
 * Every rung is a PURE FUNCTION here, taking already-loaded facts, so that:
 *  - it is unit-testable with no database, no clock and no network;
 *  - the socket edge, the HTTP edge and any future edge cannot each invent
 *    their own slightly different version of the rule;
 *  - a reviewer can read the entire contact-safety model in one file.
 *
 * CONVENTION: each rule comes in two forms. `canX(...)` returns a structured
 * decision for UI affordances ("should I render the DM button?"), and
 * `assertCanX(...)` throws the corresponding DomainError for enforcement.
 * Call sites that ENFORCE must use the assert form — a `canX` used in an `if`
 * that someone later refactors is how authorization bugs are born.
 */

export interface Decision {
  readonly allowed: boolean;
  /** Machine-readable reason, suitable for UI copy lookup. Null when allowed. */
  readonly reason: DenialReason | null;
}

export type DenialReason =
  | 'account_inactive'
  | 'target_inactive'
  | 'trust_restricted'
  | 'blocked'
  | 'no_shared_room'
  | 'dm_not_open'
  | 'dm_already_open'
  | 'call_busy'
  | 'no_pending_call'
  | 'not_a_member'
  | 'not_speaker'
  | 'muted_by_host'
  | 'not_host'
  | 'speaker_slots_full'
  | 'self_target';

const ALLOW: Decision = Object.freeze({ allowed: true, reason: null });
const deny = (reason: DenialReason): Decision => Object.freeze({ allowed: false, reason });

/** Copy shown to the user for each denial. Kept next to the reasons so they cannot drift. */
export const DENIAL_MESSAGES: Readonly<Record<DenialReason, string>> = Object.freeze({
  account_inactive: 'Your account cannot do that right now.',
  target_inactive: 'That person is not available.',
  trust_restricted: 'Your account is limited while recent reports are reviewed.',
  blocked: 'That person is not available.',
  no_shared_room: 'You can only message people after you have shared a room with them.',
  dm_not_open: 'You need an open conversation before you can call.',
  dm_already_open: 'You already have a conversation with this person.',
  call_busy: 'That person is already on a call.',
  no_pending_call: 'There is no call waiting to be answered.',
  not_a_member: 'You are not in this room.',
  not_speaker: 'Only approved speakers can do that.',
  muted_by_host: 'The host has muted you.',
  not_host: 'Only the host can do that.',
  speaker_slots_full: 'All speaker slots are taken right now.',
  self_target: 'You cannot do that to yourself.',
});

/**
 * The error a denial becomes.
 *
 * Most denials are authorization failures, but not all of them: "the line is
 * busy" and "there is no call to answer" are statements about STATE, not about
 * permission. The caller is entirely allowed to make that call — the world just
 * is not currently arranged for it. They return 409 rather than 403, and the
 * distinction is not pedantic: a client shows a retry for one and must not for
 * the other.
 */
function denialError(reason: DenialReason): DomainError {
  const message = DENIAL_MESSAGES[reason];
  switch (reason) {
    case 'not_host':
      return new AuthorizationError(message, 'NOT_HOST', { reason });
    case 'blocked':
      return new AuthorizationError(message, 'BLOCKED', { reason });
    // Conflicts, not refusals — see above.
    case 'call_busy':
      return new ConflictError(message, 'CALL_BUSY', { reason });
    case 'no_pending_call':
      return new ConflictError(message, 'NO_PENDING_CALL', { reason });
    case 'no_shared_room':
    case 'dm_not_open':
    case 'trust_restricted':
      return new AuthorizationError(message, 'TRUST_LADDER_VIOLATION', { reason });
    default:
      return new AuthorizationError(message, 'FORBIDDEN', { reason });
  }
}

function assertDecision(decision: Decision): void {
  if (!decision.allowed && decision.reason !== null) {
    throw denialError(decision.reason);
  }
}

// ---------------------------------------------------------------------------
// RUNG 0 — the account itself must be in good standing.
// ---------------------------------------------------------------------------

/**
 * Every rung below implicitly requires this, so it is factored out rather than
 * repeated (and eventually forgotten in one place).
 */
export function canAct(actor: Pick<User, 'status' | 'trustScore'>): Decision {
  if (!isActive(actor)) return deny('account_inactive');
  if (isRestricted(actor.trustScore)) return deny('trust_restricted');
  return ALLOW;
}

// ---------------------------------------------------------------------------
// RUNG 1 — text in a room you are actually in.
// ---------------------------------------------------------------------------

/**
 * Room text chat is the lowest rung: presence in the room is the only
 * requirement, because the room is the shared context that makes everything
 * above it possible.
 *
 * Note that `mutedByHost` silences a member's TEXT as well as their audio. A
 * host who mutes someone for abuse should not have to do it twice, and a muted
 * user typing the same abuse into chat is the obvious next move.
 */
export function canSendRoomMessage(
  actor: Pick<User, 'status' | 'trustScore'>,
  membership: Pick<RoomMember, 'role' | 'mutedByHost'> | null,
): Decision {
  const base = canAct(actor);
  if (!base.allowed) return base;
  if (membership === null) return deny('not_a_member');
  if (membership.mutedByHost) return deny('muted_by_host');
  return ALLOW;
}

export function assertCanSendRoomMessage(
  actor: Pick<User, 'status' | 'trustScore'>,
  membership: Pick<RoomMember, 'role' | 'mutedByHost'> | null,
): void {
  assertDecision(canSendRoomMessage(actor, membership));
}

// ---------------------------------------------------------------------------
// RUNG 2 — publish audio, which requires an explicit host grant.
// ---------------------------------------------------------------------------

/**
 * The defining rule of the product: EVERYONE joins listen-only. Publishing is
 * granted, never assumed.
 *
 * INVARIANT PROTECTED: a media token with publish rights is only ever issued
 * for a membership whose role is speaker-or-above and which is not host-muted.
 * The LiveKit adapter takes `canPublish` as a parameter precisely so that it
 * cannot make this decision itself.
 */
export function canPublish(
  actor: Pick<User, 'status' | 'trustScore'>,
  membership: Pick<RoomMember, 'role' | 'mutedByHost'> | null,
): Decision {
  const base = canAct(actor);
  if (!base.allowed) return base;
  if (membership === null) return deny('not_a_member');
  if (!atLeast(membership.role, 'speaker')) return deny('not_speaker');
  if (membership.mutedByHost) return deny('muted_by_host');
  return ALLOW;
}

export function assertCanPublish(
  actor: Pick<User, 'status' | 'trustScore'>,
  membership: Pick<RoomMember, 'role' | 'mutedByHost'> | null,
): void {
  assertDecision(canPublish(actor, membership));
}

/**
 * Whether a host may promote one more person onto the stage.
 *
 * `currentSpeakerCount` counts speakers ONLY — the host is not counted against
 * the cap, because a host who fills every slot and then cannot speak in their
 * own room is a bug report, not a feature.
 */
export function canPromoteToSpeaker(
  host: Pick<User, 'status' | 'trustScore'>,
  hostMembership: Pick<RoomMember, 'role'> | null,
  room: Pick<Room, 'maxSpeakers'>,
  currentSpeakerCount: number,
): Decision {
  const base = canAct(host);
  if (!base.allowed) return base;
  if (hostMembership === null) return deny('not_a_member');
  if (hostMembership.role !== 'host') return deny('not_host');
  if (currentSpeakerCount >= room.maxSpeakers) return deny('speaker_slots_full');
  return ALLOW;
}

export function assertCanPromoteToSpeaker(
  host: Pick<User, 'status' | 'trustScore'>,
  hostMembership: Pick<RoomMember, 'role'> | null,
  room: Pick<Room, 'maxSpeakers'>,
  currentSpeakerCount: number,
): void {
  const decision = canPromoteToSpeaker(host, hostMembership, room, currentSpeakerCount);
  if (!decision.allowed && decision.reason === 'speaker_slots_full') {
    // A full stage is a state conflict, not an authorization failure: the host
    // IS allowed to promote, just not right now. Distinct code so the UI can
    // say "wait for a slot" rather than "you are not permitted".
    throw new ConflictError(DENIAL_MESSAGES.speaker_slots_full, 'SPEAKER_SLOTS_FULL', {
      maxSpeakers: room.maxSpeakers,
      currentSpeakerCount,
    });
  }
  assertDecision(decision);
}

/** Host-only moderation powers: kick, mute, remove-speaker. */
export function canModerateRoom(
  actor: Pick<User, 'status'>,
  actorMembership: Pick<RoomMember, 'role'> | null,
  targetUserId: string,
  actorUserId: string,
): Decision {
  // Note: a host under trust restriction keeps moderation powers over their own
  // room. Stripping them would leave a room unmoderated, which is worse.
  if (!isActive(actor)) return deny('account_inactive');
  if (actorMembership === null) return deny('not_a_member');
  if (actorMembership.role !== 'host') return deny('not_host');
  if (targetUserId === actorUserId) return deny('self_target');
  return ALLOW;
}

export function assertCanModerateRoom(
  actor: Pick<User, 'status'>,
  actorMembership: Pick<RoomMember, 'role'> | null,
  targetUserId: string,
  actorUserId: string,
): void {
  assertDecision(canModerateRoom(actor, actorMembership, targetUserId, actorUserId));
}

// ---------------------------------------------------------------------------
// RUNG 3 — direct messages, gated on a shared room session.
// ---------------------------------------------------------------------------

/**
 * The facts a DM decision needs. Passed in rather than fetched so this stays
 * pure; the use case is responsible for loading them.
 *
 * `haveSharedRoomSession` MUST be derived from the durable `room_members`
 * mirror, not from live presence — otherwise a Redis restart would revoke
 * every existing DM right in the system.
 */
export interface DmContext {
  readonly actor: Pick<User, 'status' | 'trustScore'>;
  readonly target: Pick<User, 'status'>;
  readonly relationship: Pick<Relationship, 'state'>;
  readonly haveSharedRoomSession: boolean;
}

export function canRequestDm(ctx: DmContext): Decision {
  const base = canAct(ctx.actor);
  if (!base.allowed) return base;
  if (!isActive(ctx.target)) return deny('target_inactive');
  // A block is reported to the blocked user as generic unavailability, never as
  // "you were blocked" — that turns the safety tool into a provocation.
  if (ctx.relationship.state === 'blocked') return deny('blocked');
  if (isDmOpen(ctx.relationship)) return deny('dm_already_open');
  if (!ctx.haveSharedRoomSession) return deny('no_shared_room');
  return ALLOW;
}

export function assertCanRequestDm(ctx: DmContext): void {
  assertDecision(canRequestDm(ctx));
}

/**
 * Sending an actual DM requires the relationship to be OPEN — a pending
 * request grants no messaging rights, which is the whole point of consent.
 */
export function canSendDm(ctx: Omit<DmContext, 'haveSharedRoomSession'>): Decision {
  const base = canAct(ctx.actor);
  if (!base.allowed) return base;
  if (!isActive(ctx.target)) return deny('target_inactive');
  if (ctx.relationship.state === 'blocked') return deny('blocked');
  if (!isDmOpen(ctx.relationship)) return deny('dm_not_open');
  return ALLOW;
}

export function assertCanSendDm(ctx: Omit<DmContext, 'haveSharedRoomSession'>): void {
  assertDecision(canSendDm(ctx));
}

// ---------------------------------------------------------------------------
// RUNG 4 — 1:1 voice call, gated on an open DM.
// ---------------------------------------------------------------------------

/**
 * The top rung. Requires an open DM, which itself required a shared room, which
 * required both accounts to be in good standing — so this single check
 * transitively enforces the whole ladder.
 */
export function canInviteToCall(ctx: Omit<DmContext, 'haveSharedRoomSession'>): Decision {
  const base = canAct(ctx.actor);
  if (!base.allowed) return base;
  if (!isActive(ctx.target)) return deny('target_inactive');
  if (ctx.relationship.state === 'blocked') return deny('blocked');
  if (!isDmOpen(ctx.relationship)) return deny('dm_not_open');
  return ALLOW;
}

export function assertCanInviteToCall(ctx: Omit<DmContext, 'haveSharedRoomSession'>): void {
  assertDecision(canInviteToCall(ctx));
}

/** Whether an existing call relationship permits joining the 1:1 media room. */
export function canJoinCall(relationship: Pick<Relationship, 'state'>): boolean {
  return isCallOpen(relationship);
}

// ---------------------------------------------------------------------------
// RUNG 4b — signalling. Not "may these two talk", but "is the line free".
// ---------------------------------------------------------------------------

/**
 * `canInviteToCall` above is a question about the RELATIONSHIP; these two are
 * questions about the MOMENT. Two people can be entirely entitled to call each
 * other and still be unable to start one, because they are already in it.
 *
 * Keeping them apart matters: the trust question has a stable answer that the
 * UI can render into a button, and the timing question has an answer that
 * changes second by second and can only be asked at the instant of acting.
 */

/**
 * Whether a call may be PLACED right now.
 *
 * The state machine is what serialises calls: `call_open` is written when the
 * phone starts ringing, so a second dial finds the line busy. The staleness
 * escape hatch is what stops that from becoming permanent when a caller's
 * browser dies mid-ring — see CALL_RING_TIMEOUT_MS.
 */
export function canStartRinging(
  relationship: Pick<Relationship, 'state' | 'updatedAt' | 'requestedBy'>,
  now: Date,
): Decision {
  if (relationship.state === 'blocked') return deny('blocked');

  // Already ringing, or already talking. Allowed through only when the row is
  // one of the two kinds of leftover that no longer describes anything real:
  // a ring nobody answered, or a call nobody ended.
  if (relationship.state === 'call_open') {
    const leftover = isRingStale(relationship, now) || isCallAbandoned(relationship, now);
    return leftover ? ALLOW : deny('call_busy');
  }

  if (!isDmOpen(relationship)) return deny('dm_not_open');
  return ALLOW;
}

/**
 * Whether THIS user may answer.
 *
 * THE ONLY RULE HERE THAT PROTECTS ANYONE: the acceptor must not be the person
 * who dialled. Without it, a caller could accept their own call, the server
 * would emit `call:accepted` to the other party, and their client would join
 * audio they never agreed to. Ringing is consent-neutral; answering is the
 * consent, and it can only be given by the side being rung.
 *
 * Every failure returns the SAME reason. "You cannot accept your own call",
 * "that call timed out" and "nobody is calling you" are all, from the client's
 * point of view, the same fact: there is nothing here to answer.
 */
export function canAcceptCall(
  relationship: Pick<Relationship, 'state' | 'updatedAt' | 'requestedBy'>,
  acceptorId: UserId,
  now: Date,
): Decision {
  if (relationship.state !== 'call_open') return deny('no_pending_call');

  // A row with no recorded initiator cannot prove consent in either
  // direction, so it grants nothing to anyone.
  if (relationship.requestedBy === null) return deny('no_pending_call');

  if (relationship.requestedBy === acceptorId) return deny('no_pending_call');

  if (isRingStale(relationship, now)) return deny('no_pending_call');

  return ALLOW;
}

export function assertCanStartRinging(
  relationship: Pick<Relationship, 'state' | 'updatedAt' | 'requestedBy'>,
  now: Date,
): void {
  assertDecision(canStartRinging(relationship, now));
}

export function assertCanAcceptCall(
  relationship: Pick<Relationship, 'state' | 'updatedAt' | 'requestedBy'>,
  acceptorId: UserId,
  now: Date,
): void {
  assertDecision(canAcceptCall(relationship, acceptorId, now));
}

// ---------------------------------------------------------------------------
// Helpers used by edges to render affordances without duplicating logic.
// ---------------------------------------------------------------------------

/**
 * What a user is allowed to do with another user right now.
 * The frontend uses this to decide which buttons exist; it is NEVER trusted as
 * authorization, which is re-checked server-side on every action.
 */
export interface LadderView {
  readonly canRequestDm: boolean;
  readonly canSendDm: boolean;
  readonly canCall: boolean;
}

export function ladderView(ctx: DmContext): LadderView {
  return {
    canRequestDm: canRequestDm(ctx).allowed,
    canSendDm: canSendDm(ctx).allowed,
    canCall: canInviteToCall(ctx).allowed,
  };
}

/** The role a user gets when they first walk into a room: always listener. */
export function initialRole(isRoomHost: boolean): RoomRole {
  return isRoomHost ? 'host' : 'listener';
}
