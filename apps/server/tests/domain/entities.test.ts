import { describe, expect, it } from 'vitest';
import {
  normalizeDisplayName,
  toPublicProfile,
  type User,
} from '../../src/domain/entities/User.js';
import { normalizeRoomTitle, slugify } from '../../src/domain/entities/Room.js';
import { atLeast, canPublishAudio } from '../../src/domain/entities/RoomMember.js';
import {
  canTransition,
  counterpart,
  emptyRelationship,
  isDmOpen,
} from '../../src/domain/entities/Relationship.js';
import {
  formatCode,
  normalizeCode,
  normalizeSurpriseMessage,
  normalizeTasks,
  SURPRISE_MAX_TASKS,
} from '../../src/domain/entities/Surprise.js';
import { assertAllowedReaction, normalizeChatText } from '../../src/domain/entities/ChatMessage.js';
import { hasUnsafeCharacters, MULTI_LINE, normalizeBody } from '../../src/domain/values/text.js';
import {
  projectTrustScore,
  trustTier,
  TRUST_MAX,
  TRUST_MIN,
} from '../../src/domain/values/trust.js';
import { orderedPair, pairKey, asUserId } from '../../src/domain/values/ids.js';
import { ValidationError } from '../../src/domain/errors.js';

/** A literal NUL, written explicitly so it is visible in the source. */
const NUL = String.fromCodePoint(0);

describe('text safety', () => {
  it('rejects control characters in single-line fields', () => {
    expect(hasUnsafeCharacters('hello\nworld')).toBe(true);
    expect(hasUnsafeCharacters(`hello${NUL}world`)).toBe(true);
    expect(hasUnsafeCharacters('hello world')).toBe(false);
  });

  it('allows newlines in multi-line fields', () => {
    expect(hasUnsafeCharacters('hello\nworld', MULTI_LINE)).toBe(false);
    // But still not a NUL.
    expect(hasUnsafeCharacters(`hello${NUL}world`, MULTI_LINE)).toBe(true);
  });

  it('rejects bidi overrides — the Trojan Source class', () => {
    // These can visually reverse surrounding text, letting one user make
    // another user's message appear to say something it does not.
    const rlo = String.fromCodePoint(0x202e);
    const lri = String.fromCodePoint(0x2066);
    expect(hasUnsafeCharacters(`safe${rlo}text`)).toBe(true);
    expect(hasUnsafeCharacters(`safe${lri}text`, MULTI_LINE)).toBe(true);
  });

  it('collapses excessive blank lines used to push others off screen', () => {
    expect(normalizeBody('a\n\n\n\n\nb')).toBe('a\n\nb');
  });
});

describe('User', () => {
  it('normalizes whitespace in display names', () => {
    expect(normalizeDisplayName('  Priya    Sharma ')).toBe('Priya Sharma');
  });

  it('rejects names that are too short or too long', () => {
    expect(() => normalizeDisplayName('a')).toThrow(ValidationError);
    expect(() => normalizeDisplayName('x'.repeat(25))).toThrow(ValidationError);
  });

  it('rejects a name containing a bidi override', () => {
    expect(() => normalizeDisplayName(`Bob${String.fromCodePoint(0x202e)}`)).toThrow(
      /not allowed/i,
    );
  });

  it('toPublicProfile leaks nothing sensitive', () => {
    const user: User = {
      id: asUserId('u1'),
      identifier: '+447700900000',
      identifierKind: 'phone',
      displayName: 'Priya',
      avatarSeed: 'seed',
      dob: new Date('1995-01-01'),
      trustScore: 45,
      status: 'active',
      createdAt: new Date(),
    };
    const profile = toPublicProfile(user);

    expect(Object.keys(profile).sort()).toEqual(['avatarSeed', 'displayName', 'id', 'tier']);
    // The three things that must never leave the server:
    expect(JSON.stringify(profile)).not.toContain('447700900000');
    expect(JSON.stringify(profile)).not.toContain('1995');
    expect(JSON.stringify(profile)).not.toContain('45');
  });
});

describe('Room', () => {
  it('slugifies a title', () => {
    expect(slugify('Late Night Talk')).toBe('late-night-talk');
    expect(slugify('  Study & Focus!!  ')).toBe('study-focus');
  });

  it('never produces an empty slug', () => {
    // A title of pure punctuation or non-Latin script would otherwise yield ''.
    expect(slugify('!!!')).toBe('room');
    expect(slugify('日本語')).toBe('room');
  });

  it('validates titles', () => {
    expect(normalizeRoomTitle('  Deep   Work  ')).toBe('Deep Work');
    expect(() => normalizeRoomTitle('ab')).toThrow(ValidationError);
  });
});

describe('RoomMember roles', () => {
  it('treats roles as a ladder', () => {
    expect(atLeast('host', 'speaker')).toBe(true);
    expect(atLeast('speaker', 'speaker')).toBe(true);
    expect(atLeast('listener', 'speaker')).toBe(false);
  });

  it('gates audio on role AND host mute', () => {
    expect(canPublishAudio({ role: 'speaker', mutedByHost: false })).toBe(true);
    expect(canPublishAudio({ role: 'speaker', mutedByHost: true })).toBe(false);
    expect(canPublishAudio({ role: 'listener', mutedByHost: false })).toBe(false);
  });
});

