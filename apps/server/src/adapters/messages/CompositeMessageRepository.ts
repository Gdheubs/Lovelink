import type { ChatMessage } from '../../domain/entities/ChatMessage.js';
import type { MessageRepository } from '../../domain/ports/MessageRepository.js';
import { ROOM_BUFFER_SIZE } from '../../domain/ports/MessageRepository.js';
import type { MessageId, RoomId, UserId } from '../../domain/values/ids.js';
import { asMessageId, asRoomId, asUserId, pairKey } from '../../domain/values/ids.js';
import type { Database } from '../postgres/db.js';
import { KEY, type RedisClient } from '../redis/client.js';

/**
 * ADAPTER: MessageRepository across TWO stores.
 *
 * WHY ONE ADAPTER SPANS REDIS AND POSTGRES
 * ----------------------------------------
 * The port deliberately covers both room chat and DMs (see ADR 0006), because
 * they are the same thing with different retention:
 *
 *   ROOM CHAT — ephemeral by product design. A third place is not a forum, and
 *               permanently logging every word said in a late-night support
 *               room changes what people are willing to say there. Stored as a
 *               bounded Redis LIST, trimmed to ROOM_BUFFER_SIZE, existing only
 *               to fill the `room:state` snapshot for someone joining or
 *               reconnecting.
 *
 *   DMs       — persistent, because a conversation you scroll back through is
 *               the whole point. Stored in Postgres.
 *
 * Splitting these into two adapters would put the retention decision in two
 * places, and a future "just log room chat too, for moderation" change would
 * then only need one of them edited to quietly break the promise.
 *
 * The room buffer TTLs as well as trims: a room nobody has spoken in for a day
 * should not hold memory forever.
 */

/** Room buffers expire outright after this long with no activity. */
const ROOM_BUFFER_TTL_SECONDS = 24 * 60 * 60;

interface StoredRoomMessage {
  id: string;
  senderId: string;
  text: string;
  sentAt: string;
}

interface DirectMessageRow {
  id: string;
  sender_id: string;
  recipient_id: string;
  text: string;
  sent_at: Date;
}

export class CompositeMessageRepository implements MessageRepository {
  constructor(
    private readonly redis: RedisClient,
    private readonly db: Database,
  ) {}

  // -- room chat: Redis, bounded -------------------------------------------

  async appendRoomMessage(message: ChatMessage): Promise<void> {
    if (message.roomId === null) return;

    const key = KEY.roomMessages(message.roomId);
    const stored: StoredRoomMessage = {
      id: message.id,
      senderId: message.senderId,
      text: message.text,
      sentAt: message.sentAt.toISOString(),
    };

    // RPUSH + LTRIM + EXPIRE in one pipeline. LTRIM keeps the LAST
    // ROOM_BUFFER_SIZE entries; without it a busy room grows without bound and
    // the "ephemeral" promise becomes a lie told by an unbounded list.
    await this.redis
      .multi()
      .rpush(key, JSON.stringify(stored))
      .ltrim(key, -ROOM_BUFFER_SIZE, -1)
      .expire(key, ROOM_BUFFER_TTL_SECONDS)
      .exec();
  }

  async recentRoomMessages(roomId: RoomId, limit: number): Promise<readonly ChatMessage[]> {
    const capped = Math.min(limit, ROOM_BUFFER_SIZE);
    // Negative indices take the tail. Oldest-first, as the port specifies, so
    // the client renders top to bottom without reversing.
    const raw = await this.redis.lrange(KEY.roomMessages(roomId), -capped, -1);

    const messages: ChatMessage[] = [];
    for (const entry of raw) {
      const parsed = parseRoomMessage(entry, roomId);
      // A corrupt entry is skipped rather than thrown: one bad record must not
      // make a whole room unjoinable.
      if (parsed !== null) messages.push(parsed);
    }
    return messages;
  }

  async clearRoomMessages(roomId: RoomId): Promise<void> {
    await this.redis.del(KEY.roomMessages(roomId));
  }

  // -- direct messages: Postgres, durable ----------------------------------

  async appendDirectMessage(message: ChatMessage): Promise<void> {
    if (message.recipientId === null) return;

    await this.db.query(
      `INSERT INTO direct_messages (id, sender_id, recipient_id, pair_key, text, sent_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        message.id,
        message.senderId,
        message.recipientId,
        // Denormalized so a thread is one index lookup rather than an OR across
        // both directions — see the column comment in migration 0001.
        pairKey(message.senderId, message.recipientId),
        message.text,
        message.sentAt,
      ],
    );
  }

  async directThread(
    a: UserId,
    b: UserId,
    limit: number,
    before?: MessageId,
  ): Promise<readonly ChatMessage[]> {
    // Keyset pagination, not OFFSET. OFFSET re-scans everything it skips, so
    // paging deep into a long conversation gets slower the further back you
    // go; comparing against the cursor's timestamp uses the index directly.
    //
    // The tie-break on `id` matters: two messages can share a timestamp at
    // millisecond resolution, and without it one of them would be skipped or
    // repeated at a page boundary.
    const rows = await this.db.query<DirectMessageRow>(
      `SELECT id, sender_id, recipient_id, text, sent_at
         FROM direct_messages
        WHERE pair_key = $1
          AND ($2::uuid IS NULL OR (sent_at, id) < (
                SELECT sent_at, id FROM direct_messages WHERE id = $2
              ))
        ORDER BY sent_at DESC, id DESC
        LIMIT $3`,
      [pairKey(a, b), before ?? null, limit],
    );

    return rows.map((row) => ({
      id: asMessageId(row.id),
      scope: 'dm' as const,
      roomId: null,
      recipientId: asUserId(row.recipient_id),
      senderId: asUserId(row.sender_id),
      text: row.text,
      sentAt: row.sent_at,
    }));
  }
}

function parseRoomMessage(raw: string, roomId: RoomId): ChatMessage | null {
  try {
    const parsed = JSON.parse(raw) as Partial<StoredRoomMessage>;
    if (
      typeof parsed.id !== 'string' ||
      typeof parsed.senderId !== 'string' ||
      typeof parsed.text !== 'string' ||
      typeof parsed.sentAt !== 'string'
    ) {
      return null;
    }

    return {
      id: asMessageId(parsed.id),
      scope: 'room',
      roomId: asRoomId(roomId),
      recipientId: null,
      senderId: asUserId(parsed.senderId),
      text: parsed.text,
      sentAt: new Date(parsed.sentAt),
    };
  } catch {
    return null;
  }
}
