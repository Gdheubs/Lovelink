/**
 * ROOM PULSE — how a room feels, according to the people in it.
 *
 * WHAT THIS IS FOR
 * ----------------
 * "24 users online" tells you nothing you wanted to know. Before walking into a
 * room full of strangers the actual question is *what is it like in there* —
 * and the only people who can answer that are the ones already inside.
 *
 * So the pulse is a vote on the ROOM, never on a person. There is no way to
 * rate anybody, no leaderboard, and no way to be rated. That constraint is the
 * feature: the moment a mechanic can be pointed at an individual it becomes a
 * popularity system, and this product does not have one.
 *
 * WHY IT DECAYS
 * -------------
 * A room's feeling at 2am is not its feeling at 8pm, and a pulse that averaged
 * the whole night would describe neither. Votes are only counted for a window,
 * after which the room is simply asked again. Nothing has to run for that to
 * happen — old votes expire where they live.
 *
 * WHY IT REFUSES TO ANSWER IN A SMALL ROOM
 * ----------------------------------------
 * This is the part most likely to be got wrong. In a room of three, "anonymous"
 * is a fiction — one vote is identifiable by elimination, and a person who
 * marked a room `heavy` should never be findable. Below a threshold the pulse
 * shows nothing at all rather than something deniable.
 *
 * The cost is real: quiet rooms, which are most of them, will often show no
 * pulse. That is the correct trade. A feature that works everywhere by leaking
 * in small rooms is worse than one that admits it cannot answer yet.
 */

export type RoomFeeling = 'calm' | 'thoughtful' | 'playful' | 'warm' | 'heavy';

export const ROOM_FEELINGS: readonly RoomFeeling[] = Object.freeze([
  'calm',
  'thoughtful',
  'playful',
  'warm',
  'heavy',
] as const);

export function isRoomFeeling(value: string): value is RoomFeeling {
  return (ROOM_FEELINGS as readonly string[]).includes(value);
}

/**
 * The words shown to a person choosing.
 *
 * Deliberately about the ROOM and not about them: "playful" describes what is
 * happening in here, where "I feel playful" would be a disclosure.
 */
export const FEELING_LABEL: Readonly<Record<RoomFeeling, string>> = Object.freeze({
  calm: 'Calm',
  thoughtful: 'Thoughtful',
  playful: 'Playful',
  warm: 'Warm',
  heavy: 'Heavy',
});

/**
 * How long a vote counts for.
 *
 * Long enough that a room does not flicker between moods, short enough that it
 * describes now rather than earlier. Forty-five minutes is roughly how long a
 * conversation keeps one character before it turns into a different one.
 */
export const PULSE_WINDOW_SECONDS = 45 * 60;

/**
 * The minimum number of voters before a pulse is shown at all.
 *
 * Five, because four is where elimination starts to work: in a room of four,
 * knowing your own vote and seeing three others leaves very little hidden. It
 * is a judgement rather than a proof, and it is deliberately on the cautious
 * side of one.
 */
export const PULSE_MIN_VOTERS = 5;

export interface PulseSlice {
  readonly feeling: RoomFeeling;
  /** Whole percent, 0-100. */
  readonly share: number;
}

export interface RoomPulse {
  /** Empty when there are too few voters to be anonymous. */
  readonly slices: readonly PulseSlice[];
  readonly voters: number;
  /**
   * True when there are votes but not enough to show safely.
   *
   * Distinct from "nobody has voted": the UI should say *"not enough people yet"*
   * rather than *"nobody has said"*, because the second is untrue and invites a
   * first vote that will still show nothing.
   */
  readonly tooFewToShow: boolean;
  /** The strongest feeling, or null when nothing is shown. */
  readonly dominant: RoomFeeling | null;
}

/**
 * Turn raw votes into what a room is allowed to display.
 *
 * PURE, and the anonymity threshold is enforced HERE rather than in the UI —
 * because a rule that protects someone must not be re-implementable by whoever
 * writes the next screen.
 */
export function summarizePulse(votes: readonly RoomFeeling[]): RoomPulse {
  const voters = votes.length;

  if (voters === 0) {
    return { slices: [], voters: 0, tooFewToShow: false, dominant: null };
  }

  if (voters < PULSE_MIN_VOTERS) {
    // The count is withheld too. "3 people have voted" in a room of four is
    // most of the way to knowing who.
    return { slices: [], voters: 0, tooFewToShow: true, dominant: null };
  }

  const counts = new Map<RoomFeeling, number>();
  for (const vote of votes) counts.set(vote, (counts.get(vote) ?? 0) + 1);

  const slices = [...counts.entries()]
    .map(([feeling, count]) => ({ feeling, share: Math.round((count / voters) * 100) }))
    .sort((a, b) => b.share - a.share || a.feeling.localeCompare(b.feeling));

  return {
    slices,
    voters,
    tooFewToShow: false,
    dominant: slices[0]?.feeling ?? null,
  };
}

/**
 * One line describing the room, or null when there is nothing safe to say.
 *
 * Prose rather than a percentage, because "the room feels quiet tonight" tells
 * someone whether to walk in and "63% calm" does not.
 */
export function describePulse(pulse: RoomPulse): string | null {
  if (pulse.dominant === null) return null;

  const strong = (pulse.slices[0]?.share ?? 0) >= 60;

  const phrases: Readonly<Record<RoomFeeling, [string, string]>> = {
    calm: ['It feels quiet in here tonight.', 'Mostly quiet, with some talk.'],
    thoughtful: ['People are being thoughtful tonight.', 'Thoughtful, and a little of everything.'],
    playful: ['It is a light-hearted room tonight.', 'Playful, mostly.'],
    warm: ['It feels warm in here.', 'Warm, with a few other things going on.'],
    heavy: [
      'People are talking about heavy things tonight.',
      'Some heavy conversation, among other things.',
    ],
  };

  return phrases[pulse.dominant][strong ? 0 : 1];
}
