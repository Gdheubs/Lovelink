import type { PublicProfile, User } from '../../domain/entities/User.js';
import type { Ports } from '../../domain/ports/index.js';
import { normalizeDisplayName, toPublicProfile } from '../../domain/entities/User.js';
import { ValidationError } from '../../domain/errors.js';

/**
 * USE CASE: change your own display name or avatar.
 *
 * WHAT IS DELIBERATELY NOT EDITABLE
 * ---------------------------------
 *  - `dob` — the 18+ gate is only meaningful if the value it checked cannot be
 *    edited afterwards. Correcting a genuine typo is a support action with an
 *    audit trail, not a self-service field.
 *  - `identifier` — changing it is an authentication event (it must be
 *    re-verified with a code), so it belongs in its own use case rather than
 *    riding along with a nickname change.
 *  - `trustScore`, `status` — derived and moderator-controlled respectively.
 *
 * Encoding those exclusions as "this use case simply has no such parameter" is
 * stronger than validating them away: there is no field for an attacker to
 * smuggle, and no reviewer has to notice its absence.
 *
 * REGENERATING AN AVATAR is offered because the seed is random and some seeds
 * produce an avatar someone dislikes. It costs nothing and avoids the pressure
 * to add image uploads, which would open an image-abuse surface the product
 * does not currently have.
 */
export interface UpdateMyProfileInput {
  readonly displayName?: string;
  /** Ask for a fresh random avatar. The seed is never client-supplied. */
  readonly regenerateAvatar?: boolean;
}

export class UpdateMyProfile {
  constructor(private readonly ports: Ports) {}

  async execute(user: User, input: UpdateMyProfileInput): Promise<PublicProfile> {
    const changes: { displayName?: string; avatarSeed?: string } = {};

    if (input.displayName !== undefined) {
      // Domain validation, so the rule is identical here, at signup, and in any
      // future admin tool.
      changes.displayName = normalizeDisplayName(input.displayName);
    }

    if (input.regenerateAvatar === true) {
      // Server-generated. A client-supplied seed would let someone brute-force
      // a seed that renders as something offensive, or collide with another
      // user's avatar to impersonate them.
      changes.avatarSeed = this.ports.ids.token(12);
    }

    if (Object.keys(changes).length === 0) {
      throw new ValidationError('Nothing to update.');
    }

    const updated = await this.ports.users.updateProfile(user.id, changes);

    this.ports.logger.info({ userId: user.id, fields: Object.keys(changes) }, 'profile updated');

    return toPublicProfile(updated);
  }
}
