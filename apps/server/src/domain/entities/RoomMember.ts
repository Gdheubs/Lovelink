import type { RoomId, UserId } from '../values/ids.js';

/**
 * A user's standing inside one room.
 *
 * WHY THIS SHAPE
 * --------------
 * Roles are a strict ladder — a host is also a speaker, a speaker is also a
 * listener — so authorization asks `atLeast(role, 'speaker')` rather than
 * enumerating cases at every call site and eventually missing one.
 *
 * IMPORTANT: the LIVE truth of who is in a room lives in the PresenceStore
 * (Redis in production). This entity is the durable mirror written to
 * `room_members` for audit, moderation history, and — critically — the trust
 * ladder's "were these two ever in a room together?" question, which must
 * survive a Redis flush or it would silently revoke everyone's DM rights.
 */
export type RoomRole = 'listener' | 'speaker' | 'host';

const ROLE_RANK: Readonly<Record<RoomRole, number>> = Object.freeze({
  listener: 0,
  speaker: 1,
  host: 2,
});

export interface RoomMember {
  readonly roomId: RoomId;
  readonly userId: UserId;
  readonly role: RoomRole;
  readonly joinedAt: Date;
  /** Set when the member left; null while present. Kept for session history. */
  readonly leftAt: Date | null;
  /** Host-applied mute. Independent of the user's own mic button. */
  readonly mutedByHost: boolean;
}

/** True when `role` carries at least the privileges of `required`. */
export function atLeast(role: RoomRole, required: RoomRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[required];
}

/**
 * Publishing audio is a privilege, never a default.
 *
 * INVARIANT: this is the ONLY function that decides whether a media token may
 * be issued with publish rights. The LiveKit adapter must never make that call
 * itself — see rules/trustLadder.ts and app/ApproveSpeaker.ts.
 */
export function canPublishAudio(member: Pick<RoomMember, 'role' | 'mutedByHost'>): boolean {
  return atLeast(member.role, 'speaker') && !member.mutedByHost;
}

export function isHost(member: Pick<RoomMember, 'role'>): boolean {
  return member.role === 'host';
}

/** Members currently in the room (as opposed to historical rows). */
export function isPresent(member: Pick<RoomMember, 'leftAt'>): boolean {
  return member.leftAt === null;
}
