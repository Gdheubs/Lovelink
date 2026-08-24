import { describe, expect, it } from 'vitest';
import {
  describePulse,
  PULSE_MIN_VOTERS,
  summarizePulse,
  type RoomFeeling,
} from '../../src/domain/values/roomFeeling.js';
import {
  DEFAULT_TEMPERATURE,
  entryRules,
  isRoomTemperature,
  ROOM_TEMPERATURES,
  TEMPERATURE,
} from '../../src/domain/values/roomTemperature.js';
import { canSeeOpenDoor, INTENT, INTENTS } from '../../src/domain/values/presenceIntent.js';

/**
 * ROOM ATMOSPHERE — pulse, temperature, and who can see an open door.
 *
 * The pulse tests are weighted almost entirely towards the ANONYMITY threshold,
 * because that is the only part of this that can hurt someone. Everything else
 * is arithmetic; that one is a promise.
 */
describe('room atmosphere', () => {
  const votes = (...feelings: RoomFeeling[]) => feelings;
  const many = (feeling: RoomFeeling, n: number): RoomFeeling[] => Array.from({ length: n }, () => feeling);

  // =========================================================================
  describe('pulse anonymity', () => {
    it('shows nothing at all when nobody has voted', () => {
      const pulse = summarizePulse([]);
      expect(pulse.dominant).toBeNull();
      expect(pulse.tooFewToShow).toBe(false);
    });

    it('REFUSES TO ANSWER IN A ROOM TOO SMALL TO BE ANONYMOUS', () => {
      // Three people, all voting the same way. In a room that size, knowing the
      // result plus your own vote tells you both of the others.
      const pulse = summarizePulse(many('heavy', 3));

      expect(pulse.slices).toHaveLength(0);
      expect(pulse.dominant).toBeNull();
      expect(pulse.tooFewToShow).toBe(true);
    });

    it('WITHHOLDS THE COUNT TOO, NOT JUST THE BREAKDOWN', () => {
      // "3 people have voted" in a room of four is most of the way to knowing
      // who did. The count is as identifying as the result.
      const pulse = summarizePulse(many('calm', 3));
      expect(pulse.voters).toBe(0);
    });

    it('stays silent right up to the threshold', () => {
      const justUnder = summarizePulse(many('warm', PULSE_MIN_VOTERS - 1));
      expect(justUnder.tooFewToShow).toBe(true);
      expect(justUnder.dominant).toBeNull();
    });

    it('answers once there are enough people to hide in', () => {
      const enough = summarizePulse(many('warm', PULSE_MIN_VOTERS));
      expect(enough.tooFewToShow).toBe(false);
      expect(enough.dominant).toBe('warm');
      expect(enough.voters).toBe(PULSE_MIN_VOTERS);
    });

    it('the threshold is above the point where elimination works', () => {
      // Not an implementation detail. At four, one person knowing their own
      // vote leaves three — small enough to guess. This is a judgement, and it
      // is deliberately on the cautious side.
      expect(PULSE_MIN_VOTERS).toBeGreaterThanOrEqual(5);
    });
  });

  // =========================================================================
  describe('pulse arithmetic', () => {
    it('reports shares as whole percentages, strongest first', () => {
      const pulse = summarizePulse(
        votes('calm', 'calm', 'calm', 'thoughtful', 'thoughtful', 'playful'),
      );

      expect(pulse.slices[0]).toEqual({ feeling: 'calm', share: 50 });
      expect(pulse.slices[1]).toEqual({ feeling: 'thoughtful', share: 33 });
      expect(pulse.slices[2]).toEqual({ feeling: 'playful', share: 17 });
    });

    it('is deterministic when two feelings tie', () => {
      // Otherwise the room's description flickers between two words on every
      // refresh, which reads as the room changing when nothing has.
      const a = summarizePulse(votes('warm', 'warm', 'calm', 'calm', 'playful'));
      const b = summarizePulse(votes('calm', 'calm', 'warm', 'warm', 'playful'));
      expect(a.dominant).toBe(b.dominant);
    });

    it('names the strongest feeling', () => {
      const pulse = summarizePulse(votes('heavy', 'heavy', 'heavy', 'heavy', 'calm'));
      expect(pulse.dominant).toBe('heavy');
    });
  });

  // =========================================================================
  describe('describing a room', () => {
    it('says nothing when there is nothing safe to say', () => {
      expect(describePulse(summarizePulse(many('calm', 2)))).toBeNull();
      expect(describePulse(summarizePulse([]))).toBeNull();
    });

    it('speaks in prose, not percentages', () => {
      const line = describePulse(summarizePulse(many('calm', 6)));
      expect(line).toBeTruthy();
      // The whole point: "63% calm" tells someone nothing about whether to
      // walk in.
      expect(line).not.toMatch(/\d/);
    });

    it('hedges when the room is mixed', () => {
      const strong = describePulse(summarizePulse(many('playful', 8)));
      const mixed = describePulse(
        summarizePulse(votes('playful', 'playful', 'playful', 'calm', 'warm', 'heavy', 'thoughtful')),
      );
      expect(strong).not.toBe(mixed);
    });

    it('describes the ROOM and never a person', () => {
      for (const feeling of ['calm', 'thoughtful', 'playful', 'warm', 'heavy'] as RoomFeeling[]) {
        const line = describePulse(summarizePulse(many(feeling, 6)));
        // "You feel…" would be a disclosure about a person rather than a
        // description of a place.
        expect(line).not.toMatch(/\byou\b/i);
      }
    });
  });

  // =========================================================================
  describe('temperature', () => {
    it('every temperature carries an actual contract', () => {
      for (const temperature of ROOM_TEMPERATURES) {
        const contract = TEMPERATURE[temperature];
        expect(contract.summary.length).toBeGreaterThan(10);
        // A label alone means nothing. "Deep" is not a rule; "no advice unless
        // someone asks" is one two strangers can hold each other to.
        expect(contract.welcome.length).toBeGreaterThanOrEqual(2);
      }
    });

    it('defaults to the least demanding thing to walk into', () => {
      expect(DEFAULT_TEMPERATURE).toBe('warm');
    });

    it('rejects anything not a temperature', () => {
      expect(isRoomTemperature('deep')).toBe(true);
      expect(isRoomTemperature('spicy')).toBe(false);
    });

    it('entry rules put the platform’s rules before the host’s', () => {
      const rules = entryRules('deep');

      // The first three are ours and apply everywhere; the host's follow.
      expect(rules[0]).toMatch(/raise your hand/i);
      expect(rules.some((r) => /listening is the normal way/i.test(r))).toBe(true);
      expect(rules).toContain('No advice unless someone asks for it.');
    });

    it('every room type says listening is normal', () => {
      for (const temperature of ROOM_TEMPERATURES) {
        expect(entryRules(temperature).some((r) => /listening/i.test(r))).toBe(true);
      }
    });
  });

  // =========================================================================
  describe('open door', () => {
    it('is invisible to a stranger', () => {
      // The whole safety property. Visible to everyone, it is an advertisement
      // — and the people who act on advertisements from strangers are the ones
      // the ladder exists to slow down.
      expect(
        canSeeOpenDoor({ viewerHasSharedRoom: false, targetOpenDoor: true, blocked: false }),
      ).toBe(false);
    });

    it('is visible to someone you have shared a room with', () => {
      expect(
        canSeeOpenDoor({ viewerHasSharedRoom: true, targetOpenDoor: true, blocked: false }),
      ).toBe(true);
    });

    it('A BLOCK HIDES IT REGARDLESS OF HISTORY', () => {
      expect(
        canSeeOpenDoor({ viewerHasSharedRoom: true, targetOpenDoor: true, blocked: true }),
      ).toBe(false);
    });

    it('a closed door is invisible to everyone', () => {
      expect(
        canSeeOpenDoor({ viewerHasSharedRoom: true, targetOpenDoor: false, blocked: false }),
      ).toBe(false);
    });
  });

  // =========================================================================
  describe('intent', () => {
    it('every intent says plainly what choosing it does', () => {
      for (const intent of INTENTS) {
        // A choice whose effect is unstated is a choice someone makes blind —
        // and this one shapes what they are shown.
        expect(INTENT[intent].effect).toMatch(/we will show you/i);
      }
    });

    it('is about tonight, not about identity', () => {
      // Labels are verbs. "Listener" would be a personality; "Listen" is what
      // someone is doing this evening.
      for (const intent of INTENTS) {
        expect(INTENT[intent].label).not.toMatch(/er$/);
      }
    });
  });
});
