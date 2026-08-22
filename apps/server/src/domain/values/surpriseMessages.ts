import type { SurpriseMood, SurpriseTheme } from '../entities/Surprise.js';

/**
 * The prepared messages a surprise reveals, chosen by THEME × MOOD.
 *
 * WHERE THESE CAME FROM
 * ---------------------
 * Ported from the original LoveLink page (`index.html`), which shipped 24
 * hand-written messages across four themes and six moods. That page called the
 * selection "AI generation" behind a fake loading animation; it was always a
 * lookup table, and it is one here too — honestly labelled.
 *
 * WHY A TABLE AND NOT A LANGUAGE MODEL
 * ------------------------------------
 * Three reasons, in order of weight:
 *
 *   1. SAFETY. A generated message is unpredictable text delivered to someone
 *      who is, by their own admission, angry or sad or exhausted. A fixed table
 *      can be read in full before it ships, and cannot say something cruel on
 *      its thousandth rendering.
 *   2. It is deterministic, so re-opening a surprise shows the same words. A
 *      message that quietly rewrites itself is unsettling.
 *   3. No latency, no cost, no external dependency, and it works offline.
 *
 * WHY THE RECIPIENT PICKS THE MOOD
 * --------------------------------
 * The sender chooses the theme — what they are trying to say. The RECIPIENT
 * chooses the mood at the moment they open it, because the sender wrote this
 * hours or days ago and cannot know how the reader is feeling now. That single
 * choice is what lets one message meet someone where they actually are.
 *
 * These are deliberately in the DOMAIN, not a database: they are rules about
 * what the product says, they need review, and they belong in version control
 * where a change is visible in a diff.
 */

type MoodMessages = Readonly<Record<SurpriseMood, (senderName: string) => string>>;

const LOVE: MoodMessages = {
  angry: (n) =>
    `${n} wanted you to know: even when the world feels sharp and loud, this does not change. You are allowed to feel everything you are feeling — nobody is asking you to be gracious about it. You are loved in the storm, and after it.`,
  sad: (n) =>
    `${n} wanted you to know: they wish they could just sit next to you right now and say nothing at all. You carry a lot, more quietly than anyone realises. You are loved, completely, and not because you are coping well.`,
  meh: (n) =>
    `${n} wanted you to know: on the grey days, the quiet ones, the ones that feel like nothing — that is exactly when they think of you most deliberately. Not everything has to be fireworks. Sometimes it is just choosing someone again on a Tuesday.`,
  happy: (n) =>
    `${n} wanted you to know: seeing you happy is genuinely one of their favourite things. Keep going. Somebody is quietly proud of you today.`,
  soft: (n) =>
    `${n} wanted you to know: what they feel for you is somewhere between a deep breath and a heartbeat, and they cannot quite get it into words. You make ordinary moments feel like they matter.`,
  tired: (n) =>
    `${n} wanted you to know: please rest. You do not have to earn this by doing more or being more. You are enough exactly as you are right now — tired, unpolished, human.`,
};

const SORRY: MoodMessages = {
  angry: (n) =>
    `${n} wanted to say sorry. Not to talk you out of being angry — you have every right to that. Just: they were wrong, they know it, and they are not asking you to be finished with it yet.`,
  sad: (n) =>
    `${n} wanted to say sorry. They hate that they are the reason for this. Not just for what happened, but for the weight it put on you afterwards.`,
  meh: (n) =>
    `${n} wanted to say sorry. They know it is a small word for a big thing. They are not asking you to move on today — only to know that they understand why it mattered.`,
  happy: (n) =>
    `${n} wanted to say sorry — properly, even though today seems like a good day. You deserve the good day. They are glad you are having one.`,
  soft: (n) =>
    `${n} wanted to say sorry. A real one, not a convenient one. You are worth the effort of doing better, and they intend to.`,
  tired: (n) =>
    `${n} wanted to say sorry, and to keep it short because you are exhausted. You do not have to reply or deal with this now. It will still be true tomorrow.`,
};

const MISS: MoodMessages = {
  angry: (n) =>
    `${n} misses you. Even with everything tangled between you — missing someone does not wait for the right moment, and it is not always soft. Sometimes it is restless, exactly like this.`,
  sad: (n) =>
    `${n} misses you. The space where you usually are feels much bigger when you are not in it. Quiet rooms, half-finished sentences, that kind of thing.`,
  meh: (n) =>
    `${n} misses you. Nothing dramatic — just the way ordinary moments feel slightly incomplete without you in them.`,
  happy: (n) =>
    `${n} misses you, and is smiling about it. You are woven into their good days even when you are not there.`,
  soft: (n) =>
    `${n} misses you the way you miss warmth in winter. Not dramatically. Constantly, in every cold moment.`,
  tired: (n) =>
    `${n} misses you, and says everything is easier when you are around. You are thought of, especially on the hard days.`,
};

const THINKING_OF_YOU: MoodMessages = {
  angry: (n) =>
    `${n} was thinking of you. No agenda, nothing to answer. Just: you matter to them — not only when things are easy, and not only when you are at your best.`,
  sad: (n) =>
    `${n} was thinking of you. They do not have a fix for what is making this hard, and they are not going to pretend otherwise. You do not have to be okay. You are just not invisible.`,
  meh: (n) =>
    `${n} was thinking of you. No occasion. You crossed their mind and they thought you should know that life is better with you in it.`,
  happy: (n) =>
    `${n} was thinking of you, and wanted to make a good day slightly better. That is all. No ask, no reason.`,
  soft: (n) =>
    `${n} was thinking of you, and wanted to leave something warm here. Like a flower on a doorstep — no explanation needed.`,
  tired: (n) =>
    `${n} was thinking of you. You have been doing a lot — more than people see, probably more than you admit. Somebody noticed.`,
};

const CONGRATS: MoodMessages = {
  angry: (n) =>
    `${n} wanted to say well done. Whatever else is going on — and it sounds like plenty — this part you got right, and it deserves saying out loud.`,
  sad: (n) =>
    `${n} wanted to say well done. Good news and a heavy heart can sit in the same day; one does not cancel the other. This still counts.`,
  meh: (n) =>
    `${n} wanted to say well done. It might not feel like much from the inside. From out here it looks like something.`,
  happy: (n) =>
    `${n} wanted to say well done, and to be loud about it. Enjoy this one properly. You earned it.`,
  soft: (n) =>
    `${n} wanted to say well done — quietly, the way you would probably prefer. They noticed what it took.`,
  tired: (n) =>
    `${n} wanted to say well done, and then: stop. You have done the thing. You are allowed to put it down now.`,
};

const TEMPLATES: Readonly<Record<SurpriseTheme, MoodMessages>> = Object.freeze({
  love: LOVE,
  sorry: SORRY,
  miss: MISS,
  thinking_of_you: THINKING_OF_YOU,
  congrats: CONGRATS,
});

/**
 * The message this surprise reveals.
 *
 * TOTAL by construction: every theme × mood pair has an entry, and the
 * fallback exists only so a future theme added without its messages degrades
 * to something kind rather than to `undefined` on someone's screen.
 */
export function revealMessage(
  theme: SurpriseTheme,
  mood: SurpriseMood,
  senderName: string,
): string {
  const message = TEMPLATES[theme]?.[mood];
  return message === undefined
    ? `${senderName} wanted you to know they are thinking of you today.`
    : message(senderName);
}

/** Exposed so a test can assert the table is complete rather than trusting it. */
export const SURPRISE_TEMPLATES = TEMPLATES;
