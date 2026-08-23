import { ValidationError } from '../errors.js';

/**
 * RECURRING ROOM SCHEDULES — "every night at 10pm", expressed in cron.
 *
 * WHY A SCHEDULE IS A WALL CLOCK AND NOT AN INTERVAL
 * --------------------------------------------------
 * A room that opens every 86,400,000 milliseconds drifts an hour twice a year.
 * The people who turn up for a nightly room are precisely the people for whom
 * 10pm and 11pm are different things — someone with work in the morning, or a
 * carer with a window between other people's needs.
 *
 * So a schedule carries a TIMEZONE, and computing the next occurrence means
 * finding the next instant whose LOCAL wall clock matches the pattern. That is
 * a different question from adding a day, and the difference only shows up on
 * two days a year, in a way nobody reports because the room simply is not there.
 *
 * WHY A RESTRICTED SUBSET OF CRON
 * -------------------------------
 * The syntax is familiar and hosts who have run a server will read `0 22 * * *`
 * without being taught. But full cron includes forms nobody needs here and at
 * least one that is genuinely ambiguous — when both day-of-month and
 * day-of-week are restricted, real cron ORs them, which almost nobody expects.
 *
 * The subset below covers every schedule a room realistically has. Anything
 * outside it is REJECTED WHEN THE ROOM IS CREATED, with a message naming what
 * is supported — because the alternative is a room that is "scheduled" forever
 * and never opens, and an absence is not something a user thinks to report.
 *
 * NOT SUPPORTED, deliberately: `@daily` and friends, `L`/`W`/`#`, seconds, and
 * named months or days. Numbers only, so there is nothing to mis-parse.
 */

export interface Schedule {
  readonly minutes: readonly number[];
  readonly hours: readonly number[];
  /** Days of the month, 1-31. Empty array means "any". */
  readonly monthDays: readonly number[];
  /** Months, 1-12. Empty array means "any". */
  readonly months: readonly number[];
  /** Days of the week, 0-6 with 0 = Sunday. Empty array means "any". */
  readonly weekdays: readonly number[];
}

export const SCHEDULE_HELP =
  'Use five fields: minute hour day-of-month month day-of-week. ' +
  'Numbers, lists (1,3,5), ranges (1-5) and steps (*/6) are supported. ' +
  'For example "0 22 * * *" is every night at 22:00, and "30 20 * * 1-5" is ' +
  'weekdays at 20:30.';

/**
 * How far ahead to look before giving up.
 *
 * A pattern like "30 February" matches no date that will ever exist, and a
 * naive search for it runs forever — pinning a core inside a scheduler sweep
 * that was supposed to take a millisecond. Four years covers every legitimate
 * pattern including 29 February, and anything that has not matched by then is
 * not going to.
 */
const SEARCH_LIMIT_DAYS = 366 * 4;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export function parseSchedule(expression: string): Schedule {
  const fields = expression.trim().split(/\s+/).filter((part) => part.length > 0);

  if (fields.length !== 5) {
    throw new ValidationError(`A schedule needs exactly five fields. ${SCHEDULE_HELP}`);
  }

  const [minute, hour, monthDay, month, weekday] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];

  return {
    minutes: parseField(minute, 0, 59, 'minute'),
    hours: parseField(hour, 0, 23, 'hour'),
    // An unrestricted field yields an empty list rather than every value: it
    // makes "any" cheap to test for, and keeps the day-of-month / day-of-week
    // interaction below readable.
    monthDays: isWildcard(monthDay) ? [] : parseField(monthDay, 1, 31, 'day of month'),
    months: isWildcard(month) ? [] : parseField(month, 1, 12, 'month'),
    weekdays: isWildcard(weekday) ? [] : normalizeWeekdays(parseField(weekday, 0, 7, 'day of week')),
  };
}

/** Never throws. For rendering an affordance rather than enforcing anything. */
export function isValidSchedule(expression: string): boolean {
  try {
    parseSchedule(expression);
    return true;
  } catch {
    return false;
  }
}

function isWildcard(field: string): boolean {
  return field === '*';
}

/** Cron allows both 0 and 7 for Sunday. Collapse to 0 so matching is a set test. */
function normalizeWeekdays(values: readonly number[]): number[] {
  return [...new Set(values.map((value) => (value === 7 ? 0 : value)))].sort((a, b) => a - b);
}

