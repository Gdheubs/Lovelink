import type { User } from '../../domain/entities/User.js';
import type { Ports } from '../../domain/ports/index.js';
import type { RoomId, UserId } from '../../domain/values/ids.js';
import { assertCanModerateRoom } from '../../domain/rules/trustLadder.js';
import { NotFoundError } from '../../domain/errors.js';

/**
 * USE CASE: a host mutes or unmutes someone.
 *
 * MUTE vs REMOVE-SPEAKER — why both exist
 * ---------------------------------------
 * `RemoveSpeaker` takes the floor away entirely: the person becomes a listener
 * and has to be re-approved. `MuteSpeaker` is the gentler, reversible action —
 * they keep their place on the stage, they simply cannot be heard right now.
 *
 * In practice a host reaches for mute when someone's dog is barking and for
 * remove when someone is being abusive. Collapsing them into one action would
 * force the first case to carry the social weight of the second.
 *
 * A HOST MUTE SILENCES TEXT TOO. That is enforced by the domain rule
 * `canSendRoomMessage`, not here — but it is the reason this action is not
 * merely cosmetic. Muting someone who then floods the room with chat and
 * reactions would make the button feel useless, so a mute silences the person,
 * not just the microphone.
 *
 * ORDER: the media server first, exactly as in RemoveSpeaker. A mute that
 * records itself and then fails to reach the media server would tell the host
 * they succeeded while the room can still hear the person.
 */
export interface MuteSpeakerInput {
  readonly roomId: RoomId;
  readonly userId: UserId;
  readonly muted: boolean;
}

export class MuteSpeaker {
  constructor(private readonly ports: Ports) {}

  async execute(host: User, input: MuteSpeakerInput): Promise<void> {
    const { roomId, userId, muted } = input;

    // Host-only, re-checked from live presence. Never from the payload, and
    // never from what the socket believed at connect time.
    const hostMembership = await this.ports.presence.getMember(roomId, host.id);
    assertCanModerateRoom(host, hostMembership, userId, host.id);

    const target = await this.ports.presence.getMember(roomId, userId);
    if (target === null) throw new NotFoundError('That person is no longer in the room');

    // 1. The media server, first — this is the part that actually stops audio.
    //    Best-effort for a LISTENER, who has no audio track to mute anyway.
    if (target.role !== 'listener') {
      await this.ports.media.muteParticipant(userId, roomId, muted);
    }

    // 2. Record it in both stores. This is what makes the mute survive a
    //    reconnect — otherwise a muted user could clear it by rejoining.
    await this.ports.presence.setMutedByHost(roomId, userId, muted);
    await this.ports.rooms.setMutedByHost(roomId, userId, muted);

    // 3. Tell the room. Everyone sees the muted badge; the muted person's own
    //    client needs it to stop showing a live microphone.
    await this.ports.realtime.emitToRoom(roomId, 'room:muted', { roomId, userId, muted });

    this.ports.logger.info({ roomId, userId, muted, byHost: host.id }, 'host mute changed');
  }
}