describe('Relationship state machine', () => {
  it('permits the intended progression', () => {
    expect(canTransition('none', 'dm_requested')).toBe(true);
    expect(canTransition('dm_requested', 'dm_open')).toBe(true);
    expect(canTransition('dm_open', 'call_open')).toBe(true);
  });

  it('forbids skipping rungs', () => {
    expect(canTransition('none', 'dm_open')).toBe(false);
    expect(canTransition('none', 'call_open')).toBe(false);
    expect(canTransition('dm_requested', 'call_open')).toBe(false);
  });

  it('allows blocking from any state', () => {
    for (const from of ['none', 'dm_requested', 'dm_open', 'call_open'] as const) {
      expect(canTransition(from, 'blocked')).toBe(true);
    }
  });

  it('unblocking returns to none, never to the previous rung', () => {
    // Regaining call access must require fresh consent.
    expect(canTransition('blocked', 'none')).toBe(true);
    expect(canTransition('blocked', 'dm_open')).toBe(false);
    expect(canTransition('blocked', 'call_open')).toBe(false);
  });

  it('an unrecorded pair is semantically none', () => {
    const rel = emptyRelationship(asUserId('b'), asUserId('a'), new Date());
    expect(rel.state).toBe('none');
    // And it is normalized to ordered form.
    expect(rel.userA).toBe('a');
    expect(rel.userB).toBe('b');
  });

  it('isDmOpen covers the call rung too', () => {
    expect(isDmOpen({ state: 'dm_open' })).toBe(true);
    expect(isDmOpen({ state: 'call_open' })).toBe(true);
    expect(isDmOpen({ state: 'dm_requested' })).toBe(false);
  });

  it('counterpart returns the other party from either side', () => {
    const rel = emptyRelationship(asUserId('a'), asUserId('b'), new Date());
    expect(counterpart(rel, asUserId('a'))).toBe('b');
    expect(counterpart(rel, asUserId('b'))).toBe('a');
  });
});

describe('pair ordering', () => {
  it('is symmetric', () => {
    expect(orderedPair(asUserId('b'), asUserId('a'))).toEqual(['a', 'b']);
    expect(pairKey(asUserId('b'), asUserId('a'))).toBe(pairKey(asUserId('a'), asUserId('b')));
  });
});

describe('trust projection', () => {
  it('sums the ledger', () => {
    expect(projectTrustScore([2, 3, -10])).toBe(-5);
  });

  it('clamps to the allowed range', () => {
    expect(projectTrustScore([500])).toBe(TRUST_MAX);
    expect(projectTrustScore([-500])).toBe(TRUST_MIN);
  });

  it('maps scores to tiers', () => {
    expect(trustTier(-1)).toBe('restricted');
    expect(trustTier(0)).toBe('newcomer');
    expect(trustTier(10)).toBe('regular');
    expect(trustTier(40)).toBe('trusted');
  });
});

describe('Surprise', () => {
  it('normalizes codes so any reasonable typing works', () => {
    // A user reading a code off a screen may type it several ways.
    expect(normalizeCode('love-2847')).toBe('LOVE2847');
    expect(normalizeCode('LOVE 2847')).toBe('LOVE2847');
    expect(normalizeCode('  Love2847  ')).toBe('LOVE2847');
  });

  it('formats a code for display', () => {
    expect(formatCode('LOVE2847')).toBe('LOVE-2847');
  });

  it('validates the message', () => {
    expect(normalizeSurpriseMessage('  hello\n\n\n\nthere  ')).toBe('hello\n\nthere');
    expect(() => normalizeSurpriseMessage('   ')).toThrow(/needs a message/i);
    expect(() => normalizeSurpriseMessage('x'.repeat(1001))).toThrow(/1000 characters/);
  });

  it('drops empty tasks and caps the count', () => {
    expect(normalizeTasks(['send a voice note', '  ', ''])).toEqual([
      { text: 'send a voice note', done: false },
    ]);
    expect(() => normalizeTasks(Array(SURPRISE_MAX_TASKS + 1).fill('task'))).toThrow(/at most/i);
  });
});

describe('ChatMessage', () => {
  it('validates message text', () => {
    expect(normalizeChatText('  hi  ')).toBe('hi');
    expect(() => normalizeChatText('   ')).toThrow(/cannot be empty/i);
    expect(() => normalizeChatText('x'.repeat(501))).toThrow(/500 characters/);
  });

  it('restricts reactions to a closed palette', () => {
    // An open emoji field is a free-form text channel and a known route around
    // chat moderation.
    expect(() => assertAllowedReaction('heart')).not.toThrow();
    expect(() => assertAllowedReaction('🖕')).toThrow(/not available/i);
    expect(() => assertAllowedReaction('<script>')).toThrow(/not available/i);
  });
});
