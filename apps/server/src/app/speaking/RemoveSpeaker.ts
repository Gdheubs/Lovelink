import type { User } from '../../domain/entities/User.js';
import type { Ports } from '../../domain/ports/index.js';
import type { RoomId, UserId } from '../../domain/values/ids.js';
import { assertCanModerateRoom } from '../../domain/rules/trustLadder.js';
import { NotFoundError } from '../../domain/errors.js';

/**
 * USE CASE: take the floor back.
 *
 * THE ORDER IS THE OPPOSITE OF PROMOTION, AND THAT IS THE POINT
 * ------------------------------------------------------------
 * Promotion records the grant, then issues the credential. Demotion REVOKES AT
 * THE MEDIA SERVER FIRST, then records it.
 *
 * The reason is what each ordering risks if it fails halfway. A promotion that
 * dies after the write leaves someone recorded as a speaker who cannot speak —
 * annoying, self-correcting on rejoin. A demotion that dies after the write
 * would leave someone recorded as a listener WHO IS STILL AUDIBLE. That is a
 * host trying to silence an abusive speaker and being told it worked while the
 * room can still hear them.
 *
 * So the audible-ness goes first, every time.
 *
 * WHY REVOCATION IS NOT "SEND THEM A MESSAGE"
 * -------------------------------------------
 * `revokePublish` changes the grant at the media server for the live session.
 * Asking the client to stop publishing is a request an abusive participant can
 * simply ignore. This is the difference between moderation and a suggestion.
 */
export interface RemoveSpeakerInput {
  readonly roomId: RoomId;
  readonly userId: UserId;
}

export class RemoveSpeaker {
  constructor(private readonly ports: Ports) {}

  async execute(host: User, input: RemoveSpeakerInput): Promise<void> {
    const { roomId, userId } = input;

    const hostMembership = await this.ports.presence.getMember(roomId, host.id);
    assertCanModerateRoom(host, hostMembership, userId, host.id);

    const target = await this.ports.presence.getMember(roomId, userId);
    if (target === null) throw new NotFoundError('That person is no longer in the room');

    // Already a listener — nothing to revoke. Quiet no-op so that two hosts
    // tapping at once is harmless.
    if (target.role === 'listener') return;

    // 1. SILENCE THEM FIRST, at the media server. Everything after this is
    //    bookkeeping; this is the part that actually stops the audio.
    await this.ports.media.revokePublish(userId, roomId);

    // 2. Then record it.
    await this.ports.presence.updateRole(roomId, userId, 'listener');
    await this.ports.rooms.updateRole(roomId, userId, 'listener');

    // 3. Then tell everyone, including the demoted user — their client needs
    //    to drop its publishing state and stop showing a live microphone.
    await this.ports.realtime.emitToRoom(roomId, 'speaker:demoted', {
      roomId,
      userId,
      reason: 'host',
    });

    this.ports.logger.info({ roomId, userId, byHost: host.id }, 'speaker removed');
  }
}

/**
 * USE CASE: a speaker steps down voluntarily.
 *
 * Separate from RemoveSpeaker because the authorization is completely
 * different — this needs no host, only the speaker themselves — and folding
 * them together would mean one function whose permission check depends on
 * comparing the actor to the target. That is exactly the kind of branch that
 * later grows a bug.
 */
export class StepDownAsSpeaker {
  constructor(private readonly ports: Ports) {}

  async execute(user: User, roomId: RoomId): Promise<void> {
    const membership = await this.ports.presence.getMember(roomId, user.id);
    if (membership === null) throw new NotFoundError('Room membership');

    // A host stepping down would leave the room unmoderated, so they keep the
    // role. Handing the room to someone else is a different action.
    if (membership.role !== 'speaker') return;

    await this.ports.media.revokePublish(user.id, roomId);
    await this.ports.presence.updateRole(roomId, user.id, 'listener');
    await this.ports.rooms.updateRole(roomId, user.id, 'listener');

    await this.ports.realtime.emitToRoom(roomId, 'speaker:demoted', {
      roomId,
      userId: user.id,
      reason: 'left',
    });

    this.ports.logger.info({ roomId, userId: user.id }, 'speaker stepped down');
  }
}
