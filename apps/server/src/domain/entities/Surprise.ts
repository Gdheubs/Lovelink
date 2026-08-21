import type { SurpriseId, UserId } from '../values/ids.js';
import {
  hasUnsafeCharacters,
  MULTI_LINE,
  normalizeBody,
  normalizeWhitespace,
} from '../values/text.js';
import { ValidationError } from '../errors.js';

/**
 * An async "surprise" — the icebreaker ported from the original LoveLink page.
 *
 * WHY THIS SHAPE
 * --------------
 * A surprise is claimed by a CODE, not addressed to an account, because the
 * whole point is that you can hand it to someone you just met without either
 * party exposing contact details. `recipientId` is therefore nullable and is
 * filled in at redemption — the row records who actually opened it, which is
 * what the trust ladder and the abuse team care about.
 *
 * `mood` is chosen by the RECIPIENT at open time and selects which prepared
 * message they see. It is stored because it is the only signal we have about
 * how a surprise landed, and because re-opening must show the same message
 * rather than re-rolling it.
 *
 * INVARIANT: a surprise is redeemable exactly once. `openedAt` and
 * `recipientId` are set together, atomically, by RedeemSurprise.
 */
export type SurpriseTheme = 'love' | 'sorry' | 'miss' | 'thinking_of_you' | 'congrats';
export type SurpriseMood = 'angry' | 'sad' | 'meh' | 'happy' | 'soft' | 'tired';

export const SURPRISE_THEMES: readonly SurpriseTheme[] = Object.freeze([
  'love',
  'sorry',
  'miss',
  'thinking_of_you',
  'congrats',
] as const);

export const SURPRISE_MOODS: readonly SurpriseMood[] = Object.freeze([
  'angry',
  'sad',
  'meh',
  'happy',
  'soft',
  'tired',
] as const);

export function isSurpriseTheme(v: string): v is SurpriseTheme {
  return (SURPRISE_THEMES as readonly string[]).includes(v);
}

export function isSurpriseMood(v: string): v is SurpriseMood {
  return (SURPRISE_MOODS as readonly string[]).includes(v);
}

/** A single optional "sweet task" the sender leaves for the recipient. */
export interface SurpriseTask {
  readonly text: string;
  readonly done: boolean;
}

export interface Surprise {
  readonly id: SurpriseId;
  /** Human-shareable claim code, e.g. LOVE-2847. Unique, case-insensitive. */
  readonly code: string;
  readonly senderId: UserId;
  /** Null until redeemed. Set atomically with `openedAt`. */
  readonly recipientId: UserId | null;
  readonly theme: SurpriseTheme;
  readonly message: string;
  readonly tasks: readonly SurpriseTask[];
  /** Chosen by the recipient at open time; null until redeemed. */
  readonly moodSelected: SurpriseMood | null;
  readonly openedAt: Date | null;
  readonly createdAt: Date;
  /** Surprises expire so unclaimed codes cannot be brute-forced indefinitely. */
  readonly expiresAt: Date;
}

export const SURPRISE_MESSAGE_MAX = 1000;
export const SURPRISE_TASK_MAX_LENGTH = 120;
export const SURPRISE_MAX_TASKS = 5;
/** Codes are single-use invitations, not permanent links. */
export const SURPRISE_TTL_DAYS = 30;

export function normalizeSurpriseMessage(message: string): string {
  const body = normalizeBody(message);
  if (body.length === 0) {
    throw new ValidationError('A surprise needs a message.');
  }
  if (body.length > SURPRISE_MESSAGE_MAX) {
    throw new ValidationError(`Message must be ${SURPRISE_MESSAGE_MAX} characters or fewer.`);
  }
  if (hasUnsafeCharacters(body, MULTI_LINE)) {
    throw new ValidationError('Message contains characters that are not allowed.');
  }
  return body;
}

export function normalizeTasks(tasks: readonly string[]): readonly SurpriseTask[] {
  const cleaned = tasks.map(normalizeWhitespace).filter((t) => t.length > 0);
  if (cleaned.length > SURPRISE_MAX_TASKS) {
    throw new ValidationError(`A surprise can carry at most ${SURPRISE_MAX_TASKS} tasks.`);
  }
  for (const task of cleaned) {
    if (task.length > SURPRISE_TASK_MAX_LENGTH) {
      throw new ValidationError(
        `Each task must be ${SURPRISE_TASK_MAX_LENGTH} characters or fewer.`,
      );
    }
    if (hasUnsafeCharacters(task)) {
      throw new ValidationError('A task contains characters that are not allowed.');
    }
  }
  return cleaned.map((text) => ({ text, done: false }));
}

export function isRedeemed(s: Pick<Surprise, 'openedAt'>): boolean {
  return s.openedAt !== null;
}

export function isExpired(s: Pick<Surprise, 'expiresAt'>, now: Date): boolean {
  return s.expiresAt.getTime() <= now.getTime();
}

/**
 * Codes are normalized aggressively on the way in AND on lookup, so that
 * "love 2847", "love-2847" and "LOVE-2847" are the same code. Anything a user
 * might reasonably type while reading a code off a screen should work.
 */
export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Display form, e.g. LOVE-2847, reconstructed from the normalized code. */
export function formatCode(normalized: string): string {
  const word = normalized.slice(0, 4);
  const digits = normalized.slice(4);
  return digits.length > 0 ? `${word}-${digits}` : word;
}
