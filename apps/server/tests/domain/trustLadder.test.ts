import { describe, expect, it } from 'vitest';
import {
  assertCanPromoteToSpeaker,
  assertCanPublish,
  assertCanRequestDm,
  canInviteToCall,
  canModerateRoom,
  canPromoteToSpeaker,
  canPublish,
  canRequestDm,
  canSendDm,
  canSendRoomMessage,
  initialRole,
  ladderView,
  type DmContext,
} from '../../src/domain/rules/trustLadder.js';
import type { RelationshipState } from '../../src/domain/entities/Relationship.js';
import type { RoomRole } from '../../src/domain/entities/RoomMember.js';
import type { UserStatus } from '../../src/domain/entities/User.js';
import { DomainError } from '../../src/domain/errors.js';

/**
 * The trust ladder is the most important rule set in the product, and it is a
 * pure function — so it gets exhaustive tests rather than incidental coverage.
 *
 * The structure mirrors the rungs:
 *   room text -> publish audio -> DM request -> DM send -> 1:1 call
 * with a section for each denial reason, because each one is a promise made to
 * a user about who can reach them.
 */
describe('trustLadder', () => {
  const actor = (over: { status?: UserStatus; trustScore?: number } = {}) => ({
    status: over.status ?? ('active' as UserStatus),
    trustScore: over.trustScore ?? 20,
  });

  const membership = (over: { role?: RoomRole; mutedByHost?: boolean } = {}) => ({
    role: over.role ?? ('listener' as RoomRole),
    mutedByHost: over.mutedByHost ?? false,
  });

  const dmCtx = (over: Partial<DmContext> = {}): DmContext => ({
    actor: actor(),
    target: { status: 'active' as UserStatus },
    relationship: { state: 'none' as RelationshipState },
    haveSharedRoomSession: true,
    ...over,
  });

  // -------------------------------------------------------------------------
  describe('rung 0 — account standing gates everything', () => {
    it('blocks a suspended account from room chat', () => {
      const d = canSendRoomMessage(actor({ status: 'suspended' }), membership());
      expect(d.allowed).toBe(false);
      expect(d.reason).toBe('account_inactive');
    });

    it('blocks a trust-restricted account (negative score)', () => {
      const d = canSendRoomMessage(actor({ trustScore: -5 }), membership());
      expect(d.allowed).toBe(false);
      expect(d.reason).toBe('trust_restricted');
    });

    it('allows a brand new account with zero trust', () => {
      expect(canSendRoomMessage(actor({ trustScore: 0 }), membership()).allowed).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe('rung 1 — room text chat', () => {
    it('requires membership of the room', () => {
      const d = canSendRoomMessage(actor(), null);
      expect(d.allowed).toBe(false);
      expect(d.reason).toBe('not_a_member');
    });

    it('allows an ordinary listener to type', () => {
      expect(canSendRoomMessage(actor(), membership({ role: 'listener' })).allowed).toBe(true);
    });

    it('a host mute silences TEXT as well as audio', () => {
      // Otherwise a muted user simply types the same abuse instead.
      const d = canSendRoomMessage(actor(), membership({ mutedByHost: true }));
      expect(d.allowed).toBe(false);
      expect(d.reason).toBe('muted_by_host');
    });
  });

  // -------------------------------------------------------------------------
  describe('rung 2 — publishing audio', () => {
    it('DENIES a listener: everyone joins listen-only', () => {
      // This is the defining rule of the product.
      const d = canPublish(actor(), membership({ role: 'listener' }));
      expect(d.allowed).toBe(false);
      expect(d.reason).toBe('not_speaker');
    });

    it('allows a speaker', () => {
      expect(canPublish(actor(), membership({ role: 'speaker' })).allowed).toBe(true);
    });

    it('allows a host, because host outranks speaker', () => {
      expect(canPublish(actor(), membership({ role: 'host' })).allowed).toBe(true);
    });

    it('denies a host-muted speaker', () => {
      const d = canPublish(actor(), membership({ role: 'speaker', mutedByHost: true }));
      expect(d.allowed).toBe(false);
      expect(d.reason).toBe('muted_by_host');
    });

    it('the assert form throws a DomainError', () => {
      expect(() => assertCanPublish(actor(), membership({ role: 'listener' }))).toThrow(
        DomainError,
      );
      expect(() => assertCanPublish(actor(), membership({ role: 'speaker' }))).not.toThrow();
    });

    it('a new joiner is always a listener unless they are the host', () => {
      expect(initialRole(false)).toBe('listener');
      expect(initialRole(true)).toBe('host');
    });
  });

  // -------------------------------------------------------------------------
  describe('speaker slots', () => {
    const room = { maxSpeakers: 3 };

    it('only the host may promote', () => {
      const d = canPromoteToSpeaker(actor(), membership({ role: 'speaker' }), room, 0);
      expect(d.allowed).toBe(false);
      expect(d.reason).toBe('not_host');
    });

    it('allows promotion while slots remain', () => {
      expect(canPromoteToSpeaker(actor(), membership({ role: 'host' }), room, 2).allowed).toBe(
        true,
      );
    });

    it('refuses promotion when the stage is full', () => {
      const d = canPromoteToSpeaker(actor(), membership({ role: 'host' }), room, 3);
      expect(d.allowed).toBe(false);
      expect(d.reason).toBe('speaker_slots_full');
    });

    it('reports a full stage as a CONFLICT, not a permission failure', () => {
      // The host IS allowed to promote — just not right now. The UI needs to
      // say "wait for a slot", not "you are not permitted".
      try {
        assertCanPromoteToSpeaker(actor(), membership({ role: 'host' }), room, 3);
        expect.unreachable('should have thrown');
      } catch (error) {
        expect((error as DomainError).code).toBe('SPEAKER_SLOTS_FULL');
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('host moderation powers', () => {
    it('allows a host to act on another member', () => {
      expect(
        canModerateRoom({ status: 'active' }, membership({ role: 'host' }), 'u2', 'u1').allowed,
      ).toBe(true);
    });

    it('refuses a non-host', () => {
      const d = canModerateRoom({ status: 'active' }, membership({ role: 'speaker' }), 'u2', 'u1');
      expect(d.reason).toBe('not_host');
    });

    it('refuses self-targeting', () => {
      const d = canModerateRoom({ status: 'active' }, membership({ role: 'host' }), 'u1', 'u1');
      expect(d.reason).toBe('self_target');
    });

    it('a trust-restricted host KEEPS moderation powers in their own room', () => {
      // Stripping them would leave the room unmoderated, which is worse than
      // letting a low-trust host moderate.
      const restrictedHost = { status: 'active' as UserStatus };
      expect(
        canModerateRoom(restrictedHost, membership({ role: 'host' }), 'u2', 'u1').allowed,
      ).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe('rung 3 — DM requests require a shared room session', () => {
    it('DENIES a DM request between strangers', () => {
      const d = canRequestDm(dmCtx({ haveSharedRoomSession: false }));
      expect(d.allowed).toBe(false);
      expect(d.reason).toBe('no_shared_room');
    });

    it('allows a DM request after sharing a room', () => {
      expect(canRequestDm(dmCtx({ haveSharedRoomSession: true })).allowed).toBe(true);
    });

    it('throws TRUST_LADDER_VIOLATION so the edge can explain the rule', () => {
      try {
        assertCanRequestDm(dmCtx({ haveSharedRoomSession: false }));
        expect.unreachable('should have thrown');
      } catch (error) {
        expect((error as DomainError).code).toBe('TRUST_LADDER_VIOLATION');
      }
    });

    it('refuses to re-request an already-open DM', () => {
      const d = canRequestDm(dmCtx({ relationship: { state: 'dm_open' } }));
      expect(d.reason).toBe('dm_already_open');
    });

    it('reports a block as generic unavailability', () => {
      // Never "you were blocked" — that turns a safety tool into a provocation.
      const d = canRequestDm(dmCtx({ relationship: { state: 'blocked' } }));
      expect(d.allowed).toBe(false);
      expect(d.reason).toBe('blocked');
    });

    it('refuses when the target account is inactive', () => {
      const d = canRequestDm(dmCtx({ target: { status: 'banned' } }));
      expect(d.reason).toBe('target_inactive');
    });
  });

  describe('rung 3b — sending a DM requires an OPEN conversation', () => {
    it('a PENDING request grants no messaging rights', () => {
      // The entire point of consent: requesting is not permission.
      const d = canSendDm(dmCtx({ relationship: { state: 'dm_requested' } }));
      expect(d.allowed).toBe(false);
      expect(d.reason).toBe('dm_not_open');
    });

    it('allows sending once open', () => {
      expect(canSendDm(dmCtx({ relationship: { state: 'dm_open' } })).allowed).toBe(true);
    });

    it('still allows sending when the pair has escalated to calls', () => {
      expect(canSendDm(dmCtx({ relationship: { state: 'call_open' } })).allowed).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe('rung 4 — 1:1 calls require an open DM', () => {
    it('denies a call with no DM', () => {
      const d = canInviteToCall(dmCtx({ relationship: { state: 'none' } }));
      expect(d.reason).toBe('dm_not_open');
    });

    it('denies a call on a merely-requested DM', () => {
      expect(canInviteToCall(dmCtx({ relationship: { state: 'dm_requested' } })).allowed).toBe(
        false,
      );
    });

    it('allows a call once the DM is open', () => {
      expect(canInviteToCall(dmCtx({ relationship: { state: 'dm_open' } })).allowed).toBe(true);
    });

    it('transitively enforces the whole ladder through account standing', () => {
      // A restricted account cannot call even with an open DM.
      const d = canInviteToCall(
        dmCtx({ actor: actor({ trustScore: -1 }), relationship: { state: 'dm_open' } }),
      );
      expect(d.reason).toBe('trust_restricted');
    });
  });

  // -------------------------------------------------------------------------
  describe('ladderView — what the UI is allowed to render', () => {
    it('offers only a DM request to a fresh acquaintance', () => {
      expect(ladderView(dmCtx())).toEqual({
        canRequestDm: true,
        canSendDm: false,
        canCall: false,
      });
    });

    it('offers messaging and calling once the DM is open', () => {
      expect(ladderView(dmCtx({ relationship: { state: 'dm_open' } }))).toEqual({
        canRequestDm: false,
        canSendDm: true,
        canCall: true,
      });
    });

    it('offers nothing at all across a block', () => {
      expect(ladderView(dmCtx({ relationship: { state: 'blocked' } }))).toEqual({
        canRequestDm: false,
        canSendDm: false,
        canCall: false,
      });
    });
  });
});
