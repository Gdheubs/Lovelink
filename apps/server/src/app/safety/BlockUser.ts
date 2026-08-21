import type { User } from '../../domain/entities/User.js';
import type { Ports } from '../../domain/ports/index.js';
import type { UserId } from '../../domain/values/ids.js';
import { canTransition } from '../../domain/entities/Relationship.js';
import { ConflictError, NotFoundError, ValidationError } from '../../domain/errors.js';

/**
 * USE CASE: block someone.
 *
 * BLOCKING IS MUTUAL AND SILENT — both properties matter
 * -----------------------------------------------------
 * MUTUAL: the blocked party also stops seeing the blocker. A one-way block
 * leaves the blocked person able to watch, follow into rooms, and see when
 * their target is online — which is precisely the behaviour someone reaches
 * for the block button to stop.
 *
 * SILENT: the blocked party is never told. Every "X blocked you" notification
 * ever shipped has been used as a provocation, and the person most likely to
 * escalate on receiving one is the person who was just blocked.
 *
 * So there is no event, no notification, and nothing in any API response that
 * distinguishes "blocked" from "not available". The trust ladder's denial
 * reason for a block is deliberately the same generic message as for an
 * inactive account.
 *
 * IT WORKS FROM ANY STATE. `canTransition` allows `blocked` from every other
 * state, because someone deciding they want no further contact must not be
 * told to undo something else first.
 */
export class BlockUser {
  constructor(private readonly ports: Ports) {}

  async execute(actor: User, targetId: UserId): Promise<void> {
    if (actor.id === targetId) {
      throw new ValidationError('You cannot block yourself.');
    }

    const target = await this.ports.users.findById(targetId);
    if (target === null) throw new NotFoundError('That person');

    const current = await this.ports.relationships.get(actor.id, targetId);

    // Already blocked — quietly done. Throwing would make a double-tap look
    // like a failure at exactly the moment someone wants reassurance.
    if (current.state === 'blocked') return;

    if (!canTransition(current.state, 'blocked')) {
      throw new ConflictError('That could not be done right now.');
    }

    const result = await this.ports.relationships.transition(
      actor.id,
      targetId,
      current.state,
      'blocked',
      { requestedBy: null, blockedBy: actor.id },
      this.ports.clock.now(),
    );

    if (result === null) {
      // The compare-and-set lost a race. Re-read: if the pair ended up blocked
      // anyway, the user got what they wanted and should not see an error.
      const latest = await this.ports.relationships.get(actor.id, targetId);
      if (latest.state === 'blocked') return;
      throw new ConflictError('That could not be done right now. Try again.');
    }

    // NO EVENT IS EMITTED. See the note above — this is the point.
    this.ports.logger.info({ actorId: actor.id, targetId }, 'user blocked');
  }
}

/**
 * USE CASE: unblock.
 *
 * Returns the pair to `none`, NEVER to whatever they had before. Restoring a
 * previous rung would mean unblocking silently re-granted DM or call access
 * that the other person consented to under different circumstances — so the
 * ladder has to be climbed again, with fresh consent at each step.
 */
export class UnblockUser {
  constructor(private readonly ports: Ports) {}

  async execute(actor: User, targetId: UserId): Promise<void> {
    const current = await this.ports.relationships.get(actor.id, targetId);

    if (current.state !== 'blocked') return;

    // Only the person who applied the block may lift it. Otherwise the blocked
    // party could simply unblock themselves.
    if (current.blockedBy !== actor.id) {
      throw new NotFoundError('That person');
    }

    await this.ports.relationships.transition(
      actor.id,
      targetId,
      'blocked',
      'none',
      { requestedBy: null, blockedBy: null },
      this.ports.clock.now(),
    );

    this.ports.logger.info({ actorId: actor.id, targetId }, 'user unblocked');
  }
}
