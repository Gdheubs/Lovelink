import type { Room, RoomStatus } from '../../domain/entities/Room.js';
import type { RoomMember, RoomRole } from '../../domain/entities/RoomMember.js';
import type {
  CreateRoomInput,
  RoomListFilter,
  RoomRepository,
} from '../../domain/ports/RoomRepository.js';
import type { RoomId, UserId } from '../../domain/values/ids.js';
import { ConflictError, NotFoundError } from '../../domain/errors.js';

/**
 * ADAPTER (memory): RoomRepository, including the durable membership mirror.
 *
 * THE INTERESTING PART is `haveSharedRoomSession`, which backs the DM rung of
 * the trust ladder. It must answer "were these two in the same room AT THE SAME
 * TIME", so it compares intervals — [joinedAt, leftAt ?? now) — rather than
 * merely checking that both users have a row for the same room. Getting that
 * wrong would let anyone unlock DMs with a stranger by joining a room the
 * stranger visited last week, which defeats the entire ladder.
 */
export class MemoryRoomRepository implements RoomRepository {
  private readonly rooms = new Map<string, Room>();
  private readonly slugs = new Map<string, string>();
  /** All membership rows, open and closed. Keyed by roomId for cheap scans. */
  private readonly members = new Map<string, RoomMember[]>();

  async create(input: CreateRoomInput): Promise<Room> {
    if (this.slugs.has(input.slug)) {
      throw new ConflictError('A room with that address already exists.');
    }
    const room: Room = Object.freeze({ ...input });
    this.rooms.set(room.id, room);
    this.slugs.set(room.slug, room.id);
    this.members.set(room.id, []);
    return room;
  }

  async findById(id: RoomId): Promise<Room | null> {
    return this.rooms.get(id) ?? null;
  }

  async findBySlug(slug: string): Promise<Room | null> {
    const id = this.slugs.get(slug);
    return id === undefined ? null : (this.rooms.get(id) ?? null);
  }

  async list(filter: RoomListFilter): Promise<readonly Room[]> {
    return [...this.rooms.values()]
      .filter((r) => (filter.category === undefined ? true : r.category === filter.category))
      .filter((r) => (filter.status === undefined ? true : r.status === filter.status))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(filter.offset, filter.offset + filter.limit);
  }

  async updateStatus(id: RoomId, status: RoomStatus): Promise<void> {
    const room = this.rooms.get(id);
    if (room === undefined) throw new NotFoundError('Room');
    this.rooms.set(id, Object.freeze({ ...room, status }));
  }

  // -- membership ----------------------------------------------------------

  /**
   * Idempotent for an already-present member, matching the port's contract:
   * a reconnect must refresh the existing open row rather than opening a second
   * one, or session counting and the shared-session query both break.
   */
  async recordJoin(member: Omit<RoomMember, 'leftAt'>): Promise<void> {
    const rows = this.members.get(member.roomId) ?? [];
    const open = rows.find((m) => m.userId === member.userId && m.leftAt === null);

    if (open !== undefined) {
      const index = rows.indexOf(open);
      rows[index] = Object.freeze({ ...open, role: member.role, mutedByHost: member.mutedByHost });
    } else {
      rows.push(Object.freeze({ ...member, leftAt: null }));
    }
    this.members.set(member.roomId, rows);
  }

  async recordLeave(roomId: RoomId, userId: UserId, leftAt: Date): Promise<boolean> {
    const rows = this.members.get(roomId) ?? [];
    const open = rows.find((m) => m.userId === userId && m.leftAt === null);
    // Nothing open to close: another path already handled this departure.
    if (open === undefined) return false;
    rows[rows.indexOf(open)] = Object.freeze({ ...open, leftAt });
    this.members.set(roomId, rows);
    return true;
  }

  async updateRole(roomId: RoomId, userId: UserId, role: RoomRole): Promise<void> {
    this.mutateOpenRow(roomId, userId, (row) => ({ ...row, role }));
  }

  async setMutedByHost(roomId: RoomId, userId: UserId, muted: boolean): Promise<void> {
    this.mutateOpenRow(roomId, userId, (row) => ({ ...row, mutedByHost: muted }));
  }

  async findMembership(roomId: RoomId, userId: UserId): Promise<RoomMember | null> {
    const rows = this.members.get(roomId) ?? [];
    return rows.find((m) => m.userId === userId && m.leftAt === null) ?? null;
  }

  /**
   * Interval overlap across every room both users have been in.
   *
   * An open row (leftAt === null) is treated as extending to +Infinity, i.e.
   * "still here", so two people currently in the same room qualify immediately
   * rather than only after one of them leaves.
   */
  async haveSharedRoomSession(a: UserId, b: UserId): Promise<boolean> {
    if (a === b) return false;

    for (const rows of this.members.values()) {
      const aRows = rows.filter((m) => m.userId === a);
      if (aRows.length === 0) continue;
      const bRows = rows.filter((m) => m.userId === b);
      if (bRows.length === 0) continue;

      for (const ar of aRows) {
        const aStart = ar.joinedAt.getTime();
        const aEnd = ar.leftAt?.getTime() ?? Number.POSITIVE_INFINITY;
        for (const br of bRows) {
          const bStart = br.joinedAt.getTime();
          const bEnd = br.leftAt?.getTime() ?? Number.POSITIVE_INFINITY;
          if (aStart < bEnd && bStart < aEnd) return true;
        }
      }
    }
    return false;
  }

  async listHostedBy(userId: UserId, limit: number): Promise<readonly Room[]> {
    return [...this.rooms.values()]
      .filter((r) => r.hostUserId === userId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  private mutateOpenRow(
    roomId: RoomId,
    userId: UserId,
    change: (row: RoomMember) => RoomMember,
  ): void {
    const rows = this.members.get(roomId) ?? [];
    const open = rows.find((m) => m.userId === userId && m.leftAt === null);
    if (open === undefined) throw new NotFoundError('Room membership');
    rows[rows.indexOf(open)] = Object.freeze(change(open));
    this.members.set(roomId, rows);
  }

  /** Test helper. Not part of the port. */
  clear(): void {
    this.rooms.clear();
    this.slugs.clear();
    this.members.clear();
  }
}
