import type { ChatMessage } from '../../domain/entities/ChatMessage.js';
import type { User } from '../../domain/entities/User.js';
import type { Ports } from '../../domain/ports/index.js';
import type { ChatMessageView } from '../../domain/ports/RealtimeTransport.js';
import type { RoomId } from '../../domain/values/ids.js';
import { normalizeChatText } from '../../domain/entities/ChatMessage.js';
import { toPublicProfile } from '../../domain/entities/User.js';
import { assertCanSendRoomMessage } from '../../domain/rules/trustLadder.js';
import { LIMITS } from '../../domain/ports/RateLimiter.js';
import { asMessageId } from '../../domain/values/ids.js';
import { NotFoundError, RateLimitError } from '../../domain/errors.js';

/**
 * USE CASE: send a message to a room.
 *
 * THE ORDER OF OPERATIONS IS THE POINT
 * ------------------------------------
 *   1. rate limit   — consumed BEFORE any work, so a flood costs the attacker
 *                     a Redis INCR and costs us nothing else
 *   2. authorize    — from LIVE PRESENCE, never from anything the client sent
 *   3. validate     — domain rules on the text itself
 *   4. persist      — into the bounded room buffer
 *   5. broadcast    — through the transport port
 *
 * Getting 1 and 2 the wrong way round is the common mistake: authorizing first
 * means a flood of unauthorized messages still costs a presence lookup each.
 *
 * WHY MEMBERSHIP COMES FROM PRESENCE
 * ----------------------------------
 * `assertCanSendRoomMessage` needs the sender's role and host-mute state. Those
 * are read from the PresenceStore — the live truth — rather than from the
 * durable `room_members` mirror, because someone who left thirty seconds ago
 * still has a durable row and must not be able to keep talking. It is also
 * never read from the socket's own memory, because a long-lived socket would
 * then hold a stale role after a host muted them.
 *
 * A HOST MUTE SILENCES TEXT TOO. That is enforced in the domain rule, not here,
 * so the socket edge and any future REST edge inherit it.
 */
export interface SendChatMessageInput {
  readonly roomId: RoomId;
  readonly text: string;
}

export class SendChatMessage {
  constructor(private readonly ports: Ports) {}

  async execute(sender: User, input: SendChatMessageInput): Promise<ChatMessageView> {
    const { roomId, text } = input;

    // 1. Rate limit, keyed per user PER ROOM: being throttled in one room
    //    should not silence someone in another.
    const limit = await this.ports.rateLimiter.check(
      `chat:send:${sender.id}:${roomId}`,
      LIMITS.chatSend.limit,
      LIMITS.chatSend.windowSec,
    );
    if (!limit.allowed) {
      this.ports.metrics.increment('ratelimit.blocked');
      throw new RateLimitError('You are sending messages too quickly.');
    }

    // 2. Authorize from live presence.
    const membership = await this.ports.presence.getMember(roomId, sender.id);
    assertCanSendRoomMessage(sender, membership);

    // 3. Validate. Length, control characters, bidi overrides — all in the
    //    domain, so a DM cannot end up with different rules.
    const body = normalizeChatText(text);

    const message: ChatMessage = {
      id: asMessageId(this.ports.ids.uuid()),
      scope: 'room',
      roomId,
      recipientId: null,
      senderId: sender.id,
      text: body,
      sentAt: this.ports.clock.now(),
    };

    // 4. Persist into the bounded buffer. This is ONLY so that someone joining
    //    or reconnecting sees context — room chat is ephemeral by product
    //    design (ADR 0006), and this is not a transcript.
    await this.ports.messages.appendRoomMessage(message);

    const view: ChatMessageView = {
      id: message.id,
      roomId,
      from: toPublicProfile(sender),
      text: message.text,
      sentAt: message.sentAt.toISOString(),
    };

    // 5. Broadcast, including back to the sender.
    //
    //    Echoing to the sender is deliberate: it means the message they see is
    //    the one the server accepted, with the server's id and timestamp. The
    //    alternative — rendering optimistically and suppressing the echo —
    //    leaves the client showing text the server may have rejected or
    //    normalized differently.
    await this.ports.realtime.emitToRoom(roomId, 'chat:message', view);

    this.ports.metrics.increment('chat.message');
    return view;
  }
}

/**
 * USE CASE: the typing indicator.
 *
 * Separate from sending because it is a fundamentally different thing: it is
 * NOT persisted, NOT echoed to the sender, and is allowed to be lost. Folding
 * it into SendChatMessage would mean either persisting keystrokes or growing a
 * branch through the middle of the message path.
 */
export class SendTypingIndicator {
  constructor(private readonly ports: Ports) {}

  async execute(sender: User, roomId: RoomId): Promise<void> {
    const limit = await this.ports.rateLimiter.check(
      `chat:typing:${sender.id}:${roomId}`,
      LIMITS.chatTyping.limit,
      LIMITS.chatTyping.windowSec,
    );
    // Silently dropped rather than thrown. A typing indicator is a hint; a
    // client should not see an error for typing quickly, and there is nothing
    // useful for it to do about one.
    if (!limit.allowed) return;

    const membership = await this.ports.presence.getMember(roomId, sender.id);
    if (membership === null) throw new NotFoundError('Room membership');

    // Host-muted users do not get to advertise that they are typing either.
    if (membership.mutedByHost) return;

    await this.ports.realtime.emitToRoomExcept(roomId, sender.id, 'chat:typing', {
      roomId,
      userId: sender.id,
    });
  }
}
