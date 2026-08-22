import type { ChatMessage } from '../../domain/entities/ChatMessage.js';
import type { User } from '../../domain/entities/User.js';
import type { Ports } from '../../domain/ports/index.js';
import type { ChatMessageView } from '../../domain/ports/RealtimeTransport.js';
import type { MessageId, UserId } from '../../domain/values/ids.js';
import { normalizeChatText } from '../../domain/entities/ChatMessage.js';
import { toPublicProfile } from '../../domain/entities/User.js';
import { assertCanSendDm } from '../../domain/rules/trustLadder.js';
import { LIMITS } from '../../domain/ports/RateLimiter.js';
import { asMessageId } from '../../domain/values/ids.js';
import { NotFoundError, RateLimitError } from '../../domain/errors.js';

/**
 * USE CASE: send a direct message.
 *
 * WHY THE RELATIONSHIP IS RE-READ ON EVERY SINGLE MESSAGE
 * -------------------------------------------------------
 * It would be cheaper to check once when the thread opens and trust the socket
 * for the rest of the session. That is exactly the bug: a person who blocks
 * someone mid-conversation expects the next message to be refused, not the one
 * after they both reconnect. A long-lived socket that cached "we are friends"
 * would keep delivering messages from someone the recipient has just walked
 * away from, and it would do it for as long as the tab stayed open.
 *
 * So authorization is a fresh read, every time. One indexed lookup per message
 * is the price of a block taking effect immediately, and it is worth it.
 *
 * ORDER OF OPERATIONS, same as room chat and for the same reasons:
 *   1. rate limit  — before any work, so a flood costs one Redis INCR
 *   2. authorize   — fresh relationship + both accounts' standing
 *   3. validate    — domain rules on the text
 *   4. persist     — DMs are durable, unlike room chat (ADR 0006)
 *   5. deliver     — to the recipient, and back to the sender's other tabs
 *
 * WHY THE SENDER IS ECHOED TOO
 * ----------------------------
 * The sender's OWN devices need the message: someone typing on a phone with a
 * laptop open should see it appear in both. The socket that sent it can render
 * optimistically, but every other session of theirs learns about it only here.
 */
export interface SendDmInput {
  readonly toUserId: UserId;
  readonly text: string;
}

export class SendDm {
  constructor(private readonly ports: Ports) {}

  async execute(sender: User, input: SendDmInput): Promise<ChatMessageView> {
    const limit = await this.ports.rateLimiter.check(
      `dm:send:${sender.id}`,
      LIMITS.dmSend.limit,
      LIMITS.dmSend.windowSec,
    );
    if (!limit.allowed) {
      this.ports.metrics.increment('ratelimit.blocked');
      throw new RateLimitError('You are sending messages too quickly.');
    }

    const recipient = await this.ports.users.findById(input.toUserId);
    if (recipient === null) throw new NotFoundError('That person');

    const relationship = await this.ports.relationships.get(sender.id, input.toUserId);

    // Throws for: either account restricted or suspended, a block in either
    // direction, or a relationship that never reached `dm_open`. A pending
    // request grants nothing — that is what makes it a request.
    assertCanSendDm({ actor: sender, target: recipient, relationship });

    const text = normalizeChatText(input.text);
    const now = this.ports.clock.now();

    const message: ChatMessage = {
      id: asMessageId(this.ports.ids.uuid()),
      scope: 'dm',
      roomId: null,
      recipientId: input.toUserId,
      senderId: sender.id,
      text,
      sentAt: now,
    };

    // Persisted BEFORE delivery. A message the recipient saw but which is not
    // in the thread on reload is a worse failure than one that arrives a
    // moment late.
    await this.ports.messages.appendDirectMessage(message);

    const view: ChatMessageView = {
      id: message.id,
      roomId: null,
      from: toPublicProfile(sender),
      text,
      sentAt: now.toISOString(),
    };

    await Promise.all([
      this.ports.realtime.emitToUser(input.toUserId, 'dm:message', view),
      this.ports.realtime.emitToUser(sender.id, 'dm:message', view),
    ]);

    this.ports.metrics.increment('dm.message');
    return view;
  }
}

/**
 * USE CASE: read a thread.
 *
 * AUTHORIZATION IS THE SAME RULE AS SENDING, DELIBERATELY
 * -------------------------------------------------------
 * If you may not message someone, you may not read the history either. The
 * alternative — letting a blocked user re-read what was said before the block —
 * turns a safety action into a partial one, and people who block someone are
 * entitled to assume it was complete.
 *
 * Note the consequence, which is intended: blocking hides the thread from the
 * BLOCKED party. It stays visible to the person who blocked, because they may
 * need it to file a report.
 */
export interface ReadDmThreadInput {
  readonly withUserId: UserId;
  readonly limit?: number;
  readonly before?: MessageId;
}

/** A page of history. Newest first, matching the repository's ordering. */
export interface DmThreadPage {
  readonly messages: readonly ChatMessageView[];
  /** Pass as `before` to fetch the next page; null when the thread is exhausted. */
  readonly nextCursor: MessageId | null;
}

const THREAD_PAGE_DEFAULT = 50;
const THREAD_PAGE_MAX = 100;

export class ReadDmThread {
  constructor(private readonly ports: Ports) {}

  async execute(reader: User, input: ReadDmThreadInput): Promise<DmThreadPage> {
    const other = await this.ports.users.findById(input.withUserId);
    if (other === null) throw new NotFoundError('That person');

    const relationship = await this.ports.relationships.get(reader.id, input.withUserId);
    assertCanSendDm({ actor: reader, target: other, relationship });

    const limit = Math.min(Math.max(input.limit ?? THREAD_PAGE_DEFAULT, 1), THREAD_PAGE_MAX);

    // Ask for one more than we intend to return: if it comes back, there is
    // another page, and we know that without a second COUNT query.
    const rows = await this.ports.messages.directThread(
      reader.id,
      input.withUserId,
      limit + 1,
      input.before,
    );

    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit;

    const profiles = new Map([
      [reader.id, toPublicProfile(reader)],
      [other.id, toPublicProfile(other)],
    ]);

    return {
      messages: page.map((message) => ({
        id: message.id,
        roomId: null,
        // A thread has exactly two participants, so the sender is always one
        // of the two profiles already loaded — no N+1 lookup.
        from: profiles.get(message.senderId) ?? toPublicProfile(other),
        text: message.text,
        sentAt: message.sentAt.toISOString(),
      })),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    };
  }
}