function parseField(field: string, min: number, max: number, label: string): number[] {
  const values = new Set<number>();

  for (const part of field.split(',')) {
    if (part.length === 0) throw invalid(label);

    const [rangePart, stepPart] = part.split('/');
    if (rangePart === undefined) throw invalid(label);

    let step = 1;
    if (stepPart !== undefined) {
      step = Number(stepPart);
      // A step of zero is an infinite loop waiting to happen, and a negative
      // one is meaningless. Both are almost always a typo.
      if (!Number.isInteger(step) || step <= 0) throw invalid(label);
    }

    let from: number;
    let to: number;

    if (rangePart === '*') {
      from = min;
      to = max;
    } else if (rangePart.includes('-')) {
      const [start, end] = rangePart.split('-').map(Number);
      if (start === undefined || end === undefined) throw invalid(label);
      from = start;
      to = end;
      // A backwards range is far more likely to be a mistake than an intent to
      // wrap around midnight, and guessing which would be worse than refusing.
      if (from > to) throw invalid(label);
    } else {
      const single = Number(rangePart);
      if (!Number.isInteger(single)) throw invalid(label);
      from = single;
      to = single;
    }

    if (!Number.isInteger(from) || !Number.isInteger(to)) throw invalid(label);
    if (from < min || to > max) throw invalid(label);

    for (let value = from; value <= to; value += step) values.add(value);
  }

  if (values.size === 0) throw invalid(label);
  return [...values].sort((a, b) => a - b);
}

function invalid(label: string): ValidationError {
  return new ValidationError(`That ${label} is not something we can schedule. ${SCHEDULE_HELP}`);
}

// ---------------------------------------------------------------------------
// Finding the next occurrence
// ---------------------------------------------------------------------------

/**
 * The next instant strictly after `after` whose local wall clock matches.
 *
 * STRICTLY after, which matters more than it looks: the scheduler persists this
 * value, and re-reading it to compute the following one must move forward. An
 * inclusive comparison would make a room re-open its own last occurrence in a
 * tight loop, forever.
 *
 * Returns null rather than throwing for an unparseable expression or an
 * impossible date. The scheduler sweeps many rooms at once and one bad row must
 * not abort the others — the caller disables that schedule and says so.
 */
export function nextOccurrence(
  expression: string,
  timeZone: string,
  after: Date,
): Date | null {
  let schedule: Schedule;
  try {
    schedule = parseSchedule(expression);
  } catch {
    return null;
  }

  const zone = usableZone(timeZone);

  // Walk forward one LOCAL DAY at a time. Days rather than minutes because a
  // minute-by-minute scan of four years is 2.1 million iterations, and a
  // day-by-day one is 1,464 — each of which then only checks its own matching
  // hours and minutes.
  const cursor = localPartsOf(after, zone);

  for (let dayOffset = 0; dayOffset <= SEARCH_LIMIT_DAYS; dayOffset += 1) {
    const day = addDays({ year: cursor.year, month: cursor.month, day: cursor.day }, dayOffset);

    if (!dayMatches(schedule, day)) continue;

    for (const hour of schedule.hours) {
      for (const minute of schedule.minutes) {
        const instant = instantOf({ ...day, hour, minute }, zone);
        if (instant === null) continue;

        // Strictly after. Also guards the fall-back case: the first of two
        // identical wall clocks is already past, so the second is skipped.
        if (instant.getTime() > after.getTime()) return instant;
      }
    }
  }

  return null;
}

interface LocalDate {
  readonly year: number;
  readonly month: number; // 1-12
  readonly day: number; // 1-31
}

interface LocalDateTime extends LocalDate {
  readonly hour: number;
  readonly minute: number;
}

/**
 * Whether this calendar day is one the schedule fires on.
 *
 * NOTE the AND. Real cron ORs day-of-month with day-of-week when both are
 * restricted, which surprises almost everyone who has not read the manual —
 * `0 0 1 * 1` firing on the 1st *and* every Monday is not what anyone means.
 * Requiring both is the reading a person expects, and the two are almost never
 * restricted together in practice.
 */
