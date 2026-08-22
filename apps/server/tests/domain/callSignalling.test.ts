import { describe, expect, it } from 'vitest';
import {
  canAcceptCall,
  canStartRinging,
} from '../../src/domain/rules/trustLadder.js';
import {
  CALL_MAX_DURATION_MS,
  CALL_RING_TIMEOUT_MS,
  isCallAbandoned,
  isRingStale,
  type Relationship,
} from '../../src/domain/entities/Relationship.js';
import { asUserId } from '../../src/domain/values/ids.js';

/**
 * CALL SIGNALLING — the rules that decide who is ringing whom.
 *
 * WHY THIS IS SEPARATE FROM THE LADDER TESTS
 * ------------------------------------------
 * `canInviteToCall` answers a question about a RELATIONSHIP: are these two
 * people allowed to talk 1:1 at all? That is a trust question and it is tested
 * alongside the other rungs.
 *
 * These rules answer a question about a MOMENT: is a call already happening, is
 * one being offered right now, and to whom. Two people can be perfectly
 * entitled to call each other and still be unable to start one because they are
 * already in it.
 *
 * THE TWO FAILURES THESE RULES EXIST TO PREVENT
 * ---------------------------------------------
 *   1. SELF-ACCEPT. Nothing in the state machine alone stops the person who
 *      dialled from also "accepting". If they could, the server would emit
 *      `call:accepted` to the other party and their client would join a call
 *      they never answered. A ringing phone is consent-neutral; picking it up
 *      is the consent, and only the person being rung can give it.
 *
 *   2. THE PERMANENT LOCK. `call_open` is set when the phone starts ringing.
 *      If the caller's browser dies mid-ring, nothing sends the hang-up, and
 *      without a staleness rule the pair is stuck in `call_open` forever —
 *      unable to call each other again, with no way back short of a database
 *      edit. An unanswered call has to become a MISSED call on its own.
 */

const ALICE = asUserId('11111111-1111-4111-8111-111111111111');
const BOB = asUserId('22222222-2222-4222-8222-222222222222');

const T0 = new Date('2025-06-01T12:00:00.000Z');
const at = (msAfterT0: number) => new Date(T0.getTime() + msAfterT0);

const rel = (over: Partial<Relationship> = {}): Relationship => ({
  userA: ALICE,
  userB: BOB,
  state: 'dm_open',
  requestedBy: null,
  blockedBy: null,
  updatedAt: T0,
  ...over,
});

/** A call Alice started, ringing at Bob, placed at T0. */
const ringing = (over: Partial<Relationship> = {}): Relationship =>
  rel({ state: 'call_open', requestedBy: ALICE, ...over });

/**
 * A call that was ANSWERED at T0 and is now in progress.
 *
 * The only thing distinguishing it from a ringing one is that `requestedBy` is
 * cleared — there is no longer anyone waiting for an answer.
 */
const connected = (over: Partial<Relationship> = {}): Relationship =>
  rel({ state: 'call_open', requestedBy: null, ...over });

