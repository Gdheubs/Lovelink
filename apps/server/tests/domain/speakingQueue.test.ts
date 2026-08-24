import { describe, expect, it } from 'vitest';
import {
  estimateWait,
  standingFor,
  STATE_COPY,
  type SpeakingState,
} from '../../src/domain/values/speakingQueue.js';

/**
 * WAITING TO SPEAK.
 *
 * Two things are being protected here, and neither is the arithmetic.
 *
 *   1. A WAITING PERSON IS NOT SHOWN THE QUEUE. They get a position and a
 *      rough wait. The list of who else is waiting turns the room into a
 *      scoreboard and exposes other people's intentions to an audience with no
 *      use for them.
 *
 *   2. THE ESTIMATE STAYS VAGUE. "~2 min", never "1m 43s". A countdown turns a
 *      conversation into a queueing system, and it would be a lie — nothing
 *      here knows how long anyone will talk.
 */
describe('speaking queue', () => {
  const base = {
    userId: 'me',
    isSpeaker: false,
    raisedHands: [] as readonly string[],
    maxSpeakers: 4,
    currentSpeakers: 4,
  };

  // =========================================================================
  describe('what state someone is in', () => {
    it('a listener with no hand up is simply listening', () => {
      expect(standingFor(base)).toEqual({ state: 'listening', position: null, wait: null });
    });

    it('a speaker is speaking, whatever the queue says', () => {
      const standing = standingFor({ ...base, isSpeaker: true, raisedHands: ['me'] });
      expect(standing.state).toBe('speaking');
      expect(standing.position).toBeNull();
    });

    it('a raised hand behind a full stage is waiting, with a position', () => {
      const standing = standingFor({ ...base, raisedHands: ['a', 'b', 'me'] });

      expect(standing.state).toBe('waiting');
      expect(standing.position).toBe(3);
      expect(standing.wait).toBeTruthy();
    });

    it('IS "NEXT" WHEN A PLACE IS ALREADY FREE', () => {
      // The difference matters to the person: "#1 in line" is still waiting,
      // and "you're next" is a reason to get ready.
      const standing = standingFor({
        ...base,
        raisedHands: ['me'],
        currentSpeakers: 2,
        maxSpeakers: 4,
      });

      expect(standing.state).toBe('next');
      // No estimate: there is nothing left to wait for but the host.
      expect(standing.wait).toBeNull();
    });

    it('several people can be "next" when several places are free', () => {
      const second = standingFor({
        ...base,
        raisedHands: ['a', 'me'],
        currentSpeakers: 1,
        maxSpeakers: 4,
      });
      expect(second.state).toBe('next');
    });

    it('THE ORDER IS THE ORDER HANDS WENT UP, AND NOTHING ELSE', () => {
      // No priority, no trust weighting, no jumping. In a room where everyone
      // can see each other's intentions it is the only ordering nobody can
      // argue with.
      const first = standingFor({ ...base, userId: 'a', raisedHands: ['a', 'b', 'me'] });
      const last = standingFor({ ...base, userId: 'me', raisedHands: ['a', 'b', 'me'] });

      expect(first.position).toBe(1);
      expect(last.position).toBe(3);
    });
  });

  // =========================================================================
  describe('what a waiting person is told', () => {
    it('A POSITION, NEVER THE QUEUE', () => {
      const standing = standingFor({ ...base, raisedHands: ['rahul', 'maya', 'me', 'alex'] });

      // The whole rule. Nothing in the return value names anyone else, and
      // nothing carries a length that reveals how many are waiting.
      expect(JSON.stringify(standing)).not.toContain('rahul');
      expect(JSON.stringify(standing)).not.toContain('maya');
      expect(JSON.stringify(standing)).not.toContain('alex');
      expect(Object.keys(standing)).toEqual(['state', 'position', 'wait']);
    });

    it('says nothing about how long they have already waited', () => {
      // "You have been waiting 4 minutes" is an invitation to feel owed a turn.
      const standing = standingFor({ ...base, raisedHands: ['a', 'me'] });
      expect(JSON.stringify(standing)).not.toMatch(/since|elapsed|waited/i);
    });
  });

  // =========================================================================
  describe('the estimate', () => {
    it('IS NEVER PRECISE', () => {
      // A countdown to the second turns a room into a ticket dispenser — and
      // would be false precision, because nothing here knows how long anyone
      // will talk for.
      for (let position = 1; position <= 20; position += 1) {
        const wait = estimateWait(position, 0, 4);
        expect(wait).not.toMatch(/\d+\s*s\b/);
        expect(wait).not.toMatch(/\d+m\s*\d+/);
      }
    });

    it('always reads as an approximation or a shrug', () => {
      for (let position = 1; position <= 20; position += 1) {
        const wait = estimateWait(position, 0, 4);
        expect(wait === 'a while' || wait.startsWith('~')).toBe(true);
      }
    });

    it('grows with the queue, but only in steps', () => {
      const near = estimateWait(1, 0, 4);
      const mid = estimateWait(8, 0, 4);
      const far = estimateWait(30, 0, 4);

      expect(near).not.toBe(far);
      // Coarse buckets, so neighbouring positions usually agree — which is the
      // point. A number that changes on every join is a number being watched.
      expect(estimateWait(5, 0, 4)).toBe(estimateWait(6, 0, 4));
      expect(mid).toBeTruthy();
    });

    it('gives up on a number when the queue is long', () => {
      // Someone eleventh in line does not need a figure. They need to know it
      // is worth doing something else.
      expect(estimateWait(40, 0, 4)).toBe('a while');
    });

    it('a bigger stage clears the queue faster', () => {
      // Slots turn over in parallel, so this is not cosmetic.
      const small = estimateWait(8, 0, 1);
      const large = estimateWait(8, 0, 8);
      expect(small).not.toBe(large);
    });

    it('discounts places that are already free', () => {
      const noSlots = estimateWait(3, 0, 4);
      const someFree = estimateWait(3, 2, 4);
      expect(someFree).not.toBe('a while');
      expect(noSlots).toBeTruthy();
    });
  });

  // =========================================================================
  describe('what each state tells the person', () => {
    const STATES: SpeakingState[] = ['listening', 'waiting', 'next', 'speaking'];

    it('every state explains who can hear them', () => {
      // The UX rule for the whole product: every interaction answers who can
      // see me, who can hear me, and what happens next.
      for (const state of STATES) {
        expect(STATE_COPY[state].means.length).toBeGreaterThan(15);
      }
    });

    it('LISTENING SAYS PLAINLY THAT NOBODY CAN HEAR YOU', () => {
      // The single most important sentence in the product. Someone who is not
      // certain of it will not relax, and not relaxing is the whole failure
      // mode this room design exists to avoid.
      expect(STATE_COPY.listening.means).toMatch(/silent|hear the room/i);
    });

    it('speaking says plainly that everyone can', () => {
      expect(STATE_COPY.speaking.means).toMatch(/everyone/i);
    });

    it('waiting makes clear the hand is up but the mic is not', () => {
      expect(STATE_COPY.waiting.means).toMatch(/nobody can hear you/i);
    });
  });
});
