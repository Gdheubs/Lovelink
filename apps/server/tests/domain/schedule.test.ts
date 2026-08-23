import { describe, expect, it } from 'vitest';
import {
  isValidSchedule,
  nextOccurrence,
  parseSchedule,
  SCHEDULE_HELP,
} from '../../src/domain/values/schedule.js';
import { ValidationError } from '../../src/domain/errors.js';

/**
 * RECURRING ROOM SCHEDULES.
 *
 * WHAT THIS HAS TO GET RIGHT, AND WHY IT IS NOT OBVIOUS
 * -----------------------------------------------------
 * "Every night at 10pm" is a statement about a WALL CLOCK, not about an
 * interval. A room that opens every 24 hours drifts an hour twice a year, and
 * the people who show up for it are exactly the people for whom 10pm and 11pm
 * are different things.
 *
 * So a schedule is expressed in a timezone, and computing the next occurrence
 * means finding the next INSTANT whose local wall clock matches — which is a
 * different and harder question than adding 86,400,000 milliseconds.
 *
 * The two nasty days are the ones where a wall-clock time is not a bijection:
 *
 *   - SPRING FORWARD: 02:30 does not exist. A room scheduled then must still
 *     open, once, at a defensible moment, rather than silently never firing
 *     again — a recurring room that stops recurring is a bug nobody reports
 *     because nobody notices the absence.
 *   - FALL BACK: 01:30 happens twice. It must open ONCE, not twice.
 *
 * WHY A RESTRICTED CRON SUBSET RATHER THAN THE WHOLE LANGUAGE
 * -----------------------------------------------------------
 * Cron's syntax is familiar, and hosts writing `0 22 * * *` will be understood
 * by anyone who has run a server. But the full language includes forms nobody
 * will use here and several that are genuinely ambiguous (the OR between
 * day-of-month and day-of-week being the famous one). The subset below covers
 * every schedule a room realistically has, and anything outside it is REJECTED
 * AT CREATION — loudly, with a message — rather than accepted and quietly never
 * fired.
 */

const at = (iso: string) => new Date(iso);
const LONDON = 'Europe/London';
const NZ = 'Pacific/Auckland';
const UTC = 'UTC';

