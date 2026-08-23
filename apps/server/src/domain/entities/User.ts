import type { UserId } from '../values/ids.js';
import type { TrustTier } from '../values/trust.js';
import { trustTier } from '../values/trust.js';
import type { StreakState } from '../values/streaks.js';
import { hasUnsafeCharacters, normalizeWhitespace, SINGLE_LINE } from '../values/text.js';
import { ValidationError } from '../errors.js';

/**
 * A person on the platform.
 *
 * WHY THIS SHAPE
 * --------------
 * `identifier` is deliberately one field, not `phone` + `email`. The product may
 * switch between phone OTP and email magic links (or run both), and every rule
 * downstream cares only that a user is uniquely identified — not how. The
 * concrete channel lives in `identifierKind` for the auth adapter's benefit.
 *
 * `dob` is stored, `age` is never stored: an age integer silently rots and turns
 * a 17-year-old into an 18-year-old only when someone remembers to recompute it.
 *
 * `trustScore` is a projection of the trust_events ledger (see values/trust.ts);
 * it is cached on the row for cheap reads and MUST be recomputed from the ledger
 * rather than incremented in place.
 */
export type UserStatus = 'active' | 'suspended' | 'banned' | 'deleted';
export type IdentifierKind = 'phone' | 'email';

export interface User {
  readonly id: UserId;
  /** E.164 phone or lowercased email. Unique across the platform. */
  readonly identifier: string;
  readonly identifierKind: IdentifierKind;
  readonly displayName: string;
  /** Deterministic seed for a generated avatar. No uploads at MVP = no image-abuse surface. */
  readonly avatarSeed: string;
  /** Date of birth, midnight UTC. Used for the 18+ gate; never exposed to other users. */
  readonly dob: Date;
  readonly trustScore: number;
  readonly status: UserStatus;
  readonly createdAt: Date;
  /**
   * IANA timezone name, used ONLY for streak day boundaries.
   *
   * Stored on the account rather than read from whatever request happens to be
   * in flight, so that a room join over a socket, a REST call and a background
   * job all agree about which day it is for this person. Defaults to UTC until
   * the client reports the browser's real zone.
   */
  readonly timeZone: string;
  /**
   * Show-up streak AS LAST RECORDED — deliberately not a live figure.
   *
   * `current` goes stale the moment a day passes without a show-up. Render
   * `streakAsOf(...)`, never this directly; see domain/values/streaks.ts for
   * why a broken streak is never written on read.
   */
  readonly streak: StreakState;
}

export const DISPLAY_NAME_MIN = 2;
export const DISPLAY_NAME_MAX = 24;

/**
 * Validates and normalizes the free-text part of a profile, returning the value
 * that should actually be stored.
 *
 * Kept in the domain so the signup route, the profile-edit route and the admin
 * tool cannot drift apart on what a legal name is.
 */
export function normalizeDisplayName(name: string): string {
  const trimmed = normalizeWhitespace(name);
  if (trimmed.length < DISPLAY_NAME_MIN || trimmed.length > DISPLAY_NAME_MAX) {
    throw new ValidationError(
      `Display name must be between ${DISPLAY_NAME_MIN} and ${DISPLAY_NAME_MAX} characters.`,
    );
  }
  if (hasUnsafeCharacters(trimmed, SINGLE_LINE)) {
    throw new ValidationError('Display name contains characters that are not allowed.');
  }
  return trimmed;
}

/** True when the account may take any action at all. */
export function isActive(user: Pick<User, 'status'>): boolean {
  return user.status === 'active';
}

export function tierOf(user: Pick<User, 'trustScore'>): TrustTier {
  return trustTier(user.trustScore);
}

/**
 * The subset of a user that is safe to send to OTHER users.
 *
 * INVARIANT: anything not listed here — dob, identifier, raw trust score,
 * account status — never leaves the server. Every serializer in the codebase
 * goes through this function; if you find yourself hand-building a user payload
 * at an edge, you are about to leak something.
 */
export interface PublicProfile {
  readonly id: UserId;
  readonly displayName: string;
  readonly avatarSeed: string;
  readonly tier: TrustTier;
}

export function toPublicProfile(user: User): PublicProfile {
  return {
    id: user.id,
    displayName: user.displayName,
    avatarSeed: user.avatarSeed,
    tier: trustTier(user.trustScore),
  };
}
