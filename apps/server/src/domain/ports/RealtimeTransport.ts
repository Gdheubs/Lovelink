import type { PublicProfile } from '../entities/User.js';
import type { RoomRole } from '../entities/RoomMember.js';
import type { DomainErrorCode } from '../errors.js';
import type { RoomId, UserId } from '../values/ids.js';

/**
 * PORT: RealtimeTransport
 *
 * WHY THIS EXISTS
 * ---------------
 * Use cases need to tell people that something happened. They must not know
 * that "people" means Socket.io rooms, or that a user may have three tabs open,
 * or that broadcast crosses a Redis adapter to reach another process.
 *
 * THE RULE THIS ENFORCES (architecture §4): there is no raw `io.emit` anywhere
 * outside /src/adapters/socketio. Every outbound message goes through this
 * interface, which means the complete list of things the server can say to a
 * client is the `ServerEvents` map below — greppable, typed, and reviewable in
 * one place, rather than scattered across handlers.
 *
 * INVARIANT: payload types here are the wire contract. They contain only
 * `PublicProfile`-shaped user data; if you find yourself wanting to add a field
 * that is not safe for every recipient in the room, you need a different event
 * (or `emitToUser`), not a wider payload.
 */

// ---------------------------------------------------------------------------
// Wire payloads — server -> client
// ---------------------------------------------------------------------------

export interface RoomMemberView {
  readonly user: PublicProfile;
  readonly role: RoomRole;
  readonly mutedByHost: boolean;
  readonly handRaised: boolean;
}

export interface ChatMessageView {
  readonly id: string;
  readonly roomId: RoomId | null;
  readonly from: PublicProfile;
  readonly text: string;
  readonly sentAt: string;
}

/**
 * The full snapshot sent on join and on reconnect.
 *
 * WHY A SNAPSHOT: incremental events are lossy across a mobile network drop.
 * Rather than trying to replay a delta log, a reconnecting client throws its
 * state away and takes a fresh picture. This is the difference between
 * "presence is occasionally wrong" and "presence is correct".
 */
export interface RoomStateView {
  readonly roomId: RoomId;
  readonly title: string;
  readonly category: string;
  readonly hostUserId: UserId;
  readonly maxSpeakers: number;
  readonly members: readonly RoomMemberView[];
  readonly raisedHands: readonly UserId[];
  /** Short tail of recent chat so a reconnecting user is not staring at a blank room. */
  readonly recentMessages: readonly ChatMessageView[];
  /** Present only in the snapshot sent to the joining user, never broadcast. */
  readonly selfRole: RoomRole;

  /**
   * A media credential for THIS user, so they can hear the room.
   *
   * Issued on every join and re-join, which also means a token that expired
   * while the client was away is replaced without a separate request.
   *
   * INVARIANT: for a listener this token carries canPublish=false. A
   * publish-enabled token is minted ONLY by ApproveSpeaker and delivered by
   * the `speaker:promoted` event — there is no path through join that grants
   * audio.
   *
   * It appears here rather than as its own event because the `room:state`
   * snapshot is sent
   * to the joining user alone, and the event catalogue (architecture §4) is
   * closed: adding a credential-fetch event would widen the surface for no
   * gain. Absent when the media provider is unavailable, so a text-only client
   * still joins successfully.
   */
  readonly mediaToken?: {
    readonly token: string;
    readonly url: string;
    readonly roomName: string;
    readonly canPublish: boolean;
    readonly expiresAt: string;
  };
}

export interface ServerEvents {
  'room:state': RoomStateView;
  'user:joined': { roomId: RoomId; member: RoomMemberView };
  'user:left': { roomId: RoomId; userId: UserId };
  'chat:message': ChatMessageView;
  'chat:typing': { roomId: RoomId; userId: UserId };
  'reaction:shown': { roomId: RoomId; userId: UserId; reaction: string };
  'hand:raised': { roomId: RoomId; userId: UserId; raised: boolean };
  /**
   * Carries a FRESH publish-enabled media token. The client cannot mint this
   * for itself, which is what makes host approval meaningful.
   */
  'speaker:promoted': {
    roomId: RoomId;
    userId: UserId;
    mediaToken?: { token: string; url: string; roomName: string; expiresAt: string };
  };
  'speaker:demoted': { roomId: RoomId; userId: UserId; reason: 'host' | 'left' | 'banned' };
  'room:muted': { roomId: RoomId; userId: UserId; muted: boolean };
  'room:kicked': { roomId: RoomId; userId: UserId };
  'dm:requested': { fromUserId: UserId; from: PublicProfile };
  'dm:opened': { withUserId: UserId; with: PublicProfile };
  'dm:message': ChatMessageView;
  'call:incoming': { fromUserId: UserId; from: PublicProfile; callRoomId: RoomId };
  'call:accepted': {
    withUserId: UserId;
    callRoomId: RoomId;
    mediaToken: { token: string; url: string; roomName: string; expiresAt: string };
  };
  'call:declined': { withUserId: UserId };
  'surprise:received': { surpriseId: string; from: string };
  'user:banned': { reason: string; permanent: boolean };
  error: { code: DomainErrorCode; message: string };
}

export type ServerEventName = keyof ServerEvents;

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

export interface RealtimeTransport {
  /** Broadcast to everyone currently subscribed to a room. */
  emitToRoom<E extends ServerEventName>(
    roomId: RoomId,
    event: E,
    payload: ServerEvents[E],
  ): Promise<void>;

  /**
   * Broadcast to a room EXCEPT one user.
   * Exists because "someone joined" should not be echoed to the joiner, who is
   * already receiving the authoritative `room:state` snapshot.
   */
  emitToRoomExcept<E extends ServerEventName>(
    roomId: RoomId,
    exceptUserId: UserId,
    event: E,
    payload: ServerEvents[E],
  ): Promise<void>;

  /** Deliver to every live connection belonging to one user (all their tabs). */
  emitToUser<E extends ServerEventName>(
    userId: UserId,
    event: E,
    payload: ServerEvents[E],
  ): Promise<void>;

  /**
   * Force-close every connection for a user.
   *
   * INVARIANT: this must sever the socket, not merely emit a message asking the
   * client to leave. It is the enforcement half of a ban, and a banned client
   * has no reason to cooperate.
   */
  disconnectUser(userId: UserId, reason: string): Promise<void>;

  /** Subscribe/unsubscribe a user's connections to a room's broadcast group. */
  joinRoomChannel(userId: UserId, roomId: RoomId): Promise<void>;
  leaveRoomChannel(userId: UserId, roomId: RoomId): Promise<void>;

  /** True when the user has at least one live connection to this process. */
  isUserConnected(userId: UserId): Promise<boolean>;
}
