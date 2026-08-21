import type { Server as SocketIOServer, Socket } from 'socket.io';
import type { Logger } from '../../domain/ports/Logger.js';
import type {
  RealtimeTransport,
  ServerEventName,
  ServerEvents,
} from '../../domain/ports/RealtimeTransport.js';
import type { RoomId, UserId } from '../../domain/values/ids.js';

/**
 * ADAPTER: RealtimeTransport over Socket.io.
 *
 * THE ROOM-NAMING SCHEME, AND WHY IT IS TWO NAMESPACES
 * ----------------------------------------------------
 * Socket.io "rooms" are just broadcast groups, so we use two kinds:
 *
 *   `room:<roomId>`  — everyone in a voice room. Backs emitToRoom.
 *   `user:<userId>`  — every connection belonging to one person, across all
 *                      their tabs and devices. Backs emitToUser and, crucially,
 *                      disconnectUser.
 *
 * The per-user group is what makes ban enforcement work. Without it, "disconnect
 * this user" means iterating every socket on every node comparing ids; with it,
 * it is one broadcast that reaches every process through the Redis adapter.
 *
 * WHY EMISSIONS ARE FIRE-AND-FORGET
 * ---------------------------------
 * The methods are `async` to satisfy the port (whose Redis-backed
 * implementations genuinely await), but Socket.io's emit is synchronous and
 * best-effort. A failed delivery must not fail the use case that triggered it:
 * a user who missed `user:joined` recovers on their next `room:state` snapshot,
 * whereas a join that threw because a broadcast failed is a broken feature.
 */
export class SocketIoTransport implements RealtimeTransport {
  /** userId -> that user's live sockets on THIS process. */
  private readonly localSockets = new Map<string, Set<Socket>>();

  constructor(
    private readonly io: SocketIOServer,
    private readonly logger: Logger,
  ) {}

  private static roomChannel(roomId: RoomId): string {
    return `room:${roomId}`;
  }

  private static userChannel(userId: UserId): string {
    return `user:${userId}`;
  }

  /** Called by the connection handler once a socket is authenticated. */
  register(userId: UserId, socket: Socket): void {
    let set = this.localSockets.get(userId);
    if (set === undefined) {
      set = new Set();
      this.localSockets.set(userId, set);
    }
    set.add(socket);
    void socket.join(SocketIoTransport.userChannel(userId));
  }

  unregister(userId: UserId, socket: Socket): void {
    const set = this.localSockets.get(userId);
    if (set === undefined) return;
    set.delete(socket);
    if (set.size === 0) this.localSockets.delete(userId);
  }

  async emitToRoom<E extends ServerEventName>(
    roomId: RoomId,
    event: E,
    payload: ServerEvents[E],
  ): Promise<void> {
    this.io.to(SocketIoTransport.roomChannel(roomId)).emit(event, payload);
  }

  async emitToRoomExcept<E extends ServerEventName>(
    roomId: RoomId,
    exceptUserId: UserId,
    event: E,
    payload: ServerEvents[E],
  ): Promise<void> {
    this.io
      .to(SocketIoTransport.roomChannel(roomId))
      .except(SocketIoTransport.userChannel(exceptUserId))
      .emit(event, payload);
  }

  async emitToUser<E extends ServerEventName>(
    userId: UserId,
    event: E,
    payload: ServerEvents[E],
  ): Promise<void> {
    this.io.to(SocketIoTransport.userChannel(userId)).emit(event, payload);
  }

  /**
   * Sever every connection this user has.
   *
   * Sends `user:banned` FIRST so the client can show a reason instead of a
   * mystery reconnect loop, then closes the underlying transport. The port's
   * invariant is that this severs rather than requests: `close: true` on
   * `disconnectSockets` does exactly that, and a banned client's cooperation is
   * not required.
   */
  async disconnectUser(userId: UserId, reason: string): Promise<void> {
    const channel = SocketIoTransport.userChannel(userId);
    this.io.to(channel).emit('user:banned', { reason, permanent: true });
    this.io.in(channel).disconnectSockets(true);
    this.localSockets.delete(userId);
    this.logger.info({ userId, reason }, 'user force-disconnected');
  }

  /**
   * Subscribe every one of the user's sockets to a room channel.
   *
   * NOTE the multi-tab behaviour: joining on one tab subscribes them all, so a
   * user with two tabs open sees the room in both. That is deliberate — the
   * alternative (per-socket subscription) means the same person appears twice in
   * presence and receives every message twice.
   */
  async joinRoomChannel(userId: UserId, roomId: RoomId): Promise<void> {
    this.io
      .in(SocketIoTransport.userChannel(userId))
      .socketsJoin(SocketIoTransport.roomChannel(roomId));
  }

  async leaveRoomChannel(userId: UserId, roomId: RoomId): Promise<void> {
    this.io
      .in(SocketIoTransport.userChannel(userId))
      .socketsLeave(SocketIoTransport.roomChannel(roomId));
  }

  /**
   * Whether the user has a live connection.
   *
   * Checks the cluster, not just this process, via the adapter's `fetchSockets`.
   * A local-only check would report "offline" for a user connected to a
   * different node, which would silently break DM and call delivery the moment
   * we run more than one instance.
   */
  async isUserConnected(userId: UserId): Promise<boolean> {
    if ((this.localSockets.get(userId)?.size ?? 0) > 0) return true;
    const sockets = await this.io.in(SocketIoTransport.userChannel(userId)).fetchSockets();
    return sockets.length > 0;
  }
}
