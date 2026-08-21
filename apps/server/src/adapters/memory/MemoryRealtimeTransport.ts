import type {
  RealtimeTransport,
  ServerEventName,
  ServerEvents,
} from '../../domain/ports/RealtimeTransport.js';
import type { RoomId, UserId } from '../../domain/values/ids.js';

/** One recorded outbound message. */
export interface RecordedEmission {
  readonly target:
    { kind: 'room'; roomId: RoomId; exceptUserId?: UserId } | { kind: 'user'; userId: UserId };
  readonly event: ServerEventName;
  readonly payload: unknown;
}

/**
 * ADAPTER (memory): a RealtimeTransport that records instead of transmitting.
 *
 * WHY THIS IS THE MOST USEFUL FAKE IN THE REPO
 * --------------------------------------------
 * Almost every use case's observable effect is "and then the room was told".
 * Without this, testing `ApproveSpeaker` would require a socket server, two
 * connected clients, and a wait — i.e. an integration test for what is really a
 * rule. With it, the assertion is `expect(rt.emissionsTo(roomId, 'speaker:promoted'))`.
 *
 * It also enforces the architecture: if a use case ever reaches for `io.emit`
 * directly, its unit test records nothing and fails immediately.
 */
export class MemoryRealtimeTransport implements RealtimeTransport {
  readonly emissions: RecordedEmission[] = [];
  readonly disconnected: { userId: UserId; reason: string }[] = [];
  /** roomId -> set of userIds subscribed to that room's channel. */
  private readonly channels = new Map<string, Set<string>>();
  private readonly connected = new Set<string>();

  async emitToRoom<E extends ServerEventName>(
    roomId: RoomId,
    event: E,
    payload: ServerEvents[E],
  ): Promise<void> {
    this.emissions.push({ target: { kind: 'room', roomId }, event, payload });
  }

  async emitToRoomExcept<E extends ServerEventName>(
    roomId: RoomId,
    exceptUserId: UserId,
    event: E,
    payload: ServerEvents[E],
  ): Promise<void> {
    this.emissions.push({ target: { kind: 'room', roomId, exceptUserId }, event, payload });
  }

  async emitToUser<E extends ServerEventName>(
    userId: UserId,
    event: E,
    payload: ServerEvents[E],
  ): Promise<void> {
    this.emissions.push({ target: { kind: 'user', userId }, event, payload });
  }

  async disconnectUser(userId: UserId, reason: string): Promise<void> {
    this.disconnected.push({ userId, reason });
    this.connected.delete(userId);
    for (const members of this.channels.values()) members.delete(userId);
  }

  async joinRoomChannel(userId: UserId, roomId: RoomId): Promise<void> {
    let set = this.channels.get(roomId);
    if (set === undefined) {
      set = new Set();
      this.channels.set(roomId, set);
    }
    set.add(userId);
    this.connected.add(userId);
  }

  async leaveRoomChannel(userId: UserId, roomId: RoomId): Promise<void> {
    this.channels.get(roomId)?.delete(userId);
  }

  async isUserConnected(userId: UserId): Promise<boolean> {
    return this.connected.has(userId);
  }

  // -- test helpers (not part of the port) ---------------------------------

  /** Mark a user as connected without joining a room, for DM/call tests. */
  connect(userId: UserId): void {
    this.connected.add(userId);
  }

  emissionsTo(roomId: RoomId, event?: ServerEventName): RecordedEmission[] {
    return this.emissions.filter(
      (e) =>
        e.target.kind === 'room' &&
        e.target.roomId === roomId &&
        (event === undefined || e.event === event),
    );
  }

  emissionsToUser(userId: UserId, event?: ServerEventName): RecordedEmission[] {
    return this.emissions.filter(
      (e) =>
        e.target.kind === 'user' &&
        e.target.userId === userId &&
        (event === undefined || e.event === event),
    );
  }

  /** The single most recent payload for an event, typed. */
  lastPayload<E extends ServerEventName>(event: E): ServerEvents[E] | undefined {
    for (let i = this.emissions.length - 1; i >= 0; i -= 1) {
      const emission = this.emissions[i]!;
      if (emission.event === event) return emission.payload as ServerEvents[E];
    }
    return undefined;
  }

  clear(): void {
    this.emissions.length = 0;
    this.disconnected.length = 0;
    this.channels.clear();
    this.connected.clear();
  }
}
