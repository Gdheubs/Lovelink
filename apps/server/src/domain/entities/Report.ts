import type { ReportId, RoomId, UserId } from '../values/ids.js';
import { hasUnsafeCharacters, MULTI_LINE, normalizeBody } from '../values/text.js';
import { ValidationError } from '../errors.js';

/**
 * A user-submitted safety report.
 *
 * WHY THIS SHAPE
 * --------------
 * Reports are the backbone of the safety baseline, so this entity is designed
 * around the REVIEW workflow rather than around the submit form: a report is
 * useless if a moderator cannot tell, weeks later, what happened and what was
 * decided. Hence `status` as an explicit queue state, and `resolution` /
 * `reviewedBy` / `reviewedAt` recorded on the same row.
 *
 * `audioRef` is a pointer to a short rolling buffer of room audio captured at
 * report time. It is NULLABLE and optional by design: recording everything all
 * the time is both a privacy hazard and a storage bill, so we only retain a
 * clip when someone asks us to look at something.
 *
 * INVARIANT: a report is never deleted. Dismissing one sets status
 * `dismissed`; the row remains, because patterns across dismissed reports are
 * themselves a signal.
 */
export type ReportCategory =
  'harassment' | 'hate_speech' | 'sexual_content' | 'minor_safety' | 'spam' | 'self_harm' | 'other';

export type ReportStatus = 'open' | 'reviewing' | 'upheld' | 'dismissed';

export const REPORT_CATEGORIES: readonly ReportCategory[] = Object.freeze([
  'harassment',
  'hate_speech',
  'sexual_content',
  'minor_safety',
  'spam',
  'self_harm',
  'other',
] as const);

export function isReportCategory(v: string): v is ReportCategory {
  return (REPORT_CATEGORIES as readonly string[]).includes(v);
}

/**
 * Categories that must jump the queue regardless of how old other reports are.
 * Encoded here rather than in the admin UI so that any future triage surface
 * inherits the same priority rules.
 */
const URGENT_CATEGORIES: readonly ReportCategory[] = Object.freeze([
  'minor_safety',
  'self_harm',
] as const);

export function isUrgent(category: ReportCategory): boolean {
  return URGENT_CATEGORIES.includes(category);
}

export interface Report {
  readonly id: ReportId;
  readonly reporterId: UserId;
  readonly targetId: UserId;
  /** Where it happened, when it happened in a room. Null for DM/profile reports. */
  readonly roomId: RoomId | null;
  readonly category: ReportCategory;
  readonly note: string;
  /** Opaque handle to a retained audio clip, resolved by a storage adapter. */
  readonly audioRef: string | null;
  readonly status: ReportStatus;
  readonly reviewedBy: UserId | null;
  readonly reviewedAt: Date | null;
  /** Free-text moderator note explaining the decision. */
  readonly resolution: string | null;
  readonly createdAt: Date;
}

export const REPORT_NOTE_MAX = 2000;

export function normalizeReportNote(note: string): string {
  const body = normalizeBody(note);
  if (body.length > REPORT_NOTE_MAX) {
    throw new ValidationError(`Report note must be ${REPORT_NOTE_MAX} characters or fewer.`);
  }
  if (hasUnsafeCharacters(body, MULTI_LINE)) {
    throw new ValidationError('Report note contains characters that are not allowed.');
  }
  return body;
}

export function isResolved(r: Pick<Report, 'status'>): boolean {
  return r.status === 'upheld' || r.status === 'dismissed';
}

/**
 * Queue ordering: urgent categories first, then oldest first.
 * Pure and total so the admin page and any future auto-triage agree.
 */
export function compareForQueue(a: Report, b: Report): number {
  const aUrgent = isUrgent(a.category) ? 0 : 1;
  const bUrgent = isUrgent(b.category) ? 0 : 1;
  if (aUrgent !== bUrgent) return aUrgent - bUrgent;
  return a.createdAt.getTime() - b.createdAt.getTime();
}