function dayMatches(schedule: Schedule, date: LocalDate): boolean {
  if (schedule.months.length > 0 && !schedule.months.includes(date.month)) return false;
  if (schedule.monthDays.length > 0 && !schedule.monthDays.includes(date.day)) return false;

  // A day that does not exist (31 April, 30 February) never matches. This is
  // what makes the search terminate for an impossible pattern rather than
  // running to the limit and beyond.
  if (!isRealDate(date)) return false;

  if (schedule.weekdays.length > 0) {
    const weekday = weekdayOf(date);
    if (weekday === null || !schedule.weekdays.includes(weekday)) return false;
  }

  return true;
}

function isRealDate(date: LocalDate): boolean {
  const probe = new Date(Date.UTC(date.year, date.month - 1, date.day));
  return (
    probe.getUTCFullYear() === date.year &&
    probe.getUTCMonth() === date.month - 1 &&
    probe.getUTCDate() === date.day
  );
}

/**
 * The day of the week for a calendar date.
 *
 * Computed from a UTC probe rather than by asking Intl for the weekday in the
 * zone: the date has no time attached, and a zone-aware lookup would have to
 * invent one — landing on the wrong side of midnight for anywhere far enough
 * from UTC. The weekday of 2026-03-14 is the same everywhere; it is only
 * INSTANTS that disagree about which day they fall on.
 */
function weekdayOf(date: LocalDate): number | null {
  if (!isRealDate(date)) return null;
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

function addDays(date: LocalDate, days: number): LocalDate {
  const probe = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: probe.getUTCFullYear(),
    month: probe.getUTCMonth() + 1,
    day: probe.getUTCDate(),
  };
}

/**
 * The instant at which a given local wall clock occurs in a zone.
 *
 * THIS IS THE HARD PART, and it is hard because the mapping is not a bijection.
 *
 * The method: guess that the local time is UTC, ask the zone what the offset
 * actually is at that guess, and correct. One correction is enough except near
 * a transition, where the offset at the guess differs from the offset at the
 * answer — so it is applied twice and then VERIFIED.
 *
 * The verification is what makes the two awkward days safe:
 *
 *  - SPRING FORWARD, 02:30 never happens. No instant verifies, so this returns
 *    the corrected guess anyway — which lands at 03:30 local, immediately after
 *    the gap. The room opens an hour "late" once a year, which is far better
 *    than a recurring room that silently stops recurring.
 *  - FALL BACK, 01:30 happens twice. Both instants verify; this returns the
 *    earlier one, and `nextOccurrence`'s strictly-after comparison means the
 *    second is skipped rather than opening the room twice.
 */
function instantOf(local: LocalDateTime, zone: string): Date | null {
  const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);

  let guess = new Date(asUtc);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const offset = offsetAt(guess, zone);
    if (offset === null) return null;
    guess = new Date(asUtc - offset);
  }

  // No verification branch, and deliberately so: BOTH outcomes are the answer
  // we want, so distinguishing them would be a comment pretending to be code.
  //
  //  - When the wall clock exists, `guess` is it.
  //  - When it does not — the spring-forward gap — the correction lands on the
  //    first real instant after the gap, which is exactly where a 02:30 room
  //    should open on the one night 02:30 is not a time.
  return guess;
}

/** The zone's offset from UTC, in milliseconds, at a given instant. */
function offsetAt(instant: Date, zone: string): number | null {
  const parts = localPartsOf(instant, zone);
  if (parts.year === 0) return null;

  const asIfUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asIfUtc - instant.getTime();
}

interface LocalParts extends LocalDateTime {
  readonly second: number;
}

/**
 * Break an instant into the wall-clock fields a zone would show.
 *
 * `Intl` is a JavaScript built-in, so it is allowed here — the rule this ring
 * enforces is "no vendor packages", not "no standard library". It is also the
 * only thing that carries the IANA database, including the legislative changes
 * that make hard-coded offsets wrong within a few years.
 */
function localPartsOf(instant: Date, zone: string): LocalParts {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(instant);

    const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? '0');

    return {
      year: read('year'),
      month: read('month'),
      // `hour12: false` still renders midnight as 24 in some runtimes.
      day: read('day'),
      hour: read('hour') % 24,
      minute: read('minute'),
      second: read('second'),
    };
  } catch {
    return { year: 0, month: 1, day: 1, hour: 0, minute: 0, second: 0 };
  }
}

/**
 * A zone the runtime actually knows, falling back to UTC.
 *
 * A corrupt zone must not stop a room opening: being an hour out is
 * recoverable, a room that never opens is not.
 */
function usableZone(zone: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return 'UTC';
  }
}
