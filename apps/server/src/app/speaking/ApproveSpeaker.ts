import type { User } from '../../domain/entities/User.js';
import type { Ports } from '../../domain/ports/index.js';
import type { RoomId, UserId } from '../../domain/values/ids.js';
import { atLeast } from '../../domain/entities/RoomMember.js';
import { assertCanPromoteToSpeaker, canPublish } from '../../domain/rules/trustLadder.js';
import { TRUST_DELTAS } from '../../domain/values/trust.js';
import { ConflictError, NotFoundError } from '../../domain/errors.js';

/**
 * USE CASE: a host grants someone the floor.
 *
 * THIS IS THE MOST SECURITY-SENSITIVE USE CASE IN THE PRODUCT.
 *
 * It is the ONLY code path that causes a publish-enabled media token to exist.
 * Everything about "listening is the default" rests on that being true, so the
 * order below is deliberate and every step matters:
 *
 *   1. the actor is the HOST — re-checked from server state, never from
 *      anything the client sent;
 *   2. the stage is not full — `maxSpeakers` is enforced HERE, not by the
 *      media server, so the rule is testable without LiveKit running;
 *   3. the target is actually in the room;
 *   4. the promotion is recorded in presence AND in the durable mirror;
 *   5. only then is a new token minted, with `canPublish` computed by the
 *      DOMAIN and passed to the adapter as a parameter.
 *
 * THE TOKEN IS NEW, NOT MODIFIED. A media token is a bearer credential and
 * cannot be edited after issue; the promoted user must reconnect with the new
 * one. That round trip is the feature — it means a client cannot grant itself
 * the microphone by flipping a local boolean, because the server would have to
 * hand it a different token, and this is the only place that happens.
 *
 * THE TOKEN GOES TO ONE PERSON. `speaker:promoted` is broadcast to the room so
 * everyone sees the new speaker, but the payload carrying the credential is
 * sent only to its owner. Broadcasting it would let anyone in the room join as
 * that user.
 */
export interface ApproveSpeakerInput {
  readonly roomId: RoomId;
  readonly userId: UserId;
}

export class ApproveSpeaker {
  constructor(private readonly ports: Ports) {}

  async execute(host: User, input: ApproveSpeakerInput): Promise<void> {
    const { roomId, userId } = input;

    const room = await this.ports.rooms.findById(roomId);
    if (room === null) throw new NotFoundError('Room');

    // 1. HOST CHECK, from live presence. Not from the socket's memory of what
    //    the role was at connect time, and certainly not from the payload.
    const hostMembership = await this.ports.presence.getMember(roomId, host.id);

    // 2. Stage capacity. The host does not count against their own cap.
    const members = await this.ports.presence.getRoomMembers(roomId);
    const speakerCount = members.filter(
      (m) => m.role === 'speaker' && m.userId !== room.hostUserId,
    ).length;

    assertCanPromoteToSpeaker(host, hostMembership, room, speakerCount);

    // 3. The target must be present. Promoting someone who left would leave a
    //    speaker slot occupied by a ghost.
    const target = await this.ports.presence.getMember(roomId, userId);
    if (target === null) {
      throw new NotFoundError('That person is no longer in the room');
    }

    // Already a speaker: nothing to do. Returning quietly rather than throwing
    // makes two hosts tapping approve on the same raised hand harmless — the
    // second is a no-op instead of an error the host cannot act on.
    if (atLeast(target.role, 'speaker')) {
      return;
    }

    const targetUser = await this.ports.users.findById(userId);
    if (targetUser === null) throw new NotFoundError('User');

    // 4. Record the promotion in BOTH stores before minting anything. If the
    //    token were issued first and the write then failed, someone would hold
    //    a publish credential the system does not know about.
    await this.ports.presence.updateRole(roomId, userId, 'speaker');
    await this.ports.rooms.updateRole(roomId, userId, 'speaker');
    // Their hand has been answered.
    await this.ports.presence.setHandRaised(roomId, userId, false);

    // 5. THE DOMAIN decides whether this person may publish. The adapter is
    //    handed the answer; it never computes one.
    const updated = await this.ports.presence.getMember(roomId, userId);
    const decision = canPublish(targetUser, updated);

    if (!decision.allowed) {
      // Should be unreachable — we just made them a speaker — but if the rule
      // and the write ever disagree, the rule wins and no token is issued.
      throw new ConflictError('That person cannot be given the floor right now.');
    }

    await this.ports.media.createRoom(roomId, { maxParticipants: room.maxSpeakers + 50 });
    const mediaToken = await this.ports.media.issueJoinToken(userId, roomId, true);

    // The credential goes ONLY to its owner.
    await this.ports.realtime.emitToUser(userId, 'speaker:promoted', {
      roomId,
      userId,
      mediaToken: {
        token: mediaToken.token,
        url: mediaToken.url,
        roomName: mediaToken.roomName,
        expiresAt: mediaToken.expiresAt.toISOString(),
      },
    });

    // The room learns there is a new speaker, without the credential.
    await this.ports.realtime.emitToRoomExcept(roomId, userId, 'speaker:promoted', {
      roomId,
      userId,
    });

    // Being trusted with the floor is a genuine signal of good standing.
    await this.ports.users
      .appendTrustEvent({
        userId,
        delta: TRUST_DELTAS.promoted_to_speaker,
        reason: 'promoted_to_speaker',
        context: roomId,
        createdAt: this.ports.clock.now(),
      })
      .catch((error: unknown) => {
        // Best-effort: a ledger hiccup must not undo a promotion the room has
        // already been told about.
        this.ports.logger.warn(
          { userId, err: String(error) },
          'could not credit speaker promotion',
        );
      });

    this.ports.metrics.increment('speaker.promoted');
    this.ports.logger.info({ roomId, userId, byHost: host.id }, 'speaker promoted');
  }
}
