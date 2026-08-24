/**
 * WAITING TO SPEAK.
 *
 * WHAT SOMEONE WAITING IS TOLD, AND WHAT THEY ARE NOT
 * ---------------------------------------------------
 * They are told their POSITION and a rough wait. They are not shown the queue.
 *
 * The full list — *Rahul, Maya, you, Alex* — turns waiting into a scoreboard.
 * It invites the person to think about who is ahead of them, how long those
 * people have been waiting, and whether they deserve to be there, which is a
 * lot of social calculation to hand somebody whose actual question was "is it
 * nearly my turn". It also exposes other people's intentions to an audience
 * that has no use for them.
 *
 * Position plus an estimate answers the real question and nothing else.
 *
 * WHY THE ESTIMATE IS DELIBERATELY VAGUE
 * --------------------------------------
 * "~2 min", never "1m 43s".
 *
 * A precise countdown turns a room into a queueing system — the kind with a
 * ticket dispenser — and people watch it instead of listening. It would also be
 * a lie: nothing here knows how long anyone will talk for, so a number to the
 * second would be false precision dressed up as competence.
 *
 * The buckets below are coarse on purpose. Being wrong by a minute inside "a
 * few minutes" costs nothing; being wrong by a minute against "1m 43s" is the
 * app visibly failing at something it claimed to know.
 */

export type SpeakingState = 'listening' | 'waiting' | 'next' | 'speaking';

/**
 * How long one turn tends to last.
 *
 * A GUESS, and the only guess in here. There is no history to learn from yet,
 * and inventing a model on no data would be worse than a stated assumption —
 * at least this one can be read, argued with, and replaced by a measurement
 * later.
 *
 * Three minutes is roughly how long someone talks before a conversation moves
 * on. It is used only to choose a coarse bucket, so being wrong by half is
 * usually invisible.
 */
const TYPICAL_TURN_MINUTES = 3;

export interface QueueStanding {
  readonly state: SpeakingState;
  /** 1-based, and null unless waiting. */
  readonly position: number | null;
  /** Coarse, human wait. Null when not waiting or when about to be next. */
  readonly wait: string | null;
}

/**
 * Where this person stands.
 *
 * `raisedHands` must arrive OLDEST FIRST — the presence store already orders it
 * that way, because the queue is the order hands went up and nothing else. No
 * priority, no trust weighting, no jumping: the only fair ordering in a room
 * where everyone can see each other's intentions is the one nobody can argue
 * with.
 */
export function standingFor(input: {
  readonly userId: string;
  readonly isSpeaker: boolean;
  /** Oldest first. */
  readonly raisedHands: readonly string[];
  readonly maxSpeakers: number;
  readonly currentSpeakers: number;
}): QueueStanding {
  if (input.isSpeaker) {
    return { state: 'speaking', position: null, wait: null };
  }

  const index = input.raisedHands.indexOf(input.userId);
  if (index < 0) {
    return { state: 'listening', position: null, wait: null };
  }

  const position = index + 1;

  /*
   * "Next" means there is a slot free and they are at the front — so the only
   * thing between them and speaking is the host noticing.
   *
   * Distinguishing it matters because the two states feel completely different
   * to the person: "#1 in line" is still waiting, and "you're next" is a
   * reason to get ready.
   */
  const freeSlots = Math.max(0, input.maxSpeakers - input.currentSpeakers);

  if (position <= freeSlots) {
    return { state: 'next', position, wait: null };
  }

  return {
    state: 'waiting',
    position,
    wait: estimateWait(position, freeSlots, input.maxSpeakers),
  };
}

/**
 * A coarse, honest wait.
 *
 * The arithmetic is deliberately simple: how many turns have to finish before a
 * slot reaches you, times how long a turn tends to take. Then it is rounded
 * into a bucket, because the buckets are the actual output — the number is
 * scaffolding.
 */
export function estimateWait(
  position: number,
  freeSlots: number,
  maxSpeakers: number,
): string {
  // People ahead who still need a slot to come free.
  const ahead = Math.max(0, position - freeSlots);

  // Slots turn over in parallel, so a room with four speakers clears its queue
  // roughly four times faster than one with a single speaker.
  const turnsAhead = Math.ceil(ahead / Math.max(1, maxSpeakers));
  const minutes = turnsAhead * TYPICAL_TURN_MINUTES;

  if (minutes <= 1) return '~1 min';
  if (minutes <= 3) return '~2 min';
  if (minutes <= 6) return '~5 min';
  if (minutes <= 12) return '~10 min';

  // Past this point a number is pretending. Someone eleventh in line does not
  // need a figure, they need to know it is worth doing something else.
  return 'a while';
}

/** What to say about someone's own state, in the room. */
export const STATE_COPY: Readonly<
  Record<SpeakingState, { readonly label: string; readonly means: string }>
> = Object.freeze({
  listening: {
    label: 'Listening',
    // The three questions every state answers: who can see me, who can hear
    // me, what happens next.
    means: 'You are silent. You can hear the room and read along.',
  },
  waiting: {
    label: 'Waiting to speak',
    means: 'Your hand is up. Nobody can hear you yet.',
  },
  next: {
    label: 'You are next',
    means: 'A place is free. The host will bring you in.',
  },
  speaking: {
    label: 'Speaking',
    means: 'Everyone in this room can hear you.',
  },
});
