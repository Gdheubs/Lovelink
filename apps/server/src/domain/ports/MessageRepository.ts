import type { ChatMessage } from '../entities/ChatMessage.js';
import type { MessageId, RoomId, UserId } from '../values/ids.js';

/**
 * PORT: MessageRepository
 *
 * WHY TWO RETENTION POLICIES BEHIND ONE PORT
 * ------------------------------------------
 * Room chat is EPHEMERAL by product design — a third place is not a forum, and
 * permanently logging every word said in a support room would change what
 * people are willing to say there. DMs are PERSISTENT, because a conversation
 * you have to scroll back through is the point.
 *
 * Both are stored through this port so the difference is a policy decision in
 * one file rather than an accident of which code path a message took.
 * `appendRoomMessage` writes to a bounded buffer (Redis list in production,
 * trimmed to ROOM_BUFFER_SIZE) purely to populate the `room:state` snapshot for
 * someone joining or reconnecting. `appendDirectMessage` writes to Postgres.
 */

/** How much room chat a reconnecting client gets back. Enough for context, not a log. */
export const ROOM_BUFFER_SIZE = 50;

export interface MessageRepository {
  /**
   * Append to a room's rolling buffer. Older entries beyond ROOM_BUFFER_SIZE
   * are discarded by the implementation, not by the caller.
   */
  appendRoomMessage(message: ChatMessage): Promise<void>;

  /** The tail of a room's buffer, oldest first, for the join snapshot. */
  recentRoomMessages(roomId: RoomId, limit: number): Promise<readonly ChatMessage[]>;

  /** Drop a room's buffer entirely. Called when a room closes. */
  clearRoomMessages(roomId: RoomId): Promise<void>;

  // -- direct messages (durable) ------------------------------------------

  appendDirectMessage(message: ChatMessage): Promise<void>;

  /**
   * A DM thread between two users, newest first, cursor-paginated.
   * @param before return messages sent strictly before this id.
   */
  directThread(
    a: UserId,
    b: UserId,
    limit: number,
    before?: MessageId,
  ): Promise<readonly ChatMessage[]>;
}
