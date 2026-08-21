import type { User } from '../../domain/entities/User.js';
import type { Ports } from '../../domain/ports/index.js';
import type { RoomId } from '../../domain/values/ids.js';
import { assertCanSendRoomMessage } from '../../domain/rules/trustLadder.js';
import { LIMITS } from '../../domain/ports/RateLimiter.js';
import { RateLimitError } from '../../domain/errors.js';

/**
 * USE CASE: raise or lower a hand.
 *
 * WHY A RAISED HAND LIVES IN PRESENCE AND NOT IN POSTGRES
 * -------------------------------------------------------
 * A raised hand is meaningless the moment you leave the room — it is a request
 * to speak in a conversation that is happening now. Storing it durably would
 * mean a hand raised last Tuesday reappearing in the host's queue today, and
 * would require its own cleanup path on every departure.
 *
 * Presence already expires, already survives reconnects within the TTL, and
 * already vanishes when the person does. So the hand rides along with it.
 *
 * THE QUEUE IS ORDERED BY WHEN THE HAND WENT UP, and re-raising does NOT reset
 * that timestamp (see PresenceStore.setHandRaised). Otherwise someone who
 * lowers and re-raises jumps ahead of people who have been waiting — which is
 * both unfair and immediately visible to everyone in the room.
 *
 * AUTHORIZATION: the same rule as chat. If you may speak in the room's text,
 * you may ask to speak aloud in it. A host-muted user may do neither, because
 * letting a muted person spam the host's approval queue would make the mute
 * button feel useless.
 */
export interface RaiseHandInput {
  readonly roomId: RoomId;
  readonly raised: boolean;
}

export class RaiseHand {
  constructor(private readonly ports: Ports) {}

  async execute(user: User, input: RaiseHandInput): Promise<void> {
    const { roomId, raised } = input;

    // Toggling is the abuse vector here — a hand flapping up and down puts a
    // notification in front of the host every time.
    const limit = await this.ports.rateLimiter.check(
      `hand:toggle:${user.id}:${roomId}`,
      LIMITS.handToggle.limit,
      LIMITS.handToggle.windowSec,
    );
    if (!limit.allowed) {
      this.ports.metrics.increment('ratelimit.blocked');
      throw new RateLimitError('You are raising and lowering your hand too quickly.');
    }

    const membership = await this.ports.presence.getMember(roomId, user.id);
    assertCanSendRoomMessage(user, membership);

    // A speaker has nothing to ask for — they already have the floor. Lowering
    // is still allowed, so a promoted user's stale hand can be cleared.
    if (raised && membership !== null && membership.role !== 'listener') {
      return;
    }

    await this.ports.presence.setHandRaised(roomId, user.id, raised);

    // Broadcast to the whole room, not just the host. Seeing who is waiting is
    // part of how a room self-regulates — people yield when they can see three
    // others queued behind them.
    await this.ports.realtime.emitToRoom(roomId, 'hand:raised', {
      roomId,
      userId: user.id,
      raised,
    });

    if (raised) this.ports.metrics.increment('hand.raised');
  }
}
