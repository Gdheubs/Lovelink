/**
 * Deterministic avatar rendering from a seed.
 *
 * WHY GENERATED AND NOT UPLOADED
 * ------------------------------
 * No image uploads at MVP is a SAFETY decision, not a scope one. An upload
 * field on a platform where strangers meet is an image-abuse surface that
 * requires moderation tooling, storage policy and a takedown process before it
 * can responsibly exist. Generated avatars give people a recognisable identity
 * with none of that.
 *
 * The seed is random and server-issued (never derived from a phone number or
 * email — an avatar is public, and deriving it would be a public commitment to
 * a private value). This module only turns that seed into pixels.
 *
 * The output is stable: the same seed always renders the same avatar, on every
 * device, forever. That is what makes it usable as an identity cue in a member
 * list.
 */

/**
 * FNV-1a. A tiny, fast, well-distributed non-cryptographic hash.
 *
 * Cryptographic strength is irrelevant here — nothing is being protected, the
 * seed is already random — but AVALANCHE matters: two seeds differing by one
 * character must produce visibly different avatars, or people who signed up
 * seconds apart end up looking alike.
 */
function hash(seed: string): number {
  let value = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    value ^= seed.charCodeAt(i);
    value = Math.imul(value, 0x01000193);
  }
  return value >>> 0;
}

/**
 * Hues chosen to be distinguishable from each other AND to keep white text
 * readable at the saturation/lightness below. Deliberately no reds around
 * 0-15deg, which read as an error state in a UI.
 */
const HUES = [212, 258, 292, 330, 24, 42, 88, 152, 176, 196];

export interface AvatarStyle {
  readonly background: string;
  readonly foreground: string;
  readonly initials: string;
}

export function avatarFor(seed: string, displayName: string): AvatarStyle {
  const h = hash(seed);

  const hue = HUES[h % HUES.length]!;
  // A second, decorrelated slice of the hash for the gradient's other stop, so
  // two avatars sharing a base hue still differ.
  const partnerHue = HUES[(h >>> 8) % HUES.length]!;

  return {
    background: `linear-gradient(135deg, hsl(${hue} 62% 46%), hsl(${partnerHue} 58% 34%))`,
    foreground: '#ffffff',
    initials: initialsOf(displayName),
  };
}

/**
 * One or two initials.
 *
 * Uses `Intl.Segmenter` where available so that emoji, combining marks and
 * scripts outside Latin are not sliced mid-grapheme — `name[0]` on an emoji
 * returns half a surrogate pair and renders as a replacement character.
 */
export function initialsOf(displayName: string): string {
  const words = displayName.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';

  const firstGrapheme = (word: string): string => {
    if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
      const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
      const first = segmenter.segment(word)[Symbol.iterator]().next();
      if (!first.done) return first.value.segment;
    }
    return [...word][0] ?? '';
  };

  const first = firstGrapheme(words[0]!);
  const second = words.length > 1 ? firstGrapheme(words[words.length - 1]!) : '';

  return (first + second).toUpperCase();
}

/** Human-readable label for a trust tier, for the profile screen. */
export const TIER_LABEL: Readonly<Record<string, string>> = Object.freeze({
  restricted: 'Limited',
  newcomer: 'New here',
  regular: 'Regular',
  trusted: 'Trusted',
});