describe('schedule', () => {
  // =========================================================================
  describe('parseSchedule', () => {
    it('accepts a nightly schedule', () => {
      expect(parseSchedule('0 22 * * *')).toMatchObject({ minutes: [0], hours: [22] });
    });

    it('accepts a list of days', () => {
      expect(parseSchedule('30 20 * * 1,3,5').weekdays).toEqual([1, 3, 5]);
    });

    it('accepts a range of days', () => {
      expect(parseSchedule('0 9 * * 1-5').weekdays).toEqual([1, 2, 3, 4, 5]);
    });

    it('accepts a step', () => {
      expect(parseSchedule('0 */6 * * *').hours).toEqual([0, 6, 12, 18]);
    });

    it('treats 7 and 0 as the same Sunday', () => {
      expect(parseSchedule('0 22 * * 7').weekdays).toEqual([0]);
    });

    it('rejects nonsense rather than accepting a schedule that never fires', () => {
      // The failure mode being prevented: a room that is "scheduled" forever
      // and simply never opens, which nobody reports because there is nothing
      // to see.
      for (const bad of ['', 'every night', '0 22 * *', '0 22 * * * *', '99 22 * * *', '0 25 * * *']) {
        expect(() => parseSchedule(bad)).toThrow(ValidationError);
      }
    });

    it('rejects a step of zero', () => {
      expect(() => parseSchedule('0 */0 * * *')).toThrow(ValidationError);
    });

    it('rejects a backwards range', () => {
      expect(() => parseSchedule('0 9 * * 5-1')).toThrow(ValidationError);
    });

    it('has help text naming what IS supported', () => {
      // If a host is going to be refused, they need to be told what would work.
      expect(SCHEDULE_HELP.length).toBeGreaterThan(20);
    });

    it('isValidSchedule never throws', () => {
      expect(isValidSchedule('0 22 * * *')).toBe(true);
      expect(isValidSchedule('nonsense')).toBe(false);
    });
  });

  // =========================================================================
  describe('nextOccurrence', () => {
    it('finds tonight when it has not happened yet', () => {
      const next = nextOccurrence('0 22 * * *', UTC, at('2026-03-14T09:00:00.000Z'));
      expect(next?.toISOString()).toBe('2026-03-14T22:00:00.000Z');
    });

    it('finds tomorrow when tonight has passed', () => {
      const next = nextOccurrence('0 22 * * *', UTC, at('2026-03-14T23:00:00.000Z'));
      expect(next?.toISOString()).toBe('2026-03-15T22:00:00.000Z');
    });

    it('is strictly after the given instant, so it cannot return the same slot twice', () => {
      // If this were inclusive, a scheduler that re-read its own last
      // occurrence would open the same room forever in a tight loop.
      const next = nextOccurrence('0 22 * * *', UTC, at('2026-03-14T22:00:00.000Z'));
      expect(next?.toISOString()).toBe('2026-03-15T22:00:00.000Z');
    });

    it('honours the day of the week', () => {
      // 2026-03-14 is a Saturday; the next Monday is the 16th.
      const next = nextOccurrence('0 9 * * 1', UTC, at('2026-03-14T09:00:00.000Z'));
      expect(next?.toISOString()).toBe('2026-03-16T09:00:00.000Z');
    });

    it('honours the day of the month', () => {
      const next = nextOccurrence('0 12 1 * *', UTC, at('2026-03-14T09:00:00.000Z'));
      expect(next?.toISOString()).toBe('2026-04-01T12:00:00.000Z');
    });

    // -- the whole point: wall clock, not intervals -------------------------

    it('KEEPS THE LOCAL WALL-CLOCK TIME, NOT A FIXED UTC OFFSET', () => {
      // 22:00 in London is 22:00 UTC in winter and 21:00 UTC in summer. A
      // schedule stored as a UTC instant would drift an hour twice a year.
      const winter = nextOccurrence('0 22 * * *', LONDON, at('2026-01-14T09:00:00.000Z'));
      expect(winter?.toISOString()).toBe('2026-01-14T22:00:00.000Z');

      const summer = nextOccurrence('0 22 * * *', LONDON, at('2026-07-14T09:00:00.000Z'));
      expect(summer?.toISOString()).toBe('2026-07-14T21:00:00.000Z');
    });

    it('works in a zone far from UTC', () => {
      // 22:00 NZDT on 2026-03-14 is 09:00 UTC the same day.
      const next = nextOccurrence('0 22 * * *', NZ, at('2026-03-14T00:00:00.000Z'));
      expect(next?.toISOString()).toBe('2026-03-14T09:00:00.000Z');
    });

    it('STILL FIRES ON THE DAY THE CLOCK GOES FORWARD', () => {
      // UK clocks jump 01:00 -> 02:00 on 2026-03-29, so 01:30 never happens.
      // The room must still open — a recurring room that silently stops
      // recurring is the worst outcome here.
      const next = nextOccurrence('30 1 * * *', LONDON, at('2026-03-29T00:00:00.000Z'));
      expect(next).not.toBeNull();
      // Immediately after the gap, not skipped to the following day.
      expect(next!.toISOString().slice(0, 10)).toBe('2026-03-29');
    });

    it('FIRES ONCE, NOT TWICE, ON THE DAY THE CLOCK GOES BACK', () => {
      // UK clocks fall 02:00 -> 01:00 on 2026-10-25, so 01:30 happens twice.
      const first = nextOccurrence('30 1 * * *', LONDON, at('2026-10-25T00:00:00.000Z'));
      expect(first).not.toBeNull();

      // Asking again from just after the first must move to the NEXT DAY, not
      // to the second 01:30 an hour later.
      const second = nextOccurrence('30 1 * * *', LONDON, first!);
      expect(second!.toISOString().slice(0, 10)).toBe('2026-10-26');
    });

    it('crosses a month boundary', () => {
      const next = nextOccurrence('0 22 * * *', UTC, at('2026-01-31T23:00:00.000Z'));
      expect(next?.toISOString()).toBe('2026-02-01T22:00:00.000Z');
    });

    it('crosses a year boundary', () => {
      const next = nextOccurrence('0 22 * * *', UTC, at('2025-12-31T23:00:00.000Z'));
      expect(next?.toISOString()).toBe('2026-01-01T22:00:00.000Z');
    });

    it('finds 29 February in a leap year', () => {
      const next = nextOccurrence('0 12 29 2 *', UTC, at('2027-06-01T00:00:00.000Z'));
      expect(next?.toISOString()).toBe('2028-02-29T12:00:00.000Z');
    });

    it('GIVES UP RATHER THAN LOOPING FOREVER ON AN IMPOSSIBLE DATE', () => {
      // 30 February. A naive search runs to the heat death of the universe;
      // this must return null so the caller can disable the schedule and say
      // so, rather than pinning a core.
      expect(nextOccurrence('0 12 30 2 *', UTC, at('2026-01-01T00:00:00.000Z'))).toBeNull();
    });

    it('returns null for an unparseable expression rather than throwing', () => {
      // The scheduler runs over many rooms; one bad row must not abort the
      // whole sweep.
      expect(nextOccurrence('nonsense', UTC, at('2026-01-01T00:00:00.000Z'))).toBeNull();
    });

    it('falls back to UTC for an unknown timezone rather than failing', () => {
      const next = nextOccurrence('0 22 * * *', 'Mars/Olympus_Mons', at('2026-03-14T09:00:00.000Z'));
      expect(next?.toISOString()).toBe('2026-03-14T22:00:00.000Z');
    });

    it('is stable: computing it twice gives the same answer', () => {
      // The scheduler persists this value and re-reads it after a restart. If
      // it were not deterministic, a restart would move the schedule.
      const a = nextOccurrence('0 22 * * 1,4', LONDON, at('2026-03-14T09:00:00.000Z'));
      const b = nextOccurrence('0 22 * * 1,4', LONDON, at('2026-03-14T09:00:00.000Z'));
      expect(a?.toISOString()).toBe(b?.toISOString());
    });
  });
});
