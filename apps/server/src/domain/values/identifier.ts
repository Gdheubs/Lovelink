import type { IdentifierKind } from '../entities/User.js';
import { ValidationError } from '../errors.js';

/**
 * Contact-identifier normalization.
 *
 * WHY THIS EXISTS
 * ---------------
 * `users.identifier` has a UNIQUE index, which only means anything if every
 * path that writes it agrees on what "the same identifier" is. Without a single
 * canonical form:
 *
 *   - `Alice@Example.com` and `alice@example.com` become two accounts, and the
 *     second one silently cannot receive the first one's surprises;
 *   - `07700 900000`, `+44 7700 900000` and `+447700900000` become three;
 *   - an attacker registers a case-variant of someone else's address and
 *     receives login codes intended for them.
 *
 * So normalization is a DOMAIN rule, applied before any lookup and before any
 * insert — never at the HTTP edge, where a second edge would forget it.
 *
 * SCOPE, DELIBERATELY LIMITED
 * ---------------------------
 * This does not validate that an address is deliverable or that a number is
 * reachable — only that it has a plausible shape and one canonical spelling.
 * Deliverability is answered by whether the code arrives, which is the only
 * honest test.
 */

export interface NormalizedIdentifier {
  readonly value: string;
  readonly kind: IdentifierKind;
}

/**
 * Deliberately permissive: one @, something either side, a dot in the domain,
 * no whitespace. Stricter email regexes reject valid addresses (plus-addressing,
 * long TLDs, unusual local parts) and the cost of a false rejection at signup is
 * a user who cannot join at all.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/** E.164: a leading +, a non-zero country digit, then 7 to 14 more digits. */
const E164_SHAPE = /^\+[1-9]\d{7,14}$/;

export const EMAIL_MAX_LENGTH = 254;

/**
 * Decide what the user typed and reduce it to canonical form.
 *
 * The kind is inferred rather than asked for: a signup form that makes someone
 * pick "phone or email" before typing is a form that gets it wrong, and the
 * presence of an `@` is unambiguous.
 */
export function normalizeIdentifier(raw: string): NormalizedIdentifier {
  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    throw new ValidationError('Enter a phone number or email address.');
  }

  return trimmed.includes('@')
    ? { value: normalizeEmail(trimmed), kind: 'email' }
    : { value: normalizePhone(trimmed), kind: 'phone' };
}

function normalizeEmail(raw: string): string {
  // Lowercased in full. The local part is technically case-sensitive per RFC
  // 5321, but no mail provider anyone uses actually treats it that way, and
  // honouring the RFC here would mean Alice@ and alice@ are two accounts — a
  // real account-confusion hazard traded for a theoretical correctness point.
  const value = raw.toLowerCase();

  if (value.length > EMAIL_MAX_LENGTH) {
    throw new ValidationError('That email address is too long.');
  }
  if (!EMAIL_SHAPE.test(value)) {
    throw new ValidationError('That does not look like a valid email address.');
  }
  return value;
}

/**
 * Normalize to E.164.
 *
 * Accepts common human spellings — spaces, dashes, brackets, dots — and the
 * `00` international prefix. It does NOT guess a country for a bare national
 * number: assuming a country code is how a UK `07700 900000` silently becomes
 * a US number and the login code goes to a stranger. We ask for the `+`.
 */
function normalizePhone(raw: string): string {
  const stripped = raw.replace(/[\s\-().]/g, '');

  const value = stripped.startsWith('00') ? `+${stripped.slice(2)}` : stripped;

  if (!value.startsWith('+')) {
    throw new ValidationError(
      'Include your country code, starting with + (for example +447700900000).',
    );
  }
  if (!E164_SHAPE.test(value)) {
    throw new ValidationError('That does not look like a valid phone number.');
  }
  return value;
}

/**
 * A stable, non-reversible seed for a generated avatar.
 *
 * WHY NOT DERIVE IT FROM THE IDENTIFIER: an avatar is public, so anything
 * derived from a phone number or email is a public commitment to that value —
 * given a candidate address, anyone could confirm whether it belongs to a
 * visible account. The seed therefore comes from the IdGenerator, not from the
 * user's contact details.
 *
 * This function only constrains the shape so the frontend renderer can rely
 * on it.
 */
export function isValidAvatarSeed(seed: string): boolean {
  return /^[A-Za-z0-9_-]{8,64}$/.test(seed);
}
