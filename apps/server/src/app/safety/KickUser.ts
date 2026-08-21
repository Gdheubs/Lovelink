import type { User } from '../../domain/entities/User.js';
import type { Ports } from '../../domain/ports/index.js';
import type { RoomId, UserId } from '../../domain/values/ids.js';
import type { LeaveRoom } from '../rooms/LeaveRoom.js';
import { assertCanModerateRoom } from '../../domain/rules/trustLadder.js';
import { TRUST_DELTAS } from '../../domain/values/trust.js';
import { NotFoundError } from '../../domain/errors.js';

/**
 * USE CASE: a host removes someone from their room.
 *
 * A KICK IS ROOM-SCOPED, NOT ACCOUNT-SCOPED
 * -----------------------------------------
 * The person can still use Loverlink and can still join other rooms. That is
 * the intended power boundary: a host runs a room, a moderator runs the
 * platform. Letting hosts effectively ban people would make every room's owner
 * a moderator of the whole product, which is neither safe nor what anyone
 * signed up to do.
 *
 * The trust penalty is small for the same reason — being asked to leave one
 * room is not evidence of much on its own, but a pattern of it is, and the
 * ledger is what turns individual kicks into that pattern.
 *
 * ORDER: media first, then presence, then the announcement. Same reasoning as
 * RemoveSpeaker — a kick that records itself but fails to cut the audio would
 * tell the host they removed someone the room can still hear.
 */
export interface KickUserInput {
  readonly roomId: RoomId;
  readonly userId: UserId;
}

export class KickUser {
  constructor(
    private readonly ports: Ports,
    private readonly leaveRoom: LeaveRoom,
  ) {}

  async execute(host: User, input: KickUserInput): Promise<void> {
    const { roomId, userId } = input;

    // Host-only, re-checked from live presence — never from the payload and
    // never from what this socket believed at connect time.
    const hostMembership = await this.ports.presence.getMember(roomId, host.id);
    assertCanModerateRoom(host, hostMembership, userId, host.id);

    const target = await this.ports.presence.getMember(roomId, userId);
    if (target === null) throw new NotFoundError('That person is no longer in the room');

    // 1. Cut the audio at the media server. Best-effort: a media hiccup must
    //    not stop a host removing someone.
    await this.ports.media.revokePublish(userId, roomId).catch(() => undefined);
    await this.ports.media.removeParticipant(userId, roomId).catch(() => undefined);

    // 2. Tell the kicked user specifically, so their client can leave the
    //    screen rather than sitting in a room it has been removed from.
    await this.ports.realtime.emitToUser(userId, 'room:kicked', { roomId, userId });

    // 3. Remove them, through the SAME departure path as everything else.
    //    `kicked` earns no session credit — see LeaveRoom.
    await this.leaveRoom.execute({ userId, roomId, reason: 'kicked' });

    await this.ports.users
      .appendTrustEvent({
        userId,
        delta: TRUST_DELTAS.kicked_from_room,
        reason: 'kicked_from_room',
        context: roomId,
        createdAt: this.ports.clock.now(),
      })
      .catch(() => undefined);

    await this.ports.bus.publish('moderation', {
      type: 'user.kicked',
      userId,
      roomId,
      byUserId: host.id,
    });

    this.ports.logger.info({ roomId, userId, byHost: host.id }, 'user kicked from room');
  }
}
