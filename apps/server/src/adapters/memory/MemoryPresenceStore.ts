import type { RoomRole } from '../../domain/entities/RoomMember.js';
import type { Clock } from '../../domain/ports/Clock.js';
import type { PresenceEntry, PresenceStore } from '../../domain/ports/PresenceStore.js';
import type { RoomId, UserId } from '../../domain/values/ids.js';

/**
 * ADAPTER (memory): PresenceStore with real TTL semantics.
 *
 * WHY IT BOTHERS WITH TTLs
 * ------------------------
 * It would be easy to write a Map-backed presence store where entries live
 * forever — and it would be useless, because the entire difficulty of presence
 * is expiry. Ghost cleanup is the behaviour most likely to be wrong, so the
 * fake models it faithfully: entries carry `lastSeenMs`, reads filter out the
 * lapsed, and `reapExpired` returns what it removed so the caller can emit the
 * `user:left` events those clients never sent.
 *
 * Expiry is evaluated against the injected Clock, so a test can prove the
 * reaper works by advancing time instead of sleeping.
 */
export class MemoryPresenceStore implements PresenceStore {
  /** roomId -> userId -> entry */
  private readonly rooms = new Map<string, Map<string, PresenceEntry>>();

  constructor(
    private readonly clock: Clock,
    private readonly ttlSeconds: number,
  ) {}

  private get ttlMs(): number {
    return this.ttlSeconds * 1000;
  }

  private isLive(entry: PresenceEntry): boolean {
    return this.clock.nowMs() - entry.lastSeenMs < this.ttlMs;
  }

  private roomMap(roomId: RoomId): Map<string, PresenceEntry> {
    let map = this.rooms.get(roomId);
    if (map === undefined) {
      map = new Map();
      this.rooms.set(roomId, map);
    }
    return map;
  }

  async setOnline(entry: Omit<PresenceEntry, 'lastSeenMs' | 'handRaisedAtMs'>): Promise<boolean> {
    // --- atomic section: no await between the read and the write ---
    const map = this.roomMap(entry.roomId);
    const existing = map.get(entry.userId);
    const wasPresent = existing !== undefined && this.isLive(existing);

    map.set(entry.userId, {
      ...entry,
      lastSeenMs: this.clock.nowMs(),
      // Re-joining does not silently keep a stale raised hand from a previous
      // session, but a heartbeat-refreshed rejoin within the same session does.
      handRaisedAtMs: wasPresent ? (existing?.handRaisedAtMs ?? null) : null,
    });
    // --- end atomic section ---

    return !wasPresent;
  }

  async setOffline(roomId: RoomId, userId: UserId): Promise<void> {
    this.rooms.get(roomId)?.delete(userId);
  }

  async heartbeat(roomId: RoomId, userId: UserId): Promise<boolean> {
    const map = this.rooms.get(roomId);
    const entry = map?.get(userId);
    if (entry === undefined || !this.isLive(entry)) {
      // Already lapsed. Telling the caller false makes them re-join rather than
      // resurrecting a session the rest of the room believes has ended.
      return false;
    }
    map!.set(userId, { ...entry, lastSeenMs: this.clock.nowMs() });
    return true;
  }

  async getRoomMembers(roomId: RoomId): Promise<readonly PresenceEntry[]> {
    const map = this.rooms.get(roomId);
    if (map === undefined) return [];
    return [...map.values()].filter((e) => this.isLive(e));
  }

  async getMember(roomId: RoomId, userId: UserId): Promise<PresenceEntry | null> {
    const entry = this.rooms.get(roomId)?.get(userId);
    return entry !== undefined && this.isLive(entry) ? entry : null;
  }

  async countRoomMembers(roomId: RoomId): Promise<number> {
    return (await this.getRoomMembers(roomId)).length;
  }

  async getRoomsForUser(userId: UserId): Promise<readonly RoomId[]> {
    const out: RoomId[] = [];
    for (const [roomId, map] of this.rooms) {
      const entry = map.get(userId);
      if (entry !== undefined && this.isLive(entry)) out.push(roomId as RoomId);
    }
    return out;
  }

  async updateRole(roomId: RoomId, userId: UserId, role: RoomRole): Promise<void> {
    this.patch(roomId, userId, (e) => ({ ...e, role }));
  }

  async setMutedByHost(roomId: RoomId, userId: UserId, muted: boolean): Promise<void> {
    this.patch(roomId, userId, (e) => ({ ...e, mutedByHost: muted }));
  }

  async setHandRaised(roomId: RoomId, userId: UserId, raised: boolean): Promise<void> {
    this.patch(roomId, userId, (e) => ({
      ...e,
      // Timestamped so the host's queue is ordered by who raised first, which
      // is the only ordering that feels fair to the people waiting.
      handRaisedAtMs: raised ? (e.handRaisedAtMs ?? this.clock.nowMs()) : null,
    }));
  }

  async getRaisedHands(roomId: RoomId): Promise<readonly PresenceEntry[]> {
    const members = await this.getRoomMembers(roomId);
    return members
      .filter((e) => e.handRaisedAtMs !== null)
      .sort((a, b) => (a.handRaisedAtMs ?? 0) - (b.handRaisedAtMs ?? 0));
  }

  async reapExpired(): Promise<readonly PresenceEntry[]> {
    const reaped: PresenceEntry[] = [];
    for (const [roomId, map] of this.rooms) {
      for (const [userId, entry] of map) {
        if (!this.isLive(entry)) {
          map.delete(userId);
          reaped.push(entry);
        }
      }
      if (map.size === 0) this.rooms.delete(roomId);
    }
    return reaped;
  }

  private patch(roomId: RoomId, userId: UserId, change: (e: PresenceEntry) => PresenceEntry): void {
    const map = this.rooms.get(roomId);
    const entry = map?.get(userId);
    // Silently ignoring an absent member is deliberate: presence mutations race
    // with departures constantly, and throwing would turn every normal leave
    // into an error in the logs.
    if (entry === undefined) return;
    map!.set(userId, change(entry));
  }

  /** Test helper. Not part of the port. */
  clear(): void {
    this.rooms.clear();
  }
}
