import { describe, expect, it } from 'vitest';
import {
  asLocalDay,
  daysBetween,
  emptyStreak,
  localDayOf,
  recordShowUp,
  streakAsOf,
  type StreakState,
} from '../../src/domain/values/streaks.js';

/**
 * SHOW-UP STREAKS — stored in UTC, counted in the user's own day.
 *
 * WHY THIS FILE IS MOSTLY ABOUT TIME AND BARELY ABOUT COUNTING
 * ------------------------------------------------------------
 * Incrementing a number when someone turns up is trivial. Deciding WHETHER
 * they turned up "today" is not, and every bug this feature can have lives
 * there:
 *
 *   - a user in Auckland shows up at 9am and the server, thinking in UTC,
 *     records it as yesterday — so tomorrow morning their streak resets even
 *     though they have not missed a day in their life;
 *   - a user in Los Angeles shows up at 5pm and it counts as tomorrow, so two
 *     consecutive real days collapse into one;
 *   - the day a clock goes forward is 23 hours long, and anything computing
 *     "one day" as 86,400,000ms gets it wrong twice a year;
 *   - Kathmandu is UTC+05:45, which breaks any implementation that assumes
 *     whole-hour offsets.
 *
 * So the tests below are weighted towards time, and the streak arithmetic is
 * checked in terms of LOCAL DAYS rather than instants — because that is the
 * only unit in which "did you show up two days running" has an answer.
 *
 * THE FREEZE
 * ----------
 * One missed day is forgiven, once per streak. The rule exists because the
 * alternative — a streak that dies on the first bad night — punishes exactly
 * the people this product is for, and teaches them that the honest move is to
 * open the app and leave rather than to come back tomorrow.
 */

const NZ = 'Pacific/Auckland';
const LA = 'America/Los_Angeles';
const NEPAL = 'Asia/Kathmandu';
const UTC = 'UTC';

const at = (iso: string) => new Date(iso);

