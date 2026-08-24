/**
 * CONVERSATION TEMPERATURE — the room's social contract, set by its host.
 *
 * WHY A ROOM NEEDS ONE
 * --------------------
 * Most of what goes wrong between strangers is not malice, it is mismatched
 * expectations. Someone shares something painful and gets three people offering
 * solutions; someone comes to laugh and lands in a room processing grief.
 * Neither party did anything wrong, and both leave worse.
 *
 * A category cannot fix that — "late night" describes when, not how. The
 * temperature says what kind of conversation this is *meant* to be, in words,
 * before anyone walks in.
 *
 * WHY IT IS THE HOST'S TO SET AND NOT A VOTE
 * ------------------------------------------
 * The pulse is what the room feels like; the temperature is what it is FOR.
 * Voting on the second would mean a room's purpose drifts with whoever turned
 * up, which is precisely what makes an unmoderated space unusable for the
 * people who needed it to stay one thing.
 *
 * WHY IT IS TEXT AND NOT A SETTING
 * --------------------------------
 * Each temperature carries an explicit sentence about what is welcome and what
 * is not. "Deep" alone means nothing; *"personal stories are welcome, no advice
 * unless someone asks"* is a rule two strangers can actually hold each other
 * to — and it is what a moderator can point at afterwards.
 */

export type RoomTemperature = 'quiet' | 'warm' | 'deep';

export const ROOM_TEMPERATURES: readonly RoomTemperature[] = Object.freeze([
  'quiet',
  'warm',
  'deep',
] as const);

export function isRoomTemperature(value: string): value is RoomTemperature {
  return (ROOM_TEMPERATURES as readonly string[]).includes(value);
}

/** The default for a new room: the least demanding thing to walk into. */
export const DEFAULT_TEMPERATURE: RoomTemperature = 'warm';

export interface TemperatureContract {
  readonly label: string;
  /** One line, shown on the room card before anyone enters. */
  readonly summary: string;
  /**
   * What is welcome and what is not.
   *
   * Two or three short lines, written as an invitation rather than a rule
   * list — a room that opens with prohibitions is a room nobody relaxes in.
   */
  readonly welcome: readonly string[];
}

export const TEMPERATURE: Readonly<Record<RoomTemperature, TemperatureContract>> = Object.freeze({
  quiet: {
    label: 'Quiet',
    summary: 'For people who do not want to talk much.',
    welcome: [
      'Long silences are fine here.',
      'Nobody will be asked to speak.',
      'Company without conversation is the point.',
    ],
  },
  warm: {
    label: 'Warm',
    summary: 'Kind conversation with strangers.',
    welcome: [
      'Small talk is genuinely welcome.',
      'Join in or just listen — both are normal.',
      'Assume good faith from people you cannot see.',
    ],
  },
  deep: {
    label: 'Deep',
    summary: 'Longer conversations that go somewhere.',
    welcome: [
      'Personal stories are welcome.',
      'No advice unless someone asks for it.',
      'What is said here is not repeated elsewhere.',
    ],
  },
});

/**
 * The rules shown before someone enters.
 *
 * The first three are constant and apply everywhere — they are the platform's
 * rules, not the host's — and the temperature's own lines follow. Keeping them
 * in one list means a person reads one screen rather than two.
 */
export function entryRules(temperature: RoomTemperature): readonly string[] {
  return [
    'Raise your hand before speaking.',
    'Nobody has to talk. Listening is the normal way to be here.',
    'No harassment, and nothing shared here goes anywhere else.',
    ...TEMPERATURE[temperature].welcome,
  ];
}
