import type { RoomCategory, RoomStatus } from '../../domain/entities/Room.js';
import type { Ports } from '../../domain/ports/index.js';
import { isRoomCategory } from '../../domain/entities/Room.js';
import { ValidationError } from '../../domain/errors.js';

/**
 * USE CASE: the room list — the app's home screen.
 *
 * WHY LIVE COUNTS ARE FETCHED SEPARATELY
 * --------------------------------------
 * A room row needs "how many people are in there right now", and that number
 * lives in Redis, not Postgres (see architecture §3). So the list is a join
 * across two stores, done here rather than in a repository — a repository that
 * reached into the presence store would be two ports pretending to be one.
 *
 * The counts are fetched CONCURRENTLY. Sequentially, a page of 20 rooms is 20
 * round trips stacked end to end, which is the difference between a list that
 * appears instantly and one that visibly loads.
 *
 * ORDERING, AND WHY IT IS NOT "MOST POPULAR"
 * ------------------------------------------
 * Rooms are ordered by occupancy, then recency. That is deliberately a simple,
 * explainable rule rather than a ranking algorithm — recommendation algorithms
 * are explicitly out of scope, and an opaque ordering on a social product is
 * something users notice and distrust long before it helps them.
 *
 * Occupancy first because an empty room is a bad first experience: the whole
 * promise is walking into a conversation already happening.
 */
export interface ListRoomsInput {
  readonly category?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface RoomSummary {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly category: RoomCategory;
  readonly hostUserId: string;
  readonly status: RoomStatus;
  readonly memberCount: number;
  readonly maxSpeakers: number;
  readonly createdAt: string;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export class ListRooms {
  constructor(private readonly ports: Ports) {}

  async execute(input: ListRoomsInput = {}): Promise<readonly RoomSummary[]> {
    const limit = clampLimit(input.limit);
    const offset = Math.max(0, input.offset ?? 0);

    if (input.category !== undefined && !isRoomCategory(input.category)) {
      throw new ValidationError('That is not a room category.');
    }

    const rooms = await this.ports.rooms.list({
      ...(input.category === undefined ? {} : { category: input.category as RoomCategory }),
      // Closed rooms are not listable. They still exist for moderation history,
      // but nobody should be able to walk into one.
      status: 'live',
      limit,
      offset,
    });

    // Concurrent, not sequential — see the note above.
    const counts = await Promise.all(
      rooms.map((room) => this.ports.presence.countRoomMembers(room.id)),
    );

    const summaries = rooms.map((room, index) => ({
      id: room.id,
      slug: room.slug,
      title: room.title,
      category: room.category,
      hostUserId: room.hostUserId,
      status: room.status,
      memberCount: counts[index] ?? 0,
      maxSpeakers: room.maxSpeakers,
      createdAt: room.createdAt.toISOString(),
    }));

    return summaries.sort((a, b) => {
      if (a.memberCount !== b.memberCount) return b.memberCount - a.memberCount;
      return b.createdAt.localeCompare(a.createdAt);
    });
  }
}

function clampLimit(requested: number | undefined): number {
  if (requested === undefined) return DEFAULT_LIMIT;
  if (!Number.isFinite(requested)) return DEFAULT_LIMIT;
  // Clamped rather than rejected: a client asking for 10,000 rooms is a bug or
  // a probe, and neither deserves an error page — it deserves 50 rooms.
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(requested)));
}
