import type { RoomId, UserId } from '../values/ids.js';
import { hasUnsafeCharacters, normalizeWhitespace, SINGLE_LINE } from '../values/text.js';
import { ValidationError } from '../errors.js';

/**
 * A themed drop-in voice room.
 *
 * WHY THIS SHAPE
 * --------------
 * `maxSpeakers` exists because the product's core promise is "listening is the
 * default" — an unbounded stage turns a third place back into a conference call.
 * The cap is enforced by the ApproveSpeaker use case, not by the media server,
 * so the rule stays testable without LiveKit running.
 *
 * `status` is the room's lifecycle, which is deliberately NOT the same question
 * as "is anyone in it right now". A scheduled room exists and is listable while
 * empty; live membership is the PresenceStore's business, not this entity's.
 */
export type RoomCategory = 'study' | 'late_night' | 'music' | 'support' | 'casual';
export type RoomStatus = 'scheduled' | 'live' | 'closed';

export interface Room {
  readonly id: RoomId;
  /** URL-safe unique handle, e.g. late-night-talk. */
  readonly slug: string;
  readonly title: string;
  readonly category: RoomCategory;
  readonly hostUserId: UserId;
  readonly isScheduled: boolean;
  /** Cron expression for recurring rooms; null for ad-hoc ones. */
  readonly scheduleCron: string | null;
  readonly maxSpeakers: number;
  readonly status: RoomStatus;
  readonly createdAt: Date;
}

export const ROOM_TITLE_MIN = 3;
export const ROOM_TITLE_MAX = 60;
export const MAX_SPEAKERS_CEILING = 8;
export const DEFAULT_MAX_SPEAKERS = 4;

export const ROOM_CATEGORIES: readonly RoomCategory[] = Object.freeze([
  'study',
  'late_night',
  'music',
  'support',
  'casual',
] as const);

export function isRoomCategory(value: string): value is RoomCategory {
  return (ROOM_CATEGORIES as readonly string[]).includes(value);
}

export function normalizeRoomTitle(title: string): string {
  const t = normalizeWhitespace(title);
  if (t.length < ROOM_TITLE_MIN || t.length > ROOM_TITLE_MAX) {
    throw new ValidationError(
      `Room title must be between ${ROOM_TITLE_MIN} and ${ROOM_TITLE_MAX} characters.`,
    );
  }
  if (hasUnsafeCharacters(t, SINGLE_LINE)) {
    throw new ValidationError('Room title contains characters that are not allowed.');
  }
  return t;
}

export function assertValidMaxSpeakers(n: number): void {
  if (!Number.isInteger(n) || n < 1 || n > MAX_SPEAKERS_CEILING) {
    throw new ValidationError(
      `Max speakers must be a whole number from 1 to ${MAX_SPEAKERS_CEILING}.`,
    );
  }
}

/**
 * Derive a slug from a title. Collisions are resolved by the CreateRoom use
 * case (which owns uniqueness), not here — this function is pure and total.
 */
export function slugify(title: string): string {
  const base = title
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  // A title of pure punctuation or non-Latin script can slugify to nothing.
  return base.length > 0 ? base : 'room';
}

export function isJoinable(room: Pick<Room, 'status'>): boolean {
  return room.status === 'live' || room.status === 'scheduled';
}
