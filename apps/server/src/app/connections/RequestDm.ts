import type { User } from '../../domain/entities/User.js';
import type { Ports } from '../../domain/ports/index.js';
import type { UserId } from '../../domain/values/ids.js';
import { toPublicProfile } from '../../domain/entities/User.js';
import { assertCanRequestDm, type DmContext } from '../../domain/rules/trustLadder.js';
import { LIMITS } from '../../domain/ports/RateLimiter.js';
import { ConflictError, NotFoundError, RateLimitError } from '../../domain/errors.js';

/**
 * USE CASE: ask someone if you can message them.
 *
 * THE RUNG THIS ENFORCES
 * ----------------------
 * You may only ask someone you have ACTUALLY SHARED A ROOM WITH — meaning your
 * time in that room overlapped theirs, not merely that you both visited it at
 * some point. That evidence comes from the durable `room_members` mirror, and
 * the overlap check is what stops anyone unlocking a stranger by joining a
 * popular room the stranger once used.
 *
 * WHY REQUEST-THEN-ACCEPT AND NOT JUST "SEND A MESSAGE"
 * -----------------------------------------------------
 * Because the alternative is unsolicited contact from strangers, which is the
 * single most reliable way to make a social product unpleasant for the people
 * it is most trying to serve. A request is one notification; an open inbox is
 * an unbounded stream from anyone who was ever in a room with you.
 *
 * The request itself carries NO MESSAGE for the same reason — a "request" with
 * a free-text field attached is just a message that ignores consent.
 */
export class RequestDm {
  constructor(private readonly ports: Ports) {}

  async execute(actor: User, targetId: UserId): Promise<void> {
    // Deliberately harsh: this is the primary unsolicited-contact vector, and
    // there is no legitimate reason to open twenty conversations an hour.
    const limit = await this.ports.rateLimiter.check(
      `dm:request:${actor.id}`,
      LIMITS.dmRequest.limit,
      LIMITS.dmRequest.windowSec,
    );
    if (!limit.allowed) {
      this.ports.metrics.increment('ratelimit.blocked');
      throw new RateLimitError('You have sent several requests recently. Give people time.');
    }

    const target = await this.ports.users.findById(targetId);
    if (target === null) throw new NotFoundError('That person');

    const relationship = await this.ports.relationships.get(actor.id, targetId);
    const haveSharedRoomSession = await this.ports.rooms.haveSharedRoomSession(actor.id, targetId);

    const context: DmContext = { actor, target, relationship, haveSharedRoomSession };

    // The domain rule. Throws TRUST_LADDER_VIOLATION with a message that
    // explains the rule, or the generic unavailability message for a block —
    // which must be indistinguishable from any other reason.
    assertCanRequestDm(context);

    const updated = await this.ports.relationships.transition(
      actor.id,
      targetId,
      relationship.state,
      'dm_requested',
      { requestedBy: actor.id, blockedBy: null },
      this.ports.clock.now(),
    );

    if (updated === null) {
      // Lost a compare-and-set race — most likely the other person blocked or
      // requested in the same moment. Re-reading and reporting the truth beats
      // a retry that could override their decision.
      throw new ConflictError('That could not be done right now.');
    }

    await this.ports.realtime.emitToUser(targetId, 'dm:requested', {
      fromUserId: actor.id,
      from: toPublicProfile(actor),
    });

    this.ports.metrics.increment('dm.requested');
    this.ports.logger.info({ actorId: actor.id, targetId }, 'dm requested');
  }
}

/**
 * USE CASE: accept a request.
 *
 * ONLY THE PERSON WHO WAS ASKED MAY ACCEPT. That sounds obvious and is the
 * entire consent mechanism: `requestedBy` records the direction, and without
 * this check the requester could accept on the other person's behalf and open
 * their own channel.
 */
export class AcceptDm {
  constructor(private readonly ports: Ports) {}

  async execute(actor: User, requesterId: UserId): Promise<void> {
    const relationship = await this.ports.relationships.get(actor.id, requesterId);

    if (relationship.state !== 'dm_requested') {
      throw new NotFoundError('That request');
    }

    // The requester cannot accept their own request.
    if (relationship.requestedBy !== requesterId) {
      throw new NotFoundError('That request');
    }

    const requester = await this.ports.users.findById(requesterId);
    if (requester === null) throw new NotFoundError('That person');

    const updated = await this.ports.relationships.transition(
      actor.id,
      requesterId,
      'dm_requested',
      'dm_open',
      { requestedBy: null, blockedBy: null },
      this.ports.clock.now(),
    );

    if (updated === null) throw new ConflictError('That could not be done right now.');

    // BOTH are told, and each is told about the other — the conversation is
    // now symmetric, so the payloads are too.
    await this.ports.realtime.emitToUser(requesterId, 'dm:opened', {
      withUserId: actor.id,
      with: toPublicProfile(actor),
    });
    await this.ports.realtime.emitToUser(actor.id, 'dm:opened', {
      withUserId: requesterId,
      with: toPublicProfile(requester),
    });

    await this.ports.bus.publish('relationship', {
      type: 'relationship.changed',
      userA: actor.id,
      userB: requesterId,
      state: 'dm_open',
    });

    this.ports.metrics.increment('dm.opened');
    this.ports.logger.info({ actorId: actor.id, requesterId }, 'dm opened');
  }
}

/**
 * USE CASE: decline a request.
 *
 * Returns the pair to `none` and tells the requester NOTHING. A "your request
 * was declined" notification is an invitation to ask again, or worse — and the
 * person declining chose not to have a conversation, which includes not having
 * one about the decline.
 *
 * From the requester's side this is indistinguishable from a request that has
 * simply not been answered yet, which is the kindest available ambiguity.
 */
export class DeclineDm {
  constructor(private readonly ports: Ports) {}

  async execute(actor: User, requesterId: UserId): Promise<void> {
    const relationship = await this.ports.relationships.get(actor.id, requesterId);

    if (relationship.state !== 'dm_requested' || relationship.requestedBy !== requesterId) {
      return; // Nothing to decline. Silence is the correct response either way.
    }

    await this.ports.relationships.transition(
      actor.id,
      requesterId,
      'dm_requested',
      'none',
      { requestedBy: null, blockedBy: null },
      this.ports.clock.now(),
    );

    this.ports.logger.info({ actorId: actor.id, requesterId }, 'dm request declined');
  }
}