describe('call signalling', () => {
  // -------------------------------------------------------------------------
  describe('isRingStale', () => {
    it('a call placed just now is live', () => {
      expect(isRingStale(ringing(), at(0))).toBe(false);
    });

    it('is still live one millisecond before the timeout', () => {
      expect(isRingStale(ringing(), at(CALL_RING_TIMEOUT_MS - 1))).toBe(false);
    });

    it('is stale once the timeout has elapsed', () => {
      expect(isRingStale(ringing(), at(CALL_RING_TIMEOUT_MS))).toBe(true);
    });

    it('says nothing about a pair that is not on a call', () => {
      // A relationship sitting at dm_open for a year is not a "stale ring".
      expect(isRingStale(rel({ updatedAt: T0 }), at(CALL_RING_TIMEOUT_MS * 1000))).toBe(false);
    });

    it('A CONNECTED CALL NEVER LOOKS LIKE A STALE RING', () => {
      // The bug this prevents: a real conversation passing the sixty-second
      // mark and becoming re-dialable, so the other party's phone rings while
      // they are already talking to the person ringing them.
      expect(isRingStale(connected(), at(CALL_RING_TIMEOUT_MS * 10))).toBe(false);
    });

    it('rings for long enough for a person to reach their phone', () => {
      // Not an implementation detail: a 5-second timeout would make the
      // feature useless, and a 10-minute one would keep a pair locked.
      expect(CALL_RING_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
      expect(CALL_RING_TIMEOUT_MS).toBeLessThanOrEqual(120_000);
    });
  });

  // -------------------------------------------------------------------------
  describe('isCallAbandoned', () => {
    it('a call in progress is not abandoned', () => {
      expect(isCallAbandoned(connected(), at(CALL_MAX_DURATION_MS - 1))).toBe(false);
    });

    it('IS abandoned once it has run past every plausible conversation', () => {
      // Both browsers died mid-call. Without this the pair is locked out of
      // calling each other forever by the very mechanism meant to protect them.
      expect(isCallAbandoned(connected(), at(CALL_MAX_DURATION_MS))).toBe(true);
    });

    it('a call still ringing is never "abandoned" — that is the ring timeout', () => {
      expect(isCallAbandoned(ringing(), at(CALL_MAX_DURATION_MS * 2))).toBe(false);
    });

    it('outlasts any real conversation before giving up on it', () => {
      expect(CALL_MAX_DURATION_MS).toBeGreaterThan(CALL_RING_TIMEOUT_MS);
      expect(CALL_MAX_DURATION_MS).toBeGreaterThanOrEqual(60 * 60 * 1000);
    });
  });

  // -------------------------------------------------------------------------
  describe('canStartRinging', () => {
    it('allows a call when the pair is simply talking', () => {
      expect(canStartRinging(rel(), at(0)).allowed).toBe(true);
    });

    it('REFUSES to ring someone already on a call', () => {
      const d = canStartRinging(ringing(), at(1_000));
      expect(d.allowed).toBe(false);
      expect(d.reason).toBe('call_busy');
    });

    it('allows a fresh call once an unanswered one has gone stale', () => {
      // This is the lock-recovery path. Without it, one dead browser ends the
      // pair's ability to call each other permanently.
      expect(canStartRinging(ringing(), at(CALL_RING_TIMEOUT_MS + 1)).allowed).toBe(true);
    });

    it('REFUSES to ring into a call that is already connected', () => {
      const d = canStartRinging(connected(), at(CALL_RING_TIMEOUT_MS * 10));
      expect(d.allowed).toBe(false);
      expect(d.reason).toBe('call_busy');
    });

    it('recovers a call that was answered and never hung up', () => {
      expect(canStartRinging(connected(), at(CALL_MAX_DURATION_MS)).allowed).toBe(true);
    });

    it('refuses when there is no open conversation to call within', () => {
      const d = canStartRinging(rel({ state: 'dm_requested' }), at(0));
      expect(d.allowed).toBe(false);
      expect(d.reason).toBe('dm_not_open');
    });

    it('refuses on a block', () => {
      const d = canStartRinging(rel({ state: 'blocked', blockedBy: BOB }), at(0));
      expect(d.allowed).toBe(false);
      expect(d.reason).toBe('blocked');
    });
  });

  // -------------------------------------------------------------------------
  describe('canAcceptCall', () => {
    it('lets the person being rung pick up', () => {
      expect(canAcceptCall(ringing(), BOB, at(2_000)).allowed).toBe(true);
    });

    it('DOES NOT LET THE CALLER ACCEPT THEIR OWN CALL', () => {
      const d = canAcceptCall(ringing(), ALICE, at(2_000));
      expect(d.allowed).toBe(false);
      expect(d.reason).toBe('no_pending_call');
    });

    it('refuses when nobody is ringing', () => {
      const d = canAcceptCall(rel({ state: 'dm_open' }), BOB, at(0));
      expect(d.allowed).toBe(false);
      expect(d.reason).toBe('no_pending_call');
    });

    it('refuses a ring that has already timed out', () => {
      // Answering a call that stopped ringing four minutes ago would drop the
      // other person into audio they had given up on.
      const d = canAcceptCall(ringing(), BOB, at(CALL_RING_TIMEOUT_MS + 1));
      expect(d.allowed).toBe(false);
      expect(d.reason).toBe('no_pending_call');
    });

    it('refuses to re-answer a call that is already connected', () => {
      const d = canAcceptCall(connected(), BOB, at(1_000));
      expect(d.allowed).toBe(false);
      expect(d.reason).toBe('no_pending_call');
    });

    it('refuses when the initiator was somehow not recorded', () => {
      // Defensive: a call_open row with no initiator cannot prove consent in
      // either direction, so it grants nothing to anyone.
      const d = canAcceptCall(ringing({ requestedBy: null }), BOB, at(0));
      expect(d.allowed).toBe(false);
      expect(d.reason).toBe('no_pending_call');
    });
  });
});
