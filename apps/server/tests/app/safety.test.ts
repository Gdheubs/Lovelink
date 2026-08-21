import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryPorts, type MemoryPorts } from '../../src/adapters/memory/index.js';
import { createUseCases, type UseCases } from '../../src/app/index.js';
import type { User } from '../../src/domain/entities/User.js';
import type { RoomId } from '../../src/domain/values/ids.js';
import { asUserId } from '../../src/domain/values/ids.js';
import { LIMITS } from '../../src/domain/ports/RateLimiter.js';
import { TRUST_DELTAS } from '../../src/domain/values/trust.js';
import type { DomainError } from '../../src/domain/errors.js';

/**
 * Phase 4 — the safety baseline.
 *
 * This is the part of the system that has to work when someone is having the
 * worst experience the product can produce. The tests are weighted accordingly:
 * more of them are about what must NOT happen (a reporter being exposed, a ban
 * that a token outlives, a block the other party is told about) than about the
 * happy path.
 */
describe('safety', () => {
  let ports: MemoryPorts;
  let useCases: UseCases;

  let moderator: User;
  let host: User;
  let alice: User;
  let mallory: User;
  let roomId: RoomId;

  const makeUser = async (name: string): Promise<User> => {
    const user = await ports.users.create({
      id: asUserId(ports.ids.uuid()),
      identifier: `${name.toLowerCase()}@example.com`,
      identifierKind: 'email',
      displayName: name,
      avatarSeed: `seed-${name}`,
      dob: new Date('1995-01-01T00:00:00.000Z'),
      createdAt: ports.clock.now(),
    });

    // Mirrors registration: the `account_created` ledger entry carries the
    // starting balance, without which a fixture user is one kick from being
    // restricted — a state no real account is ever in.
    await ports.users.appendTrustEvent({
      userId: user.id,
      delta: TRUST_DELTAS.account_created,
      reason: 'account_created',
      context: null,
      createdAt: ports.clock.now(),
    });

    return (await ports.users.findById(user.id)) ?? user;
  };

  beforeEach(async () => {
    ports = createMemoryPorts({ presenceTtlSeconds: 60 });

    // The moderator has to exist before the use cases are built, because the
    // allowlist is config — which is the whole point of it being config.
    moderator = await ports.users.create({
      id: asUserId(ports.ids.uuid()),
      identifier: 'mod@example.com',
      identifierKind: 'email',
      displayName: 'Mod',
      avatarSeed: 'seed-mod',
      dob: new Date('1990-01-01T00:00:00.000Z'),
      createdAt: ports.clock.now(),
    });

    useCases = createUseCases(ports, {
      echoLoginCode: true,
      moderatorUserIds: [moderator.id],
    });

    host = await makeUser('Hosty');
    alice = await makeUser('Alice');
    mallory = await makeUser('Mallory');

    const room = await useCases.createRoom.execute(host, {
      title: 'Safety Room',
      category: 'casual',
    });
    roomId = room.id;

    await useCases.joinRoom.execute(host, roomId);
    await useCases.joinRoom.execute(alice, roomId);
    await useCases.joinRoom.execute(mallory, roomId);
    ports.recorder.clear();
  });

  // -------------------------------------------------------------------------
  describe('submitting a report', () => {
    it('records it and tells nobody but the reporter', async () => {
      const report = await useCases.submitReport.execute(alice, {
        targetId: mallory.id,
        roomId,
        category: 'harassment',
        note: 'kept talking over everyone',
      });

      expect(report.status).toBe('open');
      expect(report.targetId).toBe(mallory.id);

      // THE TARGET IS NEVER TOLD. Retaliation against a reporter is the most
      // predictable consequence of leaking this.
      expect(ports.recorder.emissionsToUser(mallory.id)).toHaveLength(0);
      expect(ports.recorder.emissionsTo(roomId)).toHaveLength(0);
    });

    it('refuses a self-report', async () => {
      await expect(
        useCases.submitReport.execute(alice, { targetId: alice.id, category: 'spam' }),
      ).rejects.toThrow(/yourself/i);
    });

    it('refuses an unknown category', async () => {
      await expect(
        useCases.submitReport.execute(alice, { targetId: mallory.id, category: 'vibes' }),
      ).rejects.toThrow(/reason/i);
    });

    it('allows ONE open report per target, then refuses duplicates', async () => {
      await useCases.submitReport.execute(alice, { targetId: mallory.id, category: 'spam' });

      await expect(
        useCases.submitReport.execute(alice, { targetId: mallory.id, category: 'harassment' }),
      ).rejects.toThrow(/already have a report open/i);
    });

    it('NEVER suppresses an urgent report behind the duplicate rule', async () => {
      // Blocking a child-safety report because a spam report is open would be
      // indefensible.
      await useCases.submitReport.execute(alice, { targetId: mallory.id, category: 'spam' });

      await expect(
        useCases.submitReport.execute(alice, { targetId: mallory.id, category: 'minor_safety' }),
      ).resolves.toBeTruthy();
      await expect(
        useCases.submitReport.execute(alice, { targetId: mallory.id, category: 'self_harm' }),
      ).resolves.toBeTruthy();
    });

    it('allows a new report once the previous is resolved', async () => {
      const first = await useCases.submitReport.execute(alice, {
        targetId: mallory.id,
        category: 'spam',
      });
      await useCases.resolveReport.execute(moderator.id, {
        reportId: first.id,
        outcome: 'dismissed',
        resolution: 'not a violation',
      });

      await expect(
        useCases.submitReport.execute(alice, { targetId: mallory.id, category: 'harassment' }),
      ).resolves.toBeTruthy();
    });

    it('is rate limited', async () => {
      for (let i = 0; i < LIMITS.reportSubmit.limit; i += 1) {
        const target = await makeUser(`Target${i}`);
        await useCases.submitReport.execute(alice, { targetId: target.id, category: 'spam' });
      }
      const extra = await makeUser('OneMore');
      await expect(
        useCases.submitReport.execute(alice, { targetId: extra.id, category: 'spam' }),
      ).rejects.toThrow(/several reports/i);
    });

    it('rejects a note containing a bidi override', async () => {
      await expect(
        useCases.submitReport.execute(alice, {
          targetId: mallory.id,
          category: 'harassment',
          note: `looks fine${String.fromCodePoint(0x202e)}but is not`,
        }),
      ).rejects.toThrow(/not allowed/i);
    });
  });

  // -------------------------------------------------------------------------
  describe('the moderation queue', () => {
    beforeEach(async () => {
      await useCases.submitReport.execute(alice, {
        targetId: mallory.id,
        roomId,
        category: 'harassment',
        note: 'abusive',
      });
    });

    it('is moderator-only', async () => {
      await expect(useCases.listReportQueue.execute(alice.id)).rejects.toThrow(/moderator/i);
    });

    it('carries the target history a decision actually needs', async () => {
      const queue = await useCases.listReportQueue.execute(moderator.id);

      expect(queue).toHaveLength(1);
      expect(queue[0]?.targetDisplayName).toBe('Mallory');
      expect(queue[0]?.reporterDisplayName).toBe('Alice');
      expect(queue[0]?.targetHistory.length).toBeGreaterThan(0);
    });

    it('puts URGENT categories first regardless of age', async () => {
      const other = await makeUser('Other');
      await useCases.submitReport.execute(other, {
        targetId: mallory.id,
        category: 'minor_safety',
      });

      const queue = await useCases.listReportQueue.execute(moderator.id);
      expect(queue[0]?.report.category).toBe('minor_safety');
    });

    it('claiming marks it in review', async () => {
      const [queued] = await useCases.listReportQueue.execute(moderator.id);
      const claimed = await useCases.claimReport.execute(moderator.id, queued!.report.id);

      expect(claimed.status).toBe('reviewing');
      expect(claimed.reviewedBy).toBe(moderator.id);
    });
  });

  // -------------------------------------------------------------------------
  describe('resolving a report', () => {
    let reportId: string;

    beforeEach(async () => {
      const report = await useCases.submitReport.execute(alice, {
        targetId: mallory.id,
        category: 'harassment',
        note: 'abusive',
      });
      reportId = report.id;
    });

    it('upholding applies a trust penalty', async () => {
      await useCases.resolveReport.execute(moderator.id, {
        reportId: reportId as never,
        outcome: 'upheld',
        resolution: 'confirmed from the audio clip',
      });

      const events = await ports.users.listTrustEvents(mallory.id, 10);
      expect(events.some((e) => e.reason === 'report_upheld')).toBe(true);
      expect((await ports.users.findById(mallory.id))!.trustScore).toBeLessThan(0);
    });

    it('DISMISSING costs the target nothing', async () => {
      // If dismissed reports quietly damaged standing, being reported unfairly
      // would still hurt — which is what a harassment campaign wants.
      const before = (await ports.users.findById(mallory.id))!.trustScore;

      await useCases.resolveReport.execute(moderator.id, {
        reportId: reportId as never,
        outcome: 'dismissed',
        resolution: 'nothing in the recording',
      });

      expect((await ports.users.findById(mallory.id))!.trustScore).toBe(before);
    });

    it('requires a stated reason', async () => {
      await expect(
        useCases.resolveReport.execute(moderator.id, {
          reportId: reportId as never,
          outcome: 'upheld',
          resolution: '   ',
        }),
      ).rejects.toThrow(/why/i);
    });

    it('refuses to re-resolve', async () => {
      await useCases.resolveReport.execute(moderator.id, {
        reportId: reportId as never,
        outcome: 'dismissed',
        resolution: 'no',
      });

      await expect(
        useCases.resolveReport.execute(moderator.id, {
          reportId: reportId as never,
          outcome: 'upheld',
          resolution: 'changed my mind',
        }),
      ).rejects.toThrow(/already been resolved/i);
    });

    it('is moderator-only', async () => {
      await expect(
        useCases.resolveReport.execute(alice.id, {
          reportId: reportId as never,
          outcome: 'dismissed',
          resolution: 'clearing my own report',
        }),
      ).rejects.toThrow(/moderator/i);
    });
  });

  // -------------------------------------------------------------------------
  describe('banning', () => {
    it('records, revokes every session, and severs the socket', async () => {
      // The three things a ban must be.
      const token = await ports.tokens.issueAccessToken(mallory.id, 'session-1');
      ports.recorder.connect(mallory.id);

      await useCases.banUser.execute(moderator.id, {
        targetId: mallory.id,
        reason: 'harassment',
        hours: null,
      });

      // 1. Durable record + cached status.
      expect(await ports.reports.findActiveBan(mallory.id, ports.clock.now())).not.toBeNull();
      expect((await ports.users.findById(mallory.id))!.status).toBe('banned');

      // 2. Credentials dead — otherwise the refresh token outlives the ban by
      //    thirty days.
      expect(await ports.tokens.verifyAccessToken(token.token)).toBeNull();

      // 3. Ejected now.
      expect(ports.recorder.disconnected.some((d) => d.userId === mallory.id)).toBe(true);
    });

    it('removes them from every room and cuts the audio', async () => {
      await useCases.approveSpeaker.execute(host, { roomId, userId: mallory.id });
      ports.media.revocations.length = 0;

      await useCases.banUser.execute(moderator.id, {
        targetId: mallory.id,
        reason: 'abuse',
        hours: null,
      });

      expect(await ports.presence.getMember(roomId, mallory.id)).toBeNull();
      // The room going quiet is not the same as the name disappearing.
      expect(ports.media.revocations.some((r) => r.userId === mallory.id)).toBe(true);
      expect(ports.media.removals.some((r) => r.userId === mallory.id)).toBe(true);
    });

    it('publishes to the bus so other processes can sever their sockets', async () => {
      await useCases.banUser.execute(moderator.id, {
        targetId: mallory.id,
        reason: 'abuse',
        hours: null,
      });

      expect(
        ports.bus.published.some(
          (p) => p.event.type === 'user.banned' && p.channel === 'moderation',
        ),
      ).toBe(true);
    });

    it('a temporary ban expires on its own', async () => {
      await useCases.banUser.execute(moderator.id, {
        targetId: mallory.id,
        reason: 'cooling off',
        hours: 24,
      });
      expect((await ports.users.findById(mallory.id))!.status).toBe('suspended');

      ports.clock.advanceMs(25 * 60 * 60 * 1000);
      expect(await ports.reports.findActiveBan(mallory.id, ports.clock.now())).toBeNull();
    });

    it('is moderator-only', async () => {
      try {
        await useCases.banUser.execute(alice.id, {
          targetId: mallory.id,
          reason: 'I do not like them',
          hours: null,
        });
        expect.unreachable('a normal user must not be able to ban');
      } catch (error) {
        expect((error as DomainError).code).toBe('FORBIDDEN');
      }
      expect((await ports.users.findById(mallory.id))!.status).toBe('active');
    });

    it('refuses to ban another moderator through this interface', async () => {
      const second = await makeUser('Mod2');
      const twoMods = createUseCases(ports, {
        echoLoginCode: true,
        moderatorUserIds: [moderator.id, second.id],
      });

      await expect(
        twoMods.banUser.execute(moderator.id, {
          targetId: second.id,
          reason: 'disagreement',
          hours: null,
        }),
      ).rejects.toThrow(/Moderators cannot be banned/i);
    });

    it('lifting a ban RESTORES the account', async () => {
      await useCases.banUser.execute(moderator.id, {
        targetId: mallory.id,
        reason: 'mistake',
        hours: null,
      });
      await useCases.liftBan.execute(moderator.id, mallory.id);

      expect((await ports.users.findById(mallory.id))!.status).toBe('active');
      expect(await ports.reports.findActiveBan(mallory.id, ports.clock.now())).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe('kicking', () => {
    it('removes the person from the room but NOT from the platform', async () => {
      await useCases.kickUser.execute(host, { roomId, userId: mallory.id });

      expect(await ports.presence.getMember(roomId, mallory.id)).toBeNull();
      // Still a normal account: a host runs a room, a moderator runs the
      // platform.
      expect((await ports.users.findById(mallory.id))!.status).toBe('active');
    });

    it('tells the kicked user specifically', async () => {
      await useCases.kickUser.execute(host, { roomId, userId: mallory.id });
      expect(ports.recorder.emissionsToUser(mallory.id, 'room:kicked')).toHaveLength(1);
    });

    it('cuts their audio', async () => {
      await useCases.approveSpeaker.execute(host, { roomId, userId: mallory.id });
      ports.media.revocations.length = 0;

      await useCases.kickUser.execute(host, { roomId, userId: mallory.id });
      expect(ports.media.revocations.some((r) => r.userId === mallory.id)).toBe(true);
    });

    it('is HOST ONLY', async () => {
      await expect(
        useCases.kickUser.execute(alice, { roomId, userId: mallory.id }),
      ).rejects.toThrow(/only the host/i);
      expect(await ports.presence.getMember(roomId, mallory.id)).not.toBeNull();
    });

    it('earns no session credit', async () => {
      // A long session, with both clients heartbeating as real ones do — the
      // presence TTL is 60s, so simply advancing the clock would lapse them
      // both and the kick would fail for an unrelated reason.
      for (let minute = 0; minute < 10; minute += 1) {
        ports.clock.advanceSeconds(30);
        await useCases.heartbeat.execute({ userId: host.id, claimedRooms: [roomId] });
        await useCases.heartbeat.execute({ userId: mallory.id, claimedRooms: [roomId] });
      }

      await useCases.kickUser.execute(host, { roomId, userId: mallory.id });

      const events = await ports.users.listTrustEvents(mallory.id, 10);
      expect(events.some((e) => e.reason === 'room_session_completed')).toBe(false);
      expect(events.some((e) => e.reason === 'kicked_from_room')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe('blocking', () => {
    it('is MUTUAL', async () => {
      // A one-way block leaves the blocked person able to watch and follow —
      // exactly what the button is reached for to stop.
      await useCases.blockUser.execute(alice, mallory.id);

      expect(await ports.relationships.listBlockedIds(alice.id)).toContain(mallory.id);
      expect(await ports.relationships.listBlockedIds(mallory.id)).toContain(alice.id);
    });

    it('is SILENT — the blocked party is never told', async () => {
      ports.recorder.clear();
      await useCases.blockUser.execute(alice, mallory.id);

      expect(ports.recorder.emissions).toHaveLength(0);
    });

    it('hides each from the other in the room snapshot', async () => {
      await useCases.sendChatMessage.execute(mallory, { roomId, text: 'hello everyone' });
      await useCases.blockUser.execute(alice, mallory.id);

      const { state } = await useCases.joinRoom.execute(alice, roomId);
      expect(state.members.map((m) => m.user.id)).not.toContain(mallory.id);
      expect(state.recentMessages.some((m) => m.from.id === mallory.id)).toBe(false);
    });

    it('works from any state, and blocking twice is quiet', async () => {
      await useCases.blockUser.execute(alice, mallory.id);
      await expect(useCases.blockUser.execute(alice, mallory.id)).resolves.toBeUndefined();
    });

    it('refuses to block yourself', async () => {
      await expect(useCases.blockUser.execute(alice, alice.id)).rejects.toThrow(/yourself/i);
    });

    it('unblocking returns to NONE, not to the previous rung', async () => {
      // Regaining DM or call access must require fresh consent.
      await useCases.blockUser.execute(alice, mallory.id);
      await useCases.unblockUser.execute(alice, mallory.id);

      const relationship = await ports.relationships.get(alice.id, mallory.id);
      expect(relationship.state).toBe('none');
    });

    it('only the blocker can unblock', async () => {
      await useCases.blockUser.execute(alice, mallory.id);
      // Mallory tries to clear the block applied to her.
      await expect(useCases.unblockUser.execute(mallory, alice.id)).rejects.toThrow(/not found/i);

      expect(await ports.relationships.listBlockedIds(alice.id)).toContain(mallory.id);
    });
  });
});
