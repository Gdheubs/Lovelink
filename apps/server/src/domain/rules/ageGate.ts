import { DomainError, ValidationError } from '../errors.js';

/**
 * The 18+ gate.
 *
 * WHY THIS EXISTS
 * ---------------
 * The platform puts strangers into voice contact with each other. Adults only
 * is not a policy preference here, it is the condition that makes the rest of
 * the safety model coherent — so the check must be (a) server-side, (b) in the
 * domain where it cannot be skipped by a new transport, and (c) tested against
 * the boring calendar edge cases that a naive implementation gets wrong.
 *
 * INVARIANTS THIS PROTECTS
 *  - No account is created without a date of birth that resolves to >= 18.
 *  - Age is computed from stored `dob` at the moment it is asked, never cached
 *    as an integer that silently becomes wrong the next morning.
 *  - A birthday is inclusive: you are 18 ON your eighteenth birthday.
 */

export const MINIMUM_AGE_YEARS = 18;
/** Rejects typos like year 1080 and anyone claiming to be 130. */
export const MAXIMUM_AGE_YEARS = 120;

/**
 * Whole years elapsed between `dob` and `now`, in UTC.
 *
 * Deliberately uses calendar arithmetic rather than dividing milliseconds by
 * 365.25 days: the millisecond approach is off by a day for anyone born near a
 * leap day, which is exactly the kind of bug that turns into a compliance
 * incident rather than a rounding complaint.
 */
export function ageInYears(dob: Date, now: Date): number {
  let age = now.getUTCFullYear() - dob.getUTCFullYear();

  const monthDelta = now.getUTCMonth() - dob.getUTCMonth();
  const dayDelta = now.getUTCDate() - dob.getUTCDate();

  // Birthday has not come round yet this year.
  if (monthDelta < 0 || (monthDelta === 0 && dayDelta < 0)) {
    age -= 1;
  }
  return age;
}

export function isAdult(dob: Date, now: Date): boolean {
  return ageInYears(dob, now) >= MINIMUM_AGE_YEARS;
}

/**
 * The single gate every registration path must pass through.
 * Throws `UNDERAGE` (a distinct code from generic validation) so that the edge
 * can render a specific, non-negotiable message and so it is countable in logs.
 */
export function assertAdult(dob: Date, now: Date): void {
  if (Number.isNaN(dob.getTime())) {
    throw new ValidationError('Please enter a valid date of birth.');
  }
  if (dob.getTime() > now.getTime()) {
    throw new ValidationError('Date of birth cannot be in the future.');
  }

  const age = ageInYears(dob, now);

  if (age > MAXIMUM_AGE_YEARS) {
    throw new ValidationError('Please enter a valid date of birth.');
  }
  if (age < MINIMUM_AGE_YEARS) {
    throw new DomainError(
      'UNDERAGE',
      `You must be ${MINIMUM_AGE_YEARS} or older to use Loverlink.`,
      { age },
    );
  }
}

/**
 * Parse a `YYYY-MM-DD` date of birth into midnight UTC.
 *
 * WHY NOT `new Date(str)`: that constructor applies the SERVER's timezone to
 * bare date strings in some runtimes, which shifts a birthday by a day and can
 * flip an 18th-birthday signup either way depending on where the box is
 * deployed. Explicit UTC construction removes the deployment dependency.
 */
export function parseDobUtc(input: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.trim());
  if (!match) {
    throw new ValidationError('Date of birth must be in YYYY-MM-DD format.');
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new ValidationError('Please enter a valid date of birth.');
  }

  const date = new Date(Date.UTC(year, month - 1, day));

  // Rejects 2001-02-30, which Date.UTC would happily roll forward to March 2nd.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new ValidationError('Please enter a valid date of birth.');
  }
  return date;
}
