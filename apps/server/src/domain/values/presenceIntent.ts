/**
 * WHAT SOMEONE IS HERE FOR TONIGHT — and whether their door is open.
 *
 * WHY THIS REPLACES A BIO
 * -----------------------
 * A bio is a performance written once and then defended. It says who someone
 * wants to be taken for, which is exactly the thing this product is trying not
 * to be about.
 *
 * "Tonight I am here to listen" is a different kind of statement: it is about
 * this evening, it costs nothing to change, and it is actually useful — it is
 * the single best signal for which room someone should be shown.
 *
 * WHY IT EXPIRES ON ITS OWN
 * -------------------------
 * Because it is about tonight. An intent that persisted would become a profile
 * field, which is a bio with extra steps — and someone who chose "meet someone"
 * once should not still be advertising it a fortnight later. It lives with a
 * TTL and disappears without anything having to run.
 */

export type Intent = 'listen' | 'talk' | 'think' | 'connect' | 'be';

export const INTENTS: readonly Intent[] = Object.freeze([
  'listen',
  'talk',
  'think',
  'connect',
  'be',
] as const);

export function isIntent(value: string): value is Intent {
  return (INTENTS as readonly string[]).includes(value);
}

export interface IntentCopy {
  readonly label: string;
  /** What choosing it actually does, said plainly. */
  readonly effect: string;
}

export const INTENT: Readonly<Record<Intent, IntentCopy>> = Object.freeze({
  listen: { label: 'Listen', effect: 'We will show you quieter rooms.' },
  talk: { label: 'Talk', effect: 'We will show you rooms with a conversation going.' },
  think: { label: 'Think', effect: 'We will show you rooms having longer conversations.' },
  connect: { label: 'Connect', effect: 'We will show you smaller rooms.' },
  /*
   * "Just be here" replaced an earlier "Meet someone", for two reasons.
   *
   * It DUPLICATED Open Door, which already says "I am open to meeting someone
   * tonight" — and says it to the right audience, which is people you have
   * already shared a room with rather than a ranking function.
   *
   * And it is the truest thing this product offers. Somebody who opens the app
   * at 2am often does not want to listen, talk, think or connect; they want to
   * not be alone in a room, with no expectation attached. Every other option
   * asks something of them. This one does not.
   */
  be: { label: 'Just be here', effect: 'We will show you rooms you can sit in quietly.' },
});

/**
 * How long an intent lasts.
 *
 * Six hours: long enough to cover an evening, short enough that it is gone by
 * the next one. Someone who opens the app tomorrow is asked again, which is the
 * point — the answer is supposed to be about today.
 */
export const INTENT_TTL_SECONDS = 6 * 60 * 60;

/**
 * OPEN DOOR — "I am open to meeting someone tonight."
 *
 * WHAT IT DOES AND, MORE IMPORTANTLY, WHAT IT DOES NOT
 * ----------------------------------------------------
 * It does NOT open a channel. Nobody gains the ability to message someone
 * because their door is open; the ladder is unchanged, and a DM request still
 * has to be sent and accepted.
 *
 * What it changes is whether asking feels like an imposition. Most people never
 * send the request — not because they are unsure about the other person, but
 * because they cannot tell whether the other person wants to be asked. The door
 * answers that one question and nothing else.
 *
 * WHY IT IS ONLY VISIBLE TO PEOPLE YOU HAVE ALREADY MET
 * -----------------------------------------------------
 * Visible to everyone, it would be an advertisement — and the people who would
 * act on an advertisement from a stranger are exactly the ones the ladder
 * exists to slow down. Restricted to people you have shared a room with, it is
 * a note to someone who already has a reason to remember you.
 *
 * WHY IT IS TIME-BOUNDED AND FAILS CLOSED
 * ---------------------------------------
 * "Tonight" has to mean tonight, so it carries its own expiry. And because it
 * lives in the ephemeral store, losing that store closes every door rather than
 * opening one — which is the only acceptable direction for this to fail in.
 */
export const OPEN_DOOR_TTL_SECONDS = 8 * 60 * 60;

export interface Availability {
  readonly intent: Intent | null;
  readonly openDoor: boolean;
}

export const CLOSED: Availability = Object.freeze({ intent: null, openDoor: false });

/**
 * Whether one person may see that another's door is open.
 *
 * A pure rule rather than a query filter, so the socket edge, the REST edge and
 * any future screen cannot each decide it slightly differently — and so that
 * the answer is testable without a database.
 */
export function canSeeOpenDoor(input: {
  readonly viewerHasSharedRoom: boolean;
  readonly targetOpenDoor: boolean;
  readonly blocked: boolean;
}): boolean {
  if (input.blocked) return false;
  if (!input.targetOpenDoor) return false;
  return input.viewerHasSharedRoom;
}
