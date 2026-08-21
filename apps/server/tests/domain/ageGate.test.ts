import { describe, expect, it } from 'vitest';
import {
  ageInYears,
  assertAdult,
  isAdult,
  MINIMUM_AGE_YEARS,
  parseDobUtc,
} from '../../src/domain/rules/ageGate.js';
import { DomainError } from '../../src/domain/errors.js';

/**
 * The 18+ gate is the condition that makes the rest of the safety model
 * coherent, so these tests are mostly about the boring calendar cases a naive
 * implementation gets wrong — birthdays, leap days, and timezone drift.
 */
describe('ageGate', () => {
  const utc = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

  describe('ageInYears', () => {
    it('counts whole years', () => {
      expect(ageInYears(utc('2000-01-01'), utc('2025-01-01'))).toBe(25);
    });

    it('does not count a birthday that has not arrived this year', () => {
      // One day before the 25th birthday.
      expect(ageInYears(utc('2000-06-15'), utc('2025-06-14'))).toBe(24);
    });

    it('counts the birthday itself — you are 18 ON your eighteenth birthday', () => {
      expect(ageInYears(utc('2007-06-15'), utc('2025-06-15'))).toBe(18);
    });

    it('handles a leap-day birth date', () => {
      // Born 29 Feb 2004. On 28 Feb 2022 they are 17; on 1 Mar 2022 they are 18.
      expect(ageInYears(utc('2004-02-29'), utc('2022-02-28'))).toBe(17);
      expect(ageInYears(utc('2004-02-29'), utc('2022-03-01'))).toBe(18);
    });
  });

  describe('the 18 boundary', () => {
    it('rejects the day before the eighteenth birthday', () => {
      expect(isAdult(utc('2007-06-15'), utc('2025-06-14'))).toBe(false);
      expect(() => assertAdult(utc('2007-06-15'), utc('2025-06-14'))).toThrow(DomainError);
    });

    it('accepts the eighteenth birthday itself', () => {
      expect(isAdult(utc('2007-06-15'), utc('2025-06-15'))).toBe(true);
      expect(() => assertAdult(utc('2007-06-15'), utc('2025-06-15'))).not.toThrow();
    });

    it('throws UNDERAGE, not a generic validation error', () => {
      // The distinct code matters: the edge renders a specific, non-negotiable
      // message, and it is countable in logs.
      try {
        assertAdult(utc('2015-01-01'), utc('2025-01-01'));
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(DomainError);
        expect((error as DomainError).code).toBe('UNDERAGE');
      }
    });

    it(`uses ${MINIMUM_AGE_YEARS} as the threshold`, () => {
      expect(MINIMUM_AGE_YEARS).toBe(18);
    });
  });

  describe('rejects nonsense input', () => {
    it('refuses a future date of birth', () => {
      expect(() => assertAdult(utc('2030-01-01'), utc('2025-01-01'))).toThrow(/future/i);
    });

    it('refuses an implausible age', () => {
      expect(() => assertAdult(utc('1800-01-01'), utc('2025-01-01'))).toThrow(/valid date/i);
    });

    it('refuses an invalid Date object', () => {
      expect(() => assertAdult(new Date('nonsense'), utc('2025-01-01'))).toThrow(/valid date/i);
    });
  });

  describe('parseDobUtc', () => {
    it('parses to midnight UTC regardless of server timezone', () => {
      const parsed = parseDobUtc('1995-03-07');
      expect(parsed.toISOString()).toBe('1995-03-07T00:00:00.000Z');
      // The whole point: the UTC components are exactly what was typed, with no
      // local-timezone shift that would move a birthday by a day.
      expect(parsed.getUTCFullYear()).toBe(1995);
      expect(parsed.getUTCMonth()).toBe(2);
      expect(parsed.getUTCDate()).toBe(7);
    });

    it('rejects a malformed string', () => {
      expect(() => parseDobUtc('7 March 1995')).toThrow(/YYYY-MM-DD/);
      expect(() => parseDobUtc('1995-3-7')).toThrow(/YYYY-MM-DD/);
    });

    it('rejects a date that does not exist rather than rolling it forward', () => {
      // Date.UTC would happily turn this into 2 March.
      expect(() => parseDobUtc('2001-02-30')).toThrow(/valid date/i);
      expect(() => parseDobUtc('2001-13-01')).toThrow(/valid date/i);
    });

    it('accepts a real leap day', () => {
      expect(parseDobUtc('2004-02-29').toISOString()).toBe('2004-02-29T00:00:00.000Z');
    });
  });
});
