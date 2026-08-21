/**
 * Text safety primitives shared by every free-text field in the system
 * (display names, room titles, chat messages, surprise messages, report notes).
 *
 * WHY THIS EXISTS
 * ---------------
 * Two separate hazards, both easy to forget at a single call site and therefore
 * centralised here:
 *
 *  1. CONTROL CHARACTERS let a string break out of the shape the UI expects —
 *     a newline in a display name, a NUL that truncates in some downstream
 *     consumer.
 *  2. BIDI OVERRIDES (U+202A..U+202E, U+2066..U+2069) and the directional marks
 *     U+200E/U+200F can visually REVERSE surrounding text. In a member list or
 *     a chat log this lets one user make another user's message appear to say
 *     something it does not. This is the "Trojan Source" class of attack and it
 *     is invisible in code review, so it must be blocked by a shared function.
 *
 * We REJECT rather than strip: silently mutating what someone typed produces
 * confusing bug reports, and a rejection message teaches the user what happened.
 *
 * Deliberately expressed with explicit code-point arithmetic instead of a regex
 * literal full of escapes — the ranges are the point, and they should be
 * readable and greppable rather than encoded.
 */

const NUL = 0x00;
const UNIT_SEPARATOR = 0x1f;
const DELETE = 0x7f;
const APPLICATION_PROGRAM_COMMAND = 0x9f;

const LRM = 0x200e; // left-to-right mark
const RLM = 0x200f; // right-to-left mark
const BIDI_EMBEDDING_START = 0x202a; // LRE
const BIDI_EMBEDDING_END = 0x202e; // RLO
const BIDI_ISOLATE_START = 0x2066; // LRI
const BIDI_ISOLATE_END = 0x2069; // PDI

/** Newline and tab are legitimate in multi-line fields, so they are opt-in. */
const TAB = 0x09;
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;

export interface TextPolicy {
  /** Allow \n, \r and \t. True for message bodies, false for names and titles. */
  readonly allowNewlines: boolean;
}

export const SINGLE_LINE: TextPolicy = Object.freeze({ allowNewlines: false });
export const MULTI_LINE: TextPolicy = Object.freeze({ allowNewlines: true });

function isDisallowedControl(code: number, policy: TextPolicy): boolean {
  if (policy.allowNewlines && (code === TAB || code === LINE_FEED || code === CARRIAGE_RETURN)) {
    return false;
  }
  if (code >= NUL && code <= UNIT_SEPARATOR) return true;
  if (code >= DELETE && code <= APPLICATION_PROGRAM_COMMAND) return true;
  return false;
}

function isBidiControl(code: number): boolean {
  if (code === LRM || code === RLM) return true;
  if (code >= BIDI_EMBEDDING_START && code <= BIDI_EMBEDDING_END) return true;
  if (code >= BIDI_ISOLATE_START && code <= BIDI_ISOLATE_END) return true;
  return false;
}

/**
 * True when the string contains a character that could corrupt how it, or the
 * text around it, is displayed.
 */
export function hasUnsafeCharacters(value: string, policy: TextPolicy = SINGLE_LINE): boolean {
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code === undefined) continue;
    if (isDisallowedControl(code, policy)) return true;
    if (isBidiControl(code)) return true;
  }
  return false;
}

/**
 * Collapse runs of whitespace and trim. Applied to names and titles so that
 * "a     b" and "a b" cannot both exist and look identical in a member list.
 */
export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Trim a multi-line body: strip leading/trailing blank space and collapse runs
 * of more than two consecutive newlines, which are otherwise used to shout by
 * pushing other people's messages off screen.
 */
export function normalizeBody(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
