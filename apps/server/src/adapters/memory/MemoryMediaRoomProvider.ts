import type { Clock } from '../../domain/ports/Clock.js';
import type {
  MediaParticipant,
  MediaRoomProvider,
  MediaToken,
} from '../../domain/ports/MediaRoomProvider.js';
import type { RoomId, UserId } from '../../domain/values/ids.js';

interface FakeParticipant {
  canPublish: boolean;
  muted: boolean;
}

/**
 * ADAPTER (memory): a media provider that issues fake tokens and tracks grants.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS
 * -----------------------------------
 * The single most important invariant in the product is "nobody publishes audio
 * without a host grant". This fake makes that invariant TESTABLE without a
 * media server: it records the `canPublish` value it was handed for every token
 * and every revocation, so a unit test can assert that JoinRoom issued a
 * listen-only token and that ApproveSpeaker issued a publishing one.
 *
 * It deliberately does NOT decide anything about publish rights itself — it
 * records what it was told, exactly as the LiveKit adapter must. If a future
 * adapter starts making that decision, the difference will show up here as a
 * test that no longer reflects reality.
 */
export class MemoryMediaRoomProvider implements MediaRoomProvider {
  private readonly rooms = new Map<string, Map<string, FakeParticipant>>();

  /** Every token ever issued, for assertions. */
  readonly issuedTokens: { userId: UserId; roomId: RoomId; canPublish: boolean }[] = [];
  readonly revocations: { userId: UserId; roomId: RoomId }[] = [];
  readonly removals: { userId: UserId; roomId: RoomId }[] = [];
  readonly closedRooms: RoomId[] = [];

  constructor(
    private readonly clock: Clock,
    private readonly url = 'ws://memory-media.local',
    private readonly ttlSeconds = 3600,
  ) {}

  private participants(roomId: RoomId): Map<string, FakeParticipant> {
    let map = this.rooms.get(roomId);
    if (map === undefined) {
      map = new Map();
      this.rooms.set(roomId, map);
    }
    return map;
  }

  async createRoom(roomId: RoomId): Promise<void> {
    this.participants(roomId);
  }

  async issueJoinToken(userId: UserId, roomId: RoomId, canPublish: boolean): Promise<MediaToken> {
    this.issuedTokens.push({ userId, roomId, canPublish });

    const map = this.participants(roomId);
    const existing = map.get(userId);
    map.set(userId, { canPublish, muted: existing?.muted ?? false });

    return {
      // Encodes the grant in the string so a test failure message is readable.
      token: `fake-token:${roomId}:${userId}:${canPublish ? 'publish' : 'listen'}`,
      url: this.url,
      roomName: roomId,
      identity: userId,
      canPublish,
      expiresAt: new Date(this.clock.nowMs() + this.ttlSeconds * 1000),
    };
  }

  async revokePublish(userId: UserId, roomId: RoomId): Promise<void> {
    this.revocations.push({ userId, roomId });
    const participant = this.participants(roomId).get(userId);
    if (participant !== undefined) participant.canPublish = false;
  }

  async muteParticipant(userId: UserId, roomId: RoomId, muted: boolean): Promise<void> {
    const participant = this.participants(roomId).get(userId);
    if (participant !== undefined) participant.muted = muted;
  }

  async removeParticipant(userId: UserId, roomId: RoomId): Promise<void> {
    this.removals.push({ userId, roomId });
    this.participants(roomId).delete(userId);
  }

  async closeRoom(roomId: RoomId): Promise<void> {
    this.closedRooms.push(roomId);
    this.rooms.delete(roomId);
  }

  async listParticipants(roomId: RoomId): Promise<readonly MediaParticipant[]> {
    const map = this.rooms.get(roomId);
    if (map === undefined) return [];
    return [...map.entries()].map(([userId, p]) => ({
      userId: userId as UserId,
      canPublish: p.canPublish,
      isSpeaking: p.canPublish && !p.muted,
    }));
  }

  // -- test helpers --------------------------------------------------------

  /** The publish grant currently held by a user, or null if not in the room. */
  grantFor(roomId: RoomId, userId: UserId): boolean | null {
    return this.rooms.get(roomId)?.get(userId)?.canPublish ?? null;
  }

  clear(): void {
    this.rooms.clear();
    this.issuedTokens.length = 0;
    this.revocations.length = 0;
    this.removals.length = 0;
    this.closedRooms.length = 0;
  }
}
