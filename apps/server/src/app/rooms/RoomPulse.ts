import type { User } from '../../domain/entities/User.js';
import type { Ports } from '../../domain/ports/index.js';
import type { RoomId } from '../../domain/values/ids.js';
import type { RoomPulse as PulseView } from '../../domain/values/roomFeeling.js';
import {
  describePulse,
  isRoomFeeling,
  PULSE_WINDOW_SECONDS,
  summarizePulse,
} from '../../domain/values/roomFeeling.js';
import { AuthorizationError, ValidationError } from '../../domain/errors.js';

/**
 * USE CASE: say how the room feels.
 *
 * WHY ONLY SOMEONE IN THE ROOM MAY VOTE
 * -------------------------------------
 * Obvious, and worth stating because the check is easy to leave out and its
 * absence is invisible. Without it anyone could set any room's mood from
 * outside — and a room advertised on the home screen as `calm` when it is not
 * is worse than a room with no description, because someone walked in on the
 * strength of it.
 *
 * Membership comes from LIVE PRESENCE rather than the durable mirror: someone
 * who left an hour ago still has a membership row, and they no longer know what
 * this room feels like.
 *
 * WHY THERE IS NO RATE LIMIT
 * --------------------------
 * There is nothing to flood. A vote overwrites that person's previous one, so a
 * thousand requests produce one vote — the structure enforces it rather than a
 * counter. The only cost is the write itself, which the room-scoped membership
 * check already gates.
 */
export interface VoteOnRoomInput {
  readonly roomId: RoomId;
  readonly feeling: string;
}

export class VoteOnRoomFeeling {
  constructor(private readonly ports: Ports) {}

  async execute(voter: User, input: VoteOnRoomInput): Promise<void> {
    if (!isRoomFeeling(input.feeling)) {
      throw new ValidationError('That is not one of the ways a room can feel.');
    }

    const membership = await this.ports.presence.getMember(input.roomId, voter.id);
    if (membership === null) {
      // Not "you are not allowed" — they genuinely are not there. Same message
      // either way, because whether a room exists is not something to confirm
      // to someone outside it.
      throw new AuthorizationError('You are not in this room.', 'FORBIDDEN');
    }

    await this.ports.pulse.vote(input.roomId, voter.id, input.feeling, PULSE_WINDOW_SECONDS);
  }
}

export interface RoomPulseView {
  /** One line about the room, or null when there is nothing safe to say. */
  readonly description: string | null;
  /** Present only above the anonymity threshold; otherwise empty. */
  readonly slices: PulseView['slices'];
  /** True when people have voted but too few to show. */
  readonly tooFewToShow: boolean;
  /** What this person said, so the UI can show their own choice selected. */
  readonly yours: string | null;
}

/**
 * USE CASE: read the pulse.
 *
 * WHY IT RETURNS `yours` AT ALL
 * -----------------------------
 * Because a control that forgets what you chose reads as broken, and it is
 * forgotten on every reload unless the server says.
 *
 * The anonymity model is not "the server cannot look up a vote" — it is that
 * NOTHING EVER PASSES AN ID IT DID NOT AUTHENTICATE. This is the only place
 * `voteOf` is called, and it is called with `viewer.id`. Every other question
 * about who voted has no code path to ask it from.
 */
export class GetRoomPulse {
  constructor(private readonly ports: Ports) {}

  async execute(viewer: User, roomId: RoomId): Promise<RoomPulseView> {
    const membership = await this.ports.presence.getMember(roomId, viewer.id);
    if (membership === null) {
      // The pulse is for people inside. Someone browsing the room list gets
      // occupancy and the room's stated contract, which is enough to decide
      // whether to walk in — and a mood reported by strangers to strangers
      // would be a rating.
      throw new AuthorizationError('You are not in this room.', 'FORBIDDEN');
    }

    const [votes, yours] = await Promise.all([
      this.ports.pulse.currentVotes(roomId),
      // `viewer.id`, and nothing else, ever.
      this.ports.pulse.voteOf(roomId, viewer.id),
    ]);

    const summary = summarizePulse(votes);

    return {
      description: describePulse(summary),
      slices: summary.slices,
      tooFewToShow: summary.tooFewToShow,
      yours,
    };
  }
}
