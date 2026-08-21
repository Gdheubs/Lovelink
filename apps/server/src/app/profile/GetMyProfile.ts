import type { User } from '../../domain/entities/User.js';
import type { TrustEvent } from '../../domain/entities/TrustEvent.js';
import type { Ports } from '../../domain/ports/index.js';
import type { TrustTier } from '../../domain/values/trust.js';
import { trustTier } from '../../domain/values/trust.js';

/**
 * USE CASE: the signed-in user's own profile.
 *
 * WHY IT IS NOT `toPublicProfile`
 * -------------------------------
 * `toPublicProfile` is what OTHER people may see. This is what YOU may see
 * about yourself, and it is deliberately a different shape: it includes your
 * identifier (masked), your account status, and — importantly — the trust
 * events behind your standing.
 *
 * That last part is the whole reason the ledger is append-only. When a user
 * asks "why can't I send a message?", the honest answer is a dated list, not a
 * number. Exposing it here is what makes the trust system feel like a rule
 * rather than a mood.
 *
 * STILL WITHHELD, even from the account owner: nothing. But note that the
 * identifier is MASKED rather than returned in full — a shoulder-surfer or a
 * screenshot in a support thread should not carry a full phone number, and the
 * owner already knows their own number.
 */
export interface MyProfile {
  readonly id: string;
  readonly displayName: string;
  readonly avatarSeed: string;
  readonly identifierMasked: string;
  readonly identifierKind: 'phone' | 'email';
  readonly status: User['status'];
  readonly trustScore: number;
  readonly tier: TrustTier;
  readonly memberSince: string;
  /** The ledger behind `trustScore`, newest first. */
  readonly trustHistory: readonly {
    readonly delta: number;
    readonly reason: TrustEvent['reason'];
    readonly at: string;
  }[];
}

const TRUST_HISTORY_LIMIT = 20;

export class GetMyProfile {
  constructor(private readonly ports: Ports) {}

  async execute(user: User): Promise<MyProfile> {
    const events = await this.ports.users.listTrustEvents(user.id, TRUST_HISTORY_LIMIT);

    return {
      id: user.id,
      displayName: user.displayName,
      avatarSeed: user.avatarSeed,
      identifierMasked: maskIdentifier(user.identifier),
      identifierKind: user.identifierKind,
      status: user.status,
      trustScore: user.trustScore,
      tier: trustTier(user.trustScore),
      memberSince: user.createdAt.toISOString(),
      trustHistory: events.map((event) => ({
        delta: event.delta,
        reason: event.reason,
        at: event.createdAt.toISOString(),
      })),
    };
  }
}

/**
 * Show enough of an identifier to recognise, not enough to reuse.
 *
 * Duplicated deliberately from the notification adapter's masking rather than
 * shared: that one exists for log redaction and may change independently, and
 * coupling a user-facing display format to a logging concern is how one of them
 * ends up wrong.
 */
export function maskIdentifier(identifier: string): string {
  const atIndex = identifier.indexOf('@');

  if (atIndex > 0) {
    const local = identifier.slice(0, atIndex);
    const domain = identifier.slice(atIndex);
    const visible = local.slice(0, Math.min(2, local.length));
    return `${visible}${'*'.repeat(Math.max(1, local.length - visible.length))}${domain}`;
  }

  return identifier.length <= 4
    ? '*'.repeat(identifier.length)
    : `${'*'.repeat(identifier.length - 4)}${identifier.slice(-4)}`;
}
