import type { IdentifierKind } from '../entities/User.js';

/**
 * PORT: NotificationSender
 *
 * WHY THIS EXISTS
 * ---------------
 * Delivering a login code is the one place the product touches a paid,
 * rate-limited, jurisdiction-specific third party (an SMS gateway or an email
 * provider). Those swap often — for cost, for deliverability, for a country
 * that blocks the current one — and none of that should reach the auth use
 * case, which only ever wants "get this code to this person".
 *
 * The dev/memory implementation writes to the log instead of sending, which is
 * what makes `npm run dev:memory` able to complete a full signup with no
 * accounts anywhere.
 *
 * INVARIANT: implementations must never throw for an unroutable address — an
 * invalid phone number is an ordinary user error, and a thrown exception here
 * turns it into a 500. Return a failure result instead.
 */

export interface DeliveryResult {
  readonly delivered: boolean;
  /** Provider-side id for support tickets. Null when not delivered. */
  readonly providerRef: string | null;
  /** Safe-to-log reason on failure. */
  readonly failureReason: string | null;
}

export interface NotificationSender {
  /**
   * Send a one-time login code.
   * @param code the plaintext code. Implementations MUST NOT log it.
   */
  sendLoginCode(identifier: string, kind: IdentifierKind, code: string): Promise<DeliveryResult>;

  /**
   * Tell someone a surprise is waiting for them.
   * Best-effort: a failure here must not fail the surprise's creation.
   */
  sendSurpriseNotice(
    identifier: string,
    kind: IdentifierKind,
    fromDisplayName: string,
  ): Promise<DeliveryResult>;
}
