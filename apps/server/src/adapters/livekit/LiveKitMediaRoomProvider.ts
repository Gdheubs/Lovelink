import { AccessToken, RoomServiceClient, type VideoGrant } from 'livekit-server-sdk';
import type { Clock } from '../../domain/ports/Clock.js';
import type { Logger } from '../../domain/ports/Logger.js';
import type {
  MediaParticipant,
  MediaRoomProvider,
  MediaToken,
} from '../../domain/ports/MediaRoomProvider.js';
import type { RoomId, UserId } from '../../domain/values/ids.js';
import { asUserId } from '../../domain/values/ids.js';

/**
 * ADAPTER: MediaRoomProvider over LiveKit.
 *
 * THE ONE INVARIANT THIS FILE EXISTS TO PRESERVE
 * ----------------------------------------------
 * `canPublish` ARRIVES AS A PARAMETER. Nothing in this file decides who may
 * speak — that decision was made by `rules/trustLadder.ts` and enforced by
 * `ApproveSpeaker`. This adapter's only job is to encode a decision it was
 * handed into a signed token.
 *
 * That separation is what makes "everyone joins listen-only" a structural
 * property rather than a convention. If this file ever grows an `if` about
 * roles, the guarantee is gone and no test above it would notice.
 *
 * WHY REVOCATION IS SERVER-SIDE
 * -----------------------------
 * A LiveKit token is a bearer credential: once issued, it is valid until it
 * expires, and the holder can reconnect with it. So `revokePublish` does NOT
 * merely mint a new listener token — it calls `updateParticipant` on the room
 * service, which changes the grant AT THE MEDIA SERVER for the live session.
 *
 * The distinction matters enormously for moderation. Telling a client "you are
 * no longer a speaker" is a request an abusive participant can decline by
 * ignoring it; changing the server-side grant is enforcement. A host who
 * silences someone must actually silence them, not hide them in the UI.
 *
 * TOKEN LIFETIME
 * --------------
 * Deliberately short (config: LIVEKIT_TOKEN_TTL_SECONDS, default 1h). A token
 * is re-issued on promotion anyway, and a shorter window bounds how long a
 * leaked one is useful. It must comfortably exceed a realistic room session,
 * because a token expiring mid-conversation drops the participant.
 */

export interface LiveKitOptions {
  /** Browser-facing websocket URL, e.g. wss://media.example.com. */
  readonly url: string;
  /** HTTP(S) URL of the LiveKit server API. Derived from `url` when absent. */
  readonly apiUrl?: string;
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly tokenTtlSeconds: number;
}

export class LiveKitMediaRoomProvider implements MediaRoomProvider {
  private readonly rooms: RoomServiceClient;
  private readonly log: Logger;

  constructor(
    private readonly options: LiveKitOptions,
    private readonly clock: Clock,
    logger: Logger,
  ) {
    this.log = logger.child({ component: 'livekit' });

    // The server API speaks HTTP even though clients connect over websockets.
    // Deriving it from the client URL keeps deployments to one setting.
    const apiUrl = options.apiUrl ?? options.url.replace(/^ws/, 'http');
    this.rooms = new RoomServiceClient(apiUrl, options.apiKey, options.apiSecret);
  }

  /**
   * The media room's name.
   *
   * Our RoomId maps 1:1 onto it, so a participant's media room is always
   * derivable without a lookup. Prefixed so that a shared LiveKit deployment
   * cannot collide with another application's rooms.
   */
  private static roomName(roomId: RoomId): string {
    return `loverlink-${roomId}`;
  }

  async createRoom(roomId: RoomId, options: { maxParticipants?: number } = {}): Promise<void> {
    try {
      await this.rooms.createRoom({
        name: LiveKitMediaRoomProvider.roomName(roomId),
        // Tear the room down shortly after the last person leaves, rather than
        // holding server resources for a conversation that ended.
        emptyTimeout: 120,
        ...(options.maxParticipants === undefined
          ? {}
          : { maxParticipants: options.maxParticipants }),
      });
    } catch (error) {
      // Idempotent by contract: LiveKit rejects a duplicate name, and "it
      // already exists" is the outcome we wanted. Anything else is real.
      if (isAlreadyExists(error)) return;
      throw error;
    }
  }

