import { describe, expect, it } from 'vitest';
import {
  assertCanBan,
  assertCanResolveReport,
  assertCanSubmitReport,
  assertIsModerator,
  banExpiry,
  DEFAULT_TEMP_BAN_HOURS,
  isModerator,
  mustDisconnect,
  statusFromBans,
  trustDeltaForResolution,
  type ModeratorDirectory,
} from '../../src/domain/rules/moderation.js';
import type { Ban } from '../../src/domain/entities/Ban.js';
import { isActiveBan } from '../../src/domain/entities/Ban.js';
import { compareForQueue, isUrgent, type Report } from '../../src/domain/entities/Report.js';
import { asUserId } from '../../src/domain/values/ids.js';
import { DomainError } from '../../src/domain/errors.js';

describe('moderation', () => {
  const mod = asUserId('mod-1');
  const alice = asUserId('alice');
  const bob = asUserId('bob');
  const directory: ModeratorDirectory = { moderatorIds: new Set([mod]) };
  const now = new Date('2025-06-01T12:00:00.000Z');

  describe('moderator authority', () => {
    it('recognises a configured moderator', () => {
      expect(isModerator(directory, mod)).toBe(true);
      expect(isModerator(directory, alice)).toBe(false);
    });

    it('throws for a non-moderator', () => {
      expect(() => assertIsModerator(directory, alice)).toThrow(DomainError);
      expect(() => assertIsModerator(directory, mod)).not.toThrow();
    });
  });

  describe('submitting a report', () => {
    it('refuses self-reports', () => {
      expect(() =>
        assertCanSubmitReport(
          { reporterId: alice, targetId: alice, existingOpenReports: [] },
          'harassment',
        ),
      ).toThrow(/yourself/i);
    });

    it('allows a first report', () => {
      expect(() =>
        assertCanSubmitReport(
          { reporterId: alice, targetId: bob, existingOpenReports: [] },
          'harassment',
        ),
      ).not.toThrow();
    });

    it('refuses a duplicate open report against the same person', () => {
      // Without this, "report" becomes an unlimited notification generator
      // aimed at someone you dislike, and the queue becomes useless.
      expect(() =>
        assertCanSubmitReport(
          {
            reporterId: alice,
            targetId: bob,
            existingOpenReports: [{ status: 'open', category: 'spam' }],
          },
          'harassment',
        ),
      ).toThrow(/already have a report open/i);
    });

    it('allows a new report once the previous one is resolved', () => {
      expect(() =>
        assertCanSubmitReport(
          {
            reporterId: alice,
            targetId: bob,
            existingOpenReports: [{ status: 'dismissed', category: 'spam' }],
          },
          'harassment',
        ),
      ).not.toThrow();
    });

    it('NEVER suppresses an urgent report behind the duplicate rule', () => {
      // Blocking a child-safety report because a spam report is open would be
      // indefensible.
      for (const urgent of ['minor_safety', 'self_harm'] as const) {
        expect(() =>
          assertCanSubmitReport(
            {
              reporterId: alice,
              targetId: bob,
              existingOpenReports: [{ status: 'open', category: 'spam' }],
            },
            urgent,
          ),
        ).not.toThrow();
      }
    });
  });

  describe('report queue ordering', () => {
    const report = (over: Partial<Report>): Report =>
      ({
        id: asUserId('r') as never,
        reporterId: alice,
        targetId: bob,
        roomId: null,
        category: 'spam',
        note: '',
        audioRef: null,
        status: 'open',
        reviewedBy: null,
        reviewedAt: null,
        resolution: null,
        createdAt: now,
        ...over,
      }) as Report;

    it('marks the right categories urgent', () => {
      expect(isUrgent('minor_safety')).toBe(true);
      expect(isUrgent('self_harm')).toBe(true);
      expect(isUrgent('spam')).toBe(false);
    });

    it('puts an urgent report ahead of an older ordinary one', () => {
      const oldSpam = report({ category: 'spam', createdAt: new Date('2025-01-01') });
      const newUrgent = report({ category: 'minor_safety', createdAt: new Date('2025-06-01') });
      expect([oldSpam, newUrgent].sort(compareForQueue)[0]).toBe(newUrgent);
    });

    it('orders oldest first within the same urgency', () => {
      const older = report({ createdAt: new Date('2025-01-01') });
      const newer = report({ createdAt: new Date('2025-06-01') });
      expect([newer, older].sort(compareForQueue)[0]).toBe(older);
    });
  });

  describe('resolving a report', () => {
    it('allows resolving an open or in-review report', () => {
      expect(() => assertCanResolveReport({ status: 'open' })).not.toThrow();
      expect(() => assertCanResolveReport({ status: 'reviewing' })).not.toThrow();
    });

    it('refuses to re-resolve a closed report', () => {
      expect(() => assertCanResolveReport({ status: 'upheld' })).toThrow(/already been resolved/i);
      expect(() => assertCanResolveReport({ status: 'dismissed' })).toThrow(
        /already been resolved/i,
      );
    });

    it('penalises trust only when upheld', () => {
      expect(trustDeltaForResolution('upheld')).toBeLessThan(0);
      expect(trustDeltaForResolution('dismissed')).toBe(0);
    });
  });

  describe('bans', () => {
    it('refuses a ban from a non-moderator', () => {
      expect(() => assertCanBan(directory, alice, bob)).toThrow(DomainError);
    });

    it('refuses self-bans', () => {
      expect(() => assertCanBan(directory, mod, mod)).toThrow(/yourself/i);
    });

    it('refuses to ban another moderator through this interface', () => {
      // A compromised mod account must not be able to disable the team.
      const two: ModeratorDirectory = { moderatorIds: new Set([mod, alice]) };
      expect(() => assertCanBan(two, mod, alice)).toThrow(/Moderators cannot be banned/i);
    });

    it('computes a temporary expiry', () => {
      const expiry = banExpiry(now, DEFAULT_TEMP_BAN_HOURS);
      expect(expiry).not.toBeNull();
      expect(expiry!.getTime() - now.getTime()).toBe(DEFAULT_TEMP_BAN_HOURS * 3_600_000);
    });

    it('treats null hours as permanent', () => {
      expect(banExpiry(now, null)).toBeNull();
    });

    it('refuses a nonsensical duration', () => {
      expect(() => banExpiry(now, 0)).toThrow(/positive/i);
      expect(() => banExpiry(now, -5)).toThrow(/positive/i);
    });
  });

  describe('ban activity', () => {
    const ban = (over: Partial<Ban>): Ban => ({
      userId: bob,
      reason: 'test',
      expiresAt: null,
      issuedBy: mod,
      issuedAt: now,
      liftedAt: null,
      ...over,
    });

    it('a permanent, unlifted ban is active', () => {
      expect(isActiveBan(ban({}), now)).toBe(true);
    });

    it('a lifted ban is not active even if unexpired', () => {
      expect(isActiveBan(ban({ liftedAt: now }), now)).toBe(false);
    });

    it('a temporary ban expires', () => {
      const temp = ban({ expiresAt: new Date(now.getTime() + 1000) });
      expect(isActiveBan(temp, now)).toBe(true);
      expect(isActiveBan(temp, new Date(now.getTime() + 2000))).toBe(false);
    });
  });

  describe('statusFromBans — the projection onto users.status', () => {
    const permanent: Ban = {
      userId: bob,
      reason: 'x',
      expiresAt: null,
      issuedBy: mod,
      issuedAt: now,
      liftedAt: null,
    };
    const temporary: Ban = { ...permanent, expiresAt: new Date(now.getTime() + 3_600_000) };

    it('maps a permanent ban to banned', () => {
      expect(statusFromBans('active', [permanent], now)).toBe('banned');
    });

    it('maps a temporary ban to suspended', () => {
      expect(statusFromBans('active', [temporary], now)).toBe('suspended');
    });

    it('a permanent ban outranks a concurrent temporary one', () => {
      expect(statusFromBans('active', [temporary, permanent], now)).toBe('banned');
    });

    it('RESTORES the account when the last ban lifts', () => {
      // Otherwise an unbanned user stays locked out forever.
      expect(statusFromBans('banned', [{ ...permanent, liftedAt: now }], now)).toBe('active');
    });

    it('never resurrects a deleted account', () => {
      expect(statusFromBans('deleted', [], now)).toBe('deleted');
    });
  });

  describe('mustDisconnect', () => {
    it('severs banned, suspended and deleted sessions', () => {
      expect(mustDisconnect({ status: 'banned' })).toBe(true);
      expect(mustDisconnect({ status: 'suspended' })).toBe(true);
      expect(mustDisconnect({ status: 'deleted' })).toBe(true);
    });

    it('leaves active sessions alone', () => {
      expect(mustDisconnect({ status: 'active' })).toBe(false);
    });
  });
});
