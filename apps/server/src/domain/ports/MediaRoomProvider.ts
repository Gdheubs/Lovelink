import type { RoomId, UserId } from '../values/ids.js';

/**
 * PORT: MediaRoomProvider
 *
 * WHY THIS EXISTS
 * ---------------
 * This is the port the whole architecture was designed around. Voice is the
 * most vendor-entangled part of the system and the most likely to be replaced
 * (LiveKit -> mediasoup -> Janus, or self-hosted -> managed). Everything above
 * this interface — the raise-hand flow, the speaker cap, the trust ladder —
 * must survive that swap untouched.
 *
 * THE CRITICAL INVARIANT
 * ----------------------
 * `issueJoinToken` takes `canPublish` as an EXPLICIT PARAMETER. The adapter
 * never decides who may speak; it is handed a decision that
 * rules/trustLadder.ts already made. This is what makes "everyone joins
 * listen-only" a structural property rather than a convention someone can
 * forget — an adapter that mints publish rights on its own is a bug visible in
 * one file.
 *
 * A second invariant: `revokePublish` must take effect SERVER-SIDE at the media
 * server. Telling the client to stop publishing is a request; removing the
 * grant is enforcement. A host demoting an abusive speaker cannot depend on
 * that speaker's client cooperating.
 */

/** An issued credential for one participant in one media room. */
export interface MediaToken {
  /** The signed token string the client hands to the media SDK. */
  readonly token: string;
  /** Where the client should connect. Comes from config, passed through for convenience. */
  readonly url: string;
  /** Media-server room name, which may differ from our RoomId. */
  readonly roomName: string;
  readonly identity: string;
  readonly canPublish: boolean;
  readonly expiresAt: Date;
}

export interface MediaParticipant {
  readonly userId: UserId;
  readonly canPublish: boolean;
  /** True when the participant currently has an unmuted, active audio track. */
  readonly isSpeaking: boolean;
}

export interface MediaRoomProvider {
  /**
   * Idempotently ensure a media room exists.
   * Called on first join rather than at room creation, so that scheduled rooms
   * nobody attends never consume media-server resources.
   */
  createRoom(roomId: RoomId, options?: { maxParticipants?: number }): Promise<void>;

  /**
   * Mint a join credential.
   * @param canPublish MUST come from the domain's authorization decision.
   */
  issueJoinToken(userId: UserId, roomId: RoomId, canPublish: boolean): Promise<MediaToken>;

  /**
   * Remove publish rights from a participant already in the room, server-side
   * and immediately. Used by speaker:remove, room:mute-user and ban enforcement.
   */
  revokePublish(userId: UserId, roomId: RoomId): Promise<void>;

  /** Server-side mute of a participant's existing audio track. */
  muteParticipant(userId: UserId, roomId: RoomId, muted: boolean): Promise<void>;

  /** Forcibly disconnect a participant. Used by kick and ban. */
  removeParticipant(userId: UserId, roomId: RoomId): Promise<void>;

  /** Tear the media room down when the last member leaves or the room closes. */
  closeRoom(roomId: RoomId): Promise<void>;

  /**
   * Who the media server currently believes is in the room.
   * Used to reconcile drift between our presence store and reality; never used
   * as the primary source of membership.
   */
  listParticipants(roomId: RoomId): Promise<readonly MediaParticipant[]>;
}