  async issueJoinToken(userId: UserId, roomId: RoomId, canPublish: boolean): Promise<MediaToken> {
    const roomName = LiveKitMediaRoomProvider.roomName(roomId);
    const expiresAt = new Date(this.clock.nowMs() + this.options.tokenTtlSeconds * 1000);

    const grant: VideoGrant = {
      room: roomName,
      roomJoin: true,
      // THE DECISION, PASSED THROUGH. Never computed here.
      canPublish,
      canSubscribe: true,
      // Data channels are not part of the product — chat goes over our own
      // socket, where it is validated, rate-limited and moderated. Allowing
      // LiveKit data messages would open a second, unmoderated text channel.
      canPublishData: false,
    };

    const token = new AccessToken(this.options.apiKey, this.options.apiSecret, {
      identity: userId,
      ttl: this.options.tokenTtlSeconds,
    });
    token.addGrant(grant);

    return {
      token: await token.toJwt(),
      url: this.options.url,
      roomName,
      identity: userId,
      canPublish,
      expiresAt,
    };
  }

  /**
   * Remove publish rights from a LIVE participant.
   *
   * This is enforcement, not a request: the grant changes at the media server,
   * so the participant's existing connection can no longer send audio even if
   * their client ignores every instruction we give it.
   */
  async revokePublish(userId: UserId, roomId: RoomId): Promise<void> {
    await this.updateGrant(userId, roomId, false);
  }

  async muteParticipant(userId: UserId, roomId: RoomId, muted: boolean): Promise<void> {
    const roomName = LiveKitMediaRoomProvider.roomName(roomId);

    try {
      const participant = await this.rooms.getParticipant(roomName, userId);

      // Mute every audio track they have. Iterating rather than assuming one
      // track: a client may publish more than one, and muting only the first
      // would leave them audible.
      for (const track of participant.tracks) {
        if (track.type === 0 /* AUDIO */) {
          await this.rooms.mutePublishedTrack(roomName, userId, track.sid, muted);
        }
      }
    } catch (error) {
      // A participant who has already left is not an error worth failing a
      // moderation action for — the outcome the host wanted is already true.
      if (isNotFound(error)) {
        this.log.debug({ userId, roomId }, 'mute skipped: participant not in the media room');
        return;
      }
      throw error;
    }
  }

  async removeParticipant(userId: UserId, roomId: RoomId): Promise<void> {
    try {
      await this.rooms.removeParticipant(LiveKitMediaRoomProvider.roomName(roomId), userId);
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
  }

  async closeRoom(roomId: RoomId): Promise<void> {
    try {
      await this.rooms.deleteRoom(LiveKitMediaRoomProvider.roomName(roomId));
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
  }

  async listParticipants(roomId: RoomId): Promise<readonly MediaParticipant[]> {
    try {
      const participants = await this.rooms.listParticipants(
        LiveKitMediaRoomProvider.roomName(roomId),
      );

      return participants.map((participant) => ({
        userId: asUserId(participant.identity),
        canPublish: participant.permission?.canPublish ?? false,
        // "Speaking" here means has a live, unmuted audio track — the media
        // server's own view, used only to reconcile drift with our presence
        // store, never as the primary source of membership.
        isSpeaking: participant.tracks.some((track) => track.type === 0 && !track.muted),
      }));
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  /** Change a live participant's publish permission at the media server. */
  private async updateGrant(userId: UserId, roomId: RoomId, canPublish: boolean): Promise<void> {
    const roomName = LiveKitMediaRoomProvider.roomName(roomId);

    try {
      await this.rooms.updateParticipant(roomName, userId, undefined, {
        canPublish,
        canSubscribe: true,
        canPublishData: false,
      });
      this.log.info({ userId, roomId, canPublish }, 'updated media publish grant');
    } catch (error) {
      if (isNotFound(error)) {
        // Not connected to the media room. The next token they are issued
        // carries the correct grant, so there is nothing to repair.
        this.log.debug({ userId, roomId }, 'grant update skipped: participant not connected');
        return;
      }
      throw error;
    }
  }
}

/**
 * LiveKit surfaces API failures as errors carrying a status or a message.
 * Matching on both is defensive: the SDK's error shape has changed between
 * versions, and a moderation action must not fail because an error was reported
 * slightly differently.
 */
function isNotFound(error: unknown): boolean {
  return matchesError(error, 404, /not.?found|does not exist/i);
}

function isAlreadyExists(error: unknown): boolean {
  return matchesError(error, 409, /already exists|duplicate/i);
}

function matchesError(error: unknown, status: number, pattern: RegExp): boolean {
  if (typeof error !== 'object' || error === null) return false;

  const candidate = error as { status?: unknown; code?: unknown; message?: unknown };
  if (candidate.status === status || candidate.code === status) return true;

  return typeof candidate.message === 'string' && pattern.test(candidate.message);
}
