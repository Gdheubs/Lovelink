/**
 * SHOW-UP STREAKS.
 *
 * WHAT A STREAK IS FOR, AND WHAT IT MUST NOT BECOME
 * -------------------------------------------------
 * This product is a third place for people who are often alone at 2am. A streak
 * is a gentle reason to come back, and it is one line away from being a
 * punishment machine — a number that makes someone feel worse for having had a
 * bad week is worse than no number at all.
 *
 * Three decisions follow from that, and all three cost something:
 *
 *   1. ONE MISSED DAY IS FORGIVEN. Without it a streak dies on the first bad
 *      night, and the lesson a user learns is to open the app and immediately
 *      close it rather than to come back tomorrow. That is a worse product and
 *      a worse metric.
 *   2. THE FREEZE IS NOT A CURRENCY. It is not earned, bought, hoarded or
 *      gifted. One per streak, restored when the streak breaks. Anything more
 *      elaborate turns a kindness into a mechanic to optimise.
 *   3. A BROKEN STREAK IS NOT WRITTEN ON READ. `streakAsOf` is a pure
 *      projection. Someone who does not open the app for a month has exactly
 *      the same stored history as someone who watches it die in real time.
 *
 * THE HARD PART IS NOT COUNTING, IT IS "TODAY"
 * --------------------------------------------
 * Instants are stored in UTC, because that is the only thing that is true
 * everywhere. But a streak is counted in DAYS, and a day belongs to a person,
 * not to a server: 09:00 in Auckland is the previous afternoon in UTC, and a
 * server counting UTC days would reset the streak of someone who has shown up
 * every single morning of their life.
 *
 * So every comparison here happens in LOCAL DAYS — `YYYY-MM-DD` as the user's
 * own calendar would write it — and never in elapsed milliseconds. The day a
 * clock goes forward is 23 hours long; anything dividing by 86,400,000 loses a
 * day twice a year, in opposite directions, for a subset of users.
 */

/** A calendar day as the user's own calendar writes it: `YYYY-MM-DD`. */
export type LocalDay = string & { readonly __brand: 'LocalDay' };

export interface StreakState {
  /** Consecutive days as last recorded. May be stale; see `streakAsOf`. */
  readonly current: number;
  readonly longest: number;
  /** The local day the last show-up was counted as. Null if never. */
  readonly lastDay: LocalDay | null;
  /** Whether this streak can still absorb one missed day. */
  readonly freezeAvailable: boolean;
}

/**
 * Assert that a string is a calendar day.
 *
 * The brand exists so that a `Date`, an ISO instant, or a user-supplied string
 * cannot be passed where a resolved local day belongs — the whole point of this
 * module is that those are different kinds of thing. This is the one place that
 * conversion is admitted, so every other call site has to have gone through
 * `localDayOf`.
 */
export function asLocalDay(value: string): LocalDay {
  return value.slice(0, 10) as LocalDay;
}

export function emptyStreak(): StreakState {
  return { current: 0, longest: 0, lastDay: null, freezeAvailable: true };
}

/**
 * Which local day an instant fell on, for someone in `timeZone`.
 *
 * Uses `Intl`, which is a JavaScript built-in and therefore allowed in the
 * domain — the rule this ring enforces is "no vendor packages", not "no
 * standard library". It is also the only correct way to do this: it carries the
 * full IANA database, including the fact that Kathmandu is UTC+05:45 and that
 * daylight-saving rules change by legislation.
 *
 * An unrecognised timezone falls back to UTC rather than throwing. A user with
 * a corrupt setting should be a day out at worst, not unable to join a room.
 */
export function localDayOf(instant: Date, timeZone: string): LocalDay {
  return format(instant, timeZone) ?? format(instant, 'UTC') ?? isoDayUtc(instant);
}

function format(instant: Date, timeZone: string): LocalDay | null {
  try {
    // `formatToParts` rather than a locale string: locale formats vary by
    // region and a `en-CA` shortcut would break the day someone's runtime
    // ships a different CLDR.
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(instant);

    const year = parts.find((part) => part.type === 'year')?.value;
    const month = parts.find((part) => part.type === 'month')?.value;
    const day = parts.find((part) => part.type === 'day')?.value;

    if (year === undefined || month === undefined || day === undefined) return null;
    return `${year}-${month}-${day}` as LocalDay;
  } catch {
    // RangeError for an unknown timeZone.
    return null;
  }
}

/** Last resort if even `Intl` with UTC fails, which should be impossible. */
function isoDayUtc(instant: Date): LocalDay {
  return instant.toISOString().slice(0, 10) as LocalDay;
}