describe('streaks', () => {
  // =========================================================================
  describe('localDayOf — which day was that, for this person', () => {
    it('agrees with UTC for a user in UTC', () => {
      expect(localDayOf(at('2026-03-14T12:00:00.000Z'), UTC)).toBe('2026-03-14');
    });

    it('IS ALREADY TOMORROW IN AUCKLAND', () => {
      // 2026-03-14 21:00 UTC is 2026-03-15 10:00 NZDT. Counting this as the
      // 14th would reset the streak of someone who shows up every morning.
      expect(localDayOf(at('2026-03-14T21:00:00.000Z'), NZ)).toBe('2026-03-15');
    });

    it('IS STILL YESTERDAY IN LOS ANGELES', () => {
      // 2026-03-15 02:00 UTC is 2026-03-14 19:00 PDT — an evening, not a new
      // day. Counting it as the 15th would merge two evenings into one.
      expect(localDayOf(at('2026-03-15T02:00:00.000Z'), LA)).toBe('2026-03-14');
    });

    it('handles a 45-minute offset', () => {
      // Kathmandu is UTC+05:45. 18:20 UTC is 00:05 the next day there.
      expect(localDayOf(at('2026-03-14T18:20:00.000Z'), NEPAL)).toBe('2026-03-15');
      expect(localDayOf(at('2026-03-14T18:10:00.000Z'), NEPAL)).toBe('2026-03-14');
    });

    it('gets the day right across a spring-forward transition', () => {
      // US DST begins 2026-03-08. 09:30 UTC is 01:30 PST before the jump and
      // the clock then goes to 03:00. Both instants are still the 8th locally.
      expect(localDayOf(at('2026-03-08T09:30:00.000Z'), LA)).toBe('2026-03-08');
      expect(localDayOf(at('2026-03-08T11:30:00.000Z'), LA)).toBe('2026-03-08');
    });

    it('gets the day right across an autumn fall-back transition', () => {
      // US DST ends 2026-11-01. 08:30 UTC is 01:30 PDT; 09:30 UTC is 01:30
      // PST — the same wall-clock time, twice, on the same local day.
      expect(localDayOf(at('2026-11-01T08:30:00.000Z'), LA)).toBe('2026-11-01');
      expect(localDayOf(at('2026-11-01T09:30:00.000Z'), LA)).toBe('2026-11-01');
    });

    it('falls back to UTC for a timezone it does not recognise', () => {
      // A bad value must not throw and lose someone's streak. Being a day out
      // is recoverable; a 500 on every room join is not.
      expect(localDayOf(at('2026-03-14T12:00:00.000Z'), 'Mars/Olympus_Mons')).toBe('2026-03-14');
    });
  });

  // =========================================================================
  describe('daysBetween — in local days, never in milliseconds', () => {
    it('counts consecutive days', () => {
      expect(daysBetween(asLocalDay('2026-03-14'), asLocalDay('2026-03-15'))).toBe(1);
    });

    it('counts zero for the same day', () => {
      expect(daysBetween(asLocalDay('2026-03-14'), asLocalDay('2026-03-14'))).toBe(0);
    });

    it('crosses a month boundary', () => {
      expect(daysBetween(asLocalDay('2026-01-31'), asLocalDay('2026-02-01'))).toBe(1);
    });

    it('crosses a year boundary', () => {
      expect(daysBetween(asLocalDay('2025-12-31'), asLocalDay('2026-01-01'))).toBe(1);
    });

    it('handles a leap day', () => {
      expect(daysBetween(asLocalDay('2028-02-28'), asLocalDay('2028-02-29'))).toBe(1);
      expect(daysBetween(asLocalDay('2028-02-29'), asLocalDay('2028-03-01'))).toBe(1);
    });

    it('IS UNAFFECTED BY A DAYLIGHT-SAVING TRANSITION', () => {
      // The local day 2026-03-08 is 23 hours long in Los Angeles. Anything
      // dividing elapsed milliseconds by 86,400,000 returns 0 here and
      // silently swallows a day of the streak.
      expect(daysBetween(asLocalDay('2026-03-07'), asLocalDay('2026-03-08'))).toBe(1);
      expect(daysBetween(asLocalDay('2026-10-31'), asLocalDay('2026-11-01'))).toBe(1);
    });

    it('is negative when the days are the other way round', () => {
      expect(daysBetween(asLocalDay('2026-03-15'), asLocalDay('2026-03-14'))).toBe(-1);
    });
  });

  // =========================================================================
  describe('recordShowUp', () => {
    const showUp = (state: StreakState, iso: string, tz = UTC) =>
      recordShowUp(state, at(iso), tz);

    it('starts a streak at one', () => {
      const state = showUp(emptyStreak(), '2026-03-14T12:00:00.000Z');
      expect(state.current).toBe(1);
      expect(state.longest).toBe(1);
      expect(state.lastDay).toBe('2026-03-14');
    });

    it('SHOWING UP TWICE IN A DAY IS STILL ONE DAY', () => {
      let state = showUp(emptyStreak(), '2026-03-14T08:00:00.000Z');
      state = showUp(state, '2026-03-14T20:00:00.000Z');
      expect(state.current).toBe(1);
    });

    it('is idempotent, so it can be called on every room join', () => {
      const state = showUp(emptyStreak(), '2026-03-14T08:00:00.000Z');
      const after = showUp(state, '2026-03-14T08:00:00.000Z');
      expect(after).toEqual(state);
    });

    it('counts consecutive days', () => {
      let state = showUp(emptyStreak(), '2026-03-14T12:00:00.000Z');
      state = showUp(state, '2026-03-15T12:00:00.000Z');
      state = showUp(state, '2026-03-16T12:00:00.000Z');
      expect(state.current).toBe(3);
      expect(state.longest).toBe(3);
    });

    it('counts consecutive days IN THE USER’S TIMEZONE, not the server’s', () => {
      // Two consecutive Auckland mornings. In UTC these are the 14th at 20:00
      // and the 15th at 20:00 — but the point is that the LOCAL days (15th and
      // 16th) are what must be consecutive.
      let state = showUp(emptyStreak(), '2026-03-14T20:00:00.000Z', NZ);
      expect(state.lastDay).toBe('2026-03-15');

      state = showUp(state, '2026-03-15T20:00:00.000Z', NZ);
      expect(state.lastDay).toBe('2026-03-16');
      expect(state.current).toBe(2);
    });

    // -- the freeze ---------------------------------------------------------

    it('a fresh streak carries one freeze', () => {
      expect(emptyStreak().freezeAvailable).toBe(true);
    });

    it('ONE MISSED DAY IS FORGIVEN, AND SPENDS THE FREEZE', () => {
      let state = showUp(emptyStreak(), '2026-03-14T12:00:00.000Z');
      state = showUp(state, '2026-03-15T12:00:00.000Z');
      expect(state.current).toBe(2);

      // Nothing on the 16th.
      state = showUp(state, '2026-03-17T12:00:00.000Z');

      expect(state.current).toBe(3);
      expect(state.freezeAvailable).toBe(false);
    });

    it('a SECOND missed day breaks the streak', () => {
      let state = showUp(emptyStreak(), '2026-03-14T12:00:00.000Z');
      state = showUp(state, '2026-03-16T12:00:00.000Z'); // freeze spent
      expect(state.freezeAvailable).toBe(false);

      state = showUp(state, '2026-03-18T12:00:00.000Z'); // nothing left
      expect(state.current).toBe(1);
    });

    it('breaking the streak restores the freeze for the new one', () => {
      let state = showUp(emptyStreak(), '2026-03-14T12:00:00.000Z');
      state = showUp(state, '2026-03-16T12:00:00.000Z');
      state = showUp(state, '2026-03-18T12:00:00.000Z');

      expect(state.current).toBe(1);
      expect(state.freezeAvailable).toBe(true);
    });

    it('A FREEZE COVERS ONE DAY, NOT A WEEK', () => {
      let state = showUp(emptyStreak(), '2026-03-14T12:00:00.000Z');
      state = showUp(state, '2026-03-15T12:00:00.000Z');
      expect(state.current).toBe(2);

      // Five days away. A freeze is for the night you could not face it, not
      // for a fortnight in which you did not think about the product.
      state = showUp(state, '2026-03-21T12:00:00.000Z');

      expect(state.current).toBe(1);
      expect(state.freezeAvailable).toBe(true);
    });

    it('remembers the longest streak even after one breaks', () => {
      let state = emptyStreak();
      for (const day of ['14', '15', '16', '17']) {
        state = showUp(state, `2026-03-${day}T12:00:00.000Z`);
      }
      expect(state.current).toBe(4);

      state = showUp(state, '2026-04-01T12:00:00.000Z');
      expect(state.current).toBe(1);
      expect(state.longest).toBe(4);
    });

    it('survives a year boundary', () => {
      let state = showUp(emptyStreak(), '2025-12-31T12:00:00.000Z');
      state = showUp(state, '2026-01-01T12:00:00.000Z');
      expect(state.current).toBe(2);
    });

    it('IGNORES A SHOW-UP DATED BEFORE THE LAST ONE', () => {
      // Clock skew, a replayed request, or a backfill. Whatever the cause, it
      // must not reset a legitimate streak.
      let state = showUp(emptyStreak(), '2026-03-15T12:00:00.000Z');
      state = showUp(state, '2026-03-16T12:00:00.000Z');
      const before = state;

      state = showUp(state, '2026-03-10T12:00:00.000Z');
      expect(state).toEqual(before);
    });
  });

  // =========================================================================
  describe('streakAsOf — what to SHOW, which is not always what is stored', () => {
    const built = (): StreakState => {
      let state = recordShowUp(emptyStreak(), at('2026-03-14T12:00:00.000Z'), UTC);
      state = recordShowUp(state, at('2026-03-15T12:00:00.000Z'), UTC);
      return state; // current 2, lastDay 2026-03-15, freeze available
    };

    it('shows the streak on the day it was last extended', () => {
      const view = streakAsOf(built(), at('2026-03-15T23:00:00.000Z'), UTC);
      expect(view.current).toBe(2);
      expect(view.showedUpToday).toBe(true);
      expect(view.atRisk).toBe(false);
    });

    it('still shows it the next day — they have until midnight', () => {
      const view = streakAsOf(built(), at('2026-03-16T09:00:00.000Z'), UTC);
      expect(view.current).toBe(2);
      expect(view.showedUpToday).toBe(false);
      expect(view.atRisk).toBe(false);
    });

    it('MARKS IT AT RISK ON THE DAY THE FREEZE IS HOLDING IT UP', () => {
      // They missed the 16th. The streak survives, but only because of the
      // freeze — and they should be told that before they lose it, not after.
      const view = streakAsOf(built(), at('2026-03-17T09:00:00.000Z'), UTC);
      expect(view.current).toBe(2);
      expect(view.atRisk).toBe(true);
      expect(view.freezeAvailable).toBe(true);
    });

    it('reports zero once the streak is genuinely gone', () => {
      const view = streakAsOf(built(), at('2026-03-20T09:00:00.000Z'), UTC);
      expect(view.current).toBe(0);
      expect(view.longest).toBe(2);
    });

    it('DOES NOT MUTATE THE STORED STATE', () => {
      // The read is a projection. Persisting a break on read would mean a user
      // who never opens the app has a different history from one who does.
      const state = built();
      const copy = { ...state };
      streakAsOf(state, at('2026-04-01T09:00:00.000Z'), UTC);
      expect(state).toEqual(copy);
    });

    it('reports nothing for someone who has never shown up', () => {
      const view = streakAsOf(emptyStreak(), at('2026-03-14T12:00:00.000Z'), UTC);
      expect(view.current).toBe(0);
      expect(view.longest).toBe(0);
      expect(view.showedUpToday).toBe(false);
    });

    it('reads the day boundary in the user’s timezone', () => {
      let state = recordShowUp(emptyStreak(), at('2026-03-14T20:00:00.000Z'), NZ);
      state = recordShowUp(state, at('2026-03-15T20:00:00.000Z'), NZ);

      // 2026-03-16T09:00Z is the 16th at 22:00 in Auckland — the same local
      // day their last show-up landed on.
      const view = streakAsOf(state, at('2026-03-16T09:00:00.000Z'), NZ);
      expect(view.showedUpToday).toBe(true);
      expect(view.current).toBe(2);
    });
  });
});
