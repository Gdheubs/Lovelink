import type { MessageId, RoomId, UserId } from '../values/ids.js';
import { hasUnsafeCharacters, MULTI_LINE, normalizeBody } from '../values/text.js';
import { ValidationError } from '../errors.js';

/**
 * A text message, either in a room or in a 1:1 DM.
 *
 * WHY ONE ENTITY FOR BOTH
 * -----------------------
 * Room chat and DM chat differ only in their destination and their
 * authorization rule; the message itself, its validation, and its rendering are
 * identical. Two near-identical entities would guarantee that a length limit or
 * a safety check eventually gets fixed in one and not the other.
 *
 * `scope` discriminates the two. The authorization difference lives in the use
 * cases (SendChatMessage vs SendDirectMessage), not here.
 *
 * RETENTION NOTE: room chat is ephemeral by product design (a third place is
 * not a forum) and is kept only in the realtime layer plus a short Redis
 * buffer for the `room:state` snapshot. DMs are persisted. That is why this
 * entity carries no `deletedAt` — nothing in room scope lives long enough to
 * need it.
 */
export type ChatScope = 'room' | 'dm';

export interface ChatMessage {
  readonly id: MessageId;
  readonly scope: ChatScope;
  /** Set for room-scope messages. */
  readonly roomId: RoomId | null;
  /** Set for dm-scope messages: the other party. */
  readonly recipientId: UserId | null;
  readonly senderId: UserId;
  readonly text: string;
  readonly sentAt: Date;
}

export const CHAT_TEXT_MAX = 500;

export function normalizeChatText(text: string): string {
  const body = normalizeBody(text);
  if (body.length === 0) {
    throw new ValidationError('Message cannot be empty.');
  }
  if (body.length > CHAT_TEXT_MAX) {
    throw new ValidationError(`Message must be ${CHAT_TEXT_MAX} characters or fewer.`);
  }
  if (hasUnsafeCharacters(body, MULTI_LINE)) {
    throw new ValidationError('Message contains characters that are not allowed.');
  }
  return body;
}

/**
 * Reactions are a fixed palette rather than arbitrary emoji input.
 *
 * WHY: an open emoji field is a free-form text channel — it can carry ZWJ
 * sequences that render as arbitrary images, and it is a well-worn route around
 * chat moderation. A closed set keeps reactions a lightweight social signal.
 */
export const ALLOWED_REACTIONS: readonly string[] = Object.freeze([
  'heart',
  'clap',
  'laugh',
  'wow',
  'sad',
  'fire',
  'wave',
  'plus_one',
] as const);

export function isAllowedReaction(value: string): boolean {
  return ALLOWED_REACTIONS.includes(value);
}

export function assertAllowedReaction(value: string): void {
  if (!isAllowedReaction(value)) {
    throw new ValidationError('That reaction is not available.');
  }
}