/**
 * Whole days from `from` to `to`, counted on the calendar.
 *
 * Both arguments are already timezone-resolved, so this is deliberately naive
 * arithmetic on a calendar date — which is exactly right. Interpreting them as
 * instants and subtracting would reintroduce the daylight-saving bug that
 * resolving to local days was meant to remove.
 */
export function daysBetween(from: LocalDay, to: LocalDay): number {
  const a = Date.UTC(...partsOf(from));
  const b = Date.UTC(...partsOf(to));
  return Math.round((b - a) / 86_400_000);
}

function partsOf(day: LocalDay): [number, number, number] {
  const [year, month, date] = day.split('-').map(Number);
  return [year ?? 1970, (month ?? 1) - 1, date ?? 1];
}

/**
 * Record that the user turned up, and return the new state.
 *
 * PURE, and safe to call on every room join — showing up twice in one day is
 * still one day, so the caller does not have to know whether today already
 * counted.
 */
export function recordShowUp(
  state: StreakState,
  instant: Date,
  timeZone: string,
): StreakState {
  const today = localDayOf(instant, timeZone);

  if (state.lastDay === null) {
    return { current: 1, longest: Math.max(1, state.longest), lastDay: today, freezeAvailable: true };
  }

  const gap = daysBetween(state.lastDay, today);

  // Already counted today. Returning the same object keeps this genuinely
  // idempotent, which matters because callers persist the result.
  if (gap === 0) return state;

  // Dated before the last show-up: clock skew, a replayed request, a backfill.
  // Whatever the cause, the past must not reset a live streak.
  if (gap < 0) return state;

  if (gap === 1) {
    const current = state.current + 1;
    return {
      current,
      longest: Math.max(current, state.longest),
      lastDay: today,
      freezeAvailable: state.freezeAvailable,
    };
  }

  // Exactly one day missed, and a freeze to cover it. The streak continues and
  // the freeze is spent — a second miss will end it.
  if (gap === 2 && state.freezeAvailable) {
    const current = state.current + 1;
    return {
      current,
      longest: Math.max(current, state.longest),
      lastDay: today,
      freezeAvailable: false,
    };
  }

  // Broken. A new streak begins at one, and it gets its own freeze — the point
  // is to make coming back easy, and starting over already costs enough.
  return {
    current: 1,
    longest: Math.max(1, state.longest),
    lastDay: today,
    freezeAvailable: true,
  };
}

/** What to render. Never what to store. */
export interface StreakView {
  readonly current: number;
  readonly longest: number;
  /** True once today has been counted — the "you're safe" state. */
  readonly showedUpToday: boolean;
  /** True when only the freeze is holding the streak up. */
  readonly atRisk: boolean;
  readonly freezeAvailable: boolean;
}

/**
 * Project the stored state onto "now".
 *
 * WHY THIS IS SEPARATE FROM `recordShowUp`
 * ----------------------------------------
 * The stored state says what happened. It does not know that four days have
 * passed since, so `state.current` can be a number that is no longer true.
 * Showing it unchanged would tell someone they have a 12-day streak a week
 * after it ended.
 *
 * The fix is NOT to write the break when someone happens to look. That would
 * make a user's history depend on when they opened the app, and would mean two
 * people with identical behaviour have different records because one of them
 * checked. So the truth is stored and the presentation is computed.
 */
export function streakAsOf(state: StreakState, instant: Date, timeZone: string): StreakView {
  if (state.lastDay === null) {
    return { current: 0, longest: state.longest, showedUpToday: false, atRisk: false, freezeAvailable: true };
  }

  const gap = daysBetween(state.lastDay, localDayOf(instant, timeZone));

  // Today, or somehow in the future (clock skew) — either way, safe.
  if (gap <= 0) {
    return {
      current: state.current,
      longest: state.longest,
      showedUpToday: true,
      atRisk: false,
      freezeAvailable: state.freezeAvailable,
    };
  }

  // Yesterday. The streak stands and they have until midnight, so this is not
  // "at risk" — telling someone at 9am that they are about to lose something
  // is a nag, not a service.
  if (gap === 1) {
    return {
      current: state.current,
      longest: state.longest,
      showedUpToday: false,
      atRisk: false,
      freezeAvailable: state.freezeAvailable,
    };
  }

  // One day missed. The streak survives only if the freeze can cover it, and
  // the user is told so while they can still act on it.
  if (gap === 2 && state.freezeAvailable) {
    return {
      current: state.current,
      longest: state.longest,
      showedUpToday: false,
      atRisk: true,
      freezeAvailable: true,
    };
  }

  // Gone. `longest` is what remains, and it is the number worth keeping.
  return {
    current: 0,
    longest: state.longest,
    showedUpToday: false,
    atRisk: false,
    freezeAvailable: true,
  };
}
