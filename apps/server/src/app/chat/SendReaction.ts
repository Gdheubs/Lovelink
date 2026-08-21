import type { User } from '../../domain/entities/User.js';
import type { Ports } from '../../domain/ports/index.js';
import type { RoomId } from '../../domain/values/ids.js';
import { assertAllowedReaction } from '../../domain/entities/ChatMessage.js';
import { assertCanSendRoomMessage } from '../../domain/rules/trustLadder.js';
import { LIMITS } from '../../domain/ports/RateLimiter.js';
import { RateLimitError } from '../../domain/errors.js';

/**
 * USE CASE: send a lightweight reaction to the room.
 *
 * WHY A CLOSED PALETTE INSTEAD OF ARBITRARY EMOJI
 * -----------------------------------------------
 * An open emoji field is a free-form text channel wearing a costume. It can
 * carry ZWJ sequences that render as effectively arbitrary images, flag
 * sequences, and long strings that break layout — and it is a well-worn route
 * around chat moderation, because "it was only an emoji" is how people describe
 * abuse sent through one.
 *
 * `ALLOWED_REACTIONS` in the domain is the whitelist, and the wire carries a
 * NAME (`heart`) rather than a glyph. The client maps names to glyphs, which
 * additionally means we can change the artwork without a data migration.
 *
 * WHY REACTIONS ARE NOT PERSISTED
 * -------------------------------
 * A reaction is a moment, not a record — it is the equivalent of nodding. It is
 * broadcast and forgotten, so it never enters the room buffer and a
 * reconnecting client does not see a burst of stale ones.
 */
export interface SendReactionInput {
  readonly roomId: RoomId;
  /** A name from ALLOWED_REACTIONS, never a raw glyph. */
  readonly reaction: string;
}

export class SendReaction {
  constructor(private readonly ports: Ports) {}

  async execute(sender: User, input: SendReactionInput): Promise<void> {
    const { roomId, reaction } = input;

    // Reaction spam is a screen-flooding tactic, so the limit is tighter than
    // chat: there is no legitimate reason to send ten reactions in five seconds.
    const limit = await this.ports.rateLimiter.check(
      `reaction:send:${sender.id}:${roomId}`,
      LIMITS.reactionSend.limit,
      LIMITS.reactionSend.windowSec,
    );
    if (!limit.allowed) {
      this.ports.metrics.increment('ratelimit.blocked');
      throw new RateLimitError('Slow down with the reactions.');
    }

    // Same authorization as chat, from live presence — including that a
    // host-muted user cannot react. Muting someone who then floods the room
    // with reactions would make the mute button feel useless.
    const membership = await this.ports.presence.getMember(roomId, sender.id);
    assertCanSendRoomMessage(sender, membership);

    assertAllowedReaction(reaction);

    await this.ports.realtime.emitToRoom(roomId, 'reaction:shown', {
      roomId,
      userId: sender.id,
      reaction,
    });

    this.ports.metrics.increment('reaction.sent');
  }
}
