import type { ChatMessage } from '../../domain/entities/ChatMessage.js';
import type { MessageRepository } from '../../domain/ports/MessageRepository.js';
import { ROOM_BUFFER_SIZE } from '../../domain/ports/MessageRepository.js';
import type { MessageId, RoomId, UserId } from '../../domain/values/ids.js';
import { pairKey } from '../../domain/values/ids.js';

/**
 * ADAPTER (memory): message storage with the port's two retention policies.
 *
 * Room messages go into a bounded ring trimmed to ROOM_BUFFER_SIZE — the same
 * bound the Redis adapter applies with LTRIM. Modelling the bound here matters:
 * a fake with unlimited room history would let a test assert on a hundred
 * messages of scrollback that production would have thrown away.
 *
 * DM threads are unbounded, matching Postgres.
 */
export class MemoryMessageRepository implements MessageRepository {
  private readonly roomBuffers = new Map<string, ChatMessage[]>();
  private readonly dmThreads = new Map<string, ChatMessage[]>();

  async appendRoomMessage(message: ChatMessage): Promise<void> {
    if (message.roomId === null) return;
    const buffer = this.roomBuffers.get(message.roomId) ?? [];
    buffer.push(message);
    // Trim from the front, keeping the newest ROOM_BUFFER_SIZE.
    if (buffer.length > ROOM_BUFFER_SIZE) {
      buffer.splice(0, buffer.length - ROOM_BUFFER_SIZE);
    }
    this.roomBuffers.set(message.roomId, buffer);
  }

  async recentRoomMessages(roomId: RoomId, limit: number): Promise<readonly ChatMessage[]> {
    const buffer = this.roomBuffers.get(roomId) ?? [];
    // Oldest first, as the port specifies — the client renders them top to bottom.
    return buffer.slice(Math.max(0, buffer.length - limit));
  }

  async clearRoomMessages(roomId: RoomId): Promise<void> {
    this.roomBuffers.delete(roomId);
  }

  async appendDirectMessage(message: ChatMessage): Promise<void> {
    if (message.recipientId === null) return;
    const key = pairKey(message.senderId, message.recipientId);
    const thread = this.dmThreads.get(key) ?? [];
    thread.push(message);
    this.dmThreads.set(key, thread);
  }

  async directThread(
    a: UserId,
    b: UserId,
    limit: number,
    before?: MessageId,
  ): Promise<readonly ChatMessage[]> {
    const thread = this.dmThreads.get(pairKey(a, b)) ?? [];
    // Newest first, as the port specifies.
    const ordered = [...thread].reverse();

    if (before === undefined) return ordered.slice(0, limit);

    const index = ordered.findIndex((m) => m.id === before);
    // An unknown cursor returns the newest page rather than nothing: a client
    // whose cursor refers to a trimmed message should recover, not go blank.
    if (index < 0) return ordered.slice(0, limit);
    return ordered.slice(index + 1, index + 1 + limit);
  }

  /** Test helper. Not part of the port. */
  clear(): void {
    this.roomBuffers.clear();
    this.dmThreads.clear();
  }
}
