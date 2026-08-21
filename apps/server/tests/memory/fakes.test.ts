import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryPorts, type MemoryPorts } from '../../src/adapters/memory/index.js';
import { asRoomId, asUserId } from '../../src/domain/values/ids.js';
import { LIMITS } from '../../src/domain/ports/RateLimiter.js';
import { ROOM_BUFFER_SIZE } from '../../src/domain/ports/MessageRepository.js';
import { MAX_CHALLENGE_ATTEMPTS } from '../../src/domain/ports/AuthChallengeStore.js';
import { asMessageId } from '../../src/domain/values/ids.js';

/**
 * Tests for the in-memory fakes themselves.
 *
 * WHY THESE EXIST
 * ---------------
 * Every use-case test in the repo runs against these fakes, so a fake that is
 * more permissive than the real adapter produces a whole suite of tests that
 * lie: green locally, broken in production. These tests pin the behaviours the
 * fakes are supposed to model faithfully — TTLs, atomicity, uniqueness
 * constraints, and bounded buffers — so the fakes cannot quietly drift into
 * being convenient rather than correct.
 *
 * The corresponding adapter integration tests assert the SAME behaviours
 * against real Postgres and Redis.
 */
describe('memory fakes', () => {
  let ports: MemoryPorts;
  const alice = asUserId('alice');
  const bob = asUserId('bob');
  const room1 = asRoomId('room-1');

  beforeEach(() => {
    ports = createMemoryPorts({ presenceTtlSeconds: 30 });
  });

  // -------------------------------------------------------------------------
  describe('MemoryClock', () => {
    it('is frozen until advanced', () => {
      const first = ports.clock.nowMs();
      expect(ports.clock.nowMs()).toBe(first);
      ports.clock.advanceSeconds(10);
      expect(ports.clock.nowMs()).toBe(first + 10_000);
    });

    it('refuses to move backwards', () => {
      expect(() => ports.clock.advanceMs(-1)).toThrow(/backwards/i);
    });
  });

  // -------------------------------------------------------------------------
  describe('MemoryUserRepository', () => {
    const create = (id: string, identifier: string) =>
      ports.users.create({
        id: asUserId(id),
        identifier,
        identifierKind: 'email',
        displayName: 'Test',
        avatarSeed: 'seed',
        dob: new Date('1995-01-01'),
        createdAt: ports.clock.now(),
      });

    it('enforces the unique index on identifier', async () => {
      await create('u1', 'a@example.com');
      await expect(create('u2', 'a@example.com')).rejects.toThrow(/already exists/i);
    });

    it('freezes returned entities so a caller cannot edit the store', async () => {
      const user = await create('u1', 'a@example.com');
      expect(Object.isFrozen(user)).toBe(true);
    });

    it('derives trust_score from the ledger rather than accepting a value', async () => {
      await create('u1', 'a@example.com');
      const id = asUserId('u1');

      await ports.users.appendTrustEvent({
        userId: id,
        delta: 3,
        reason: 'promoted_to_speaker',
        context: null,
        createdAt: ports.clock.now(),
      });
      await ports.users.appendTrustEvent({
        userId: id,
        delta: -25,
        reason: 'report_upheld',
        context: 'report-7',
        createdAt: ports.clock.now(),
      });

      const user = await ports.users.findById(id);
      expect(user?.trustScore).toBe(-22);

      // And the ledger explains it — the whole reason for the append-only design.
      const events = await ports.users.listTrustEvents(id, 10);
      expect(events).toHaveLength(2);
      expect(events.map((e) => e.reason)).toContain('report_upheld');
    });
  });

  // -------------------------------------------------------------------------
  describe('MemoryPresenceStore', () => {
    const join = (userId: string) =>
      ports.presence.setOnline({
        userId: asUserId(userId),
        roomId: room1,
        role: 'listener',
        mutedByHost: false,
      });

    it('reports live members', async () => {
      await join('alice');
      await join('bob');
      expect(await ports.presence.countRoomMembers(room1)).toBe(2);
    });

    it('EXPIRES a member who stops heartbeating', async () => {
      // The whole difficulty of presence is leaving, not joining.
      await join('alice');
      ports.clock.advanceSeconds(31);
      expect(await ports.presence.getMember(room1, alice)).toBeNull();
      expect(await ports.presence.countRoomMembers(room1)).toBe(0);
    });

    it('a heartbeat keeps a member alive', async () => {
      await join('alice');
      ports.clock.advanceSeconds(20);
      expect(await ports.presence.heartbeat(room1, alice)).toBe(true);
      ports.clock.advanceSeconds(20);
      // 40s total, but only 20s since the heartbeat.
      expect(await ports.presence.getMember(room1, alice)).not.toBeNull();
    });

    it('a heartbeat on a LAPSED entry returns false so the client re-joins', async () => {
      await join('alice');
      ports.clock.advanceSeconds(31);
      expect(await ports.presence.heartbeat(room1, alice)).toBe(false);
    });

    it('reapExpired returns what it removed, so departures can be announced', async () => {
      await join('alice');
      await join('bob');
      ports.clock.advanceSeconds(31);

      const reaped = await ports.presence.reapExpired();
      expect(reaped.map((e) => e.userId).sort()).toEqual(['alice', 'bob']);

      // Idempotent: a second sweep must not re-announce the same departures.
      expect(await ports.presence.reapExpired()).toHaveLength(0);
    });

    it('orders raised hands oldest first — the queue the host works through', async () => {
      await join('alice');
      await join('bob');

      await ports.presence.setHandRaised(room1, bob, true);
      ports.clock.advanceSeconds(1);
      await ports.presence.setHandRaised(room1, alice, true);

      const hands = await ports.presence.getRaisedHands(room1);
      expect(hands.map((h) => h.userId)).toEqual(['bob', 'alice']);
    });

    it('re-raising does not jump the queue', async () => {
      await join('alice');
      await ports.presence.setHandRaised(room1, alice, true);
      const firstRaise = (await ports.presence.getMember(room1, alice))?.handRaisedAtMs;

      ports.clock.advanceSeconds(5);
      await ports.presence.setHandRaised(room1, alice, true);
      expect((await ports.presence.getMember(room1, alice))?.handRaisedAtMs).toBe(firstRaise);
    });
  });

  // -------------------------------------------------------------------------
  describe('MemoryRoomRepository — haveSharedRoomSession', () => {
    const createRoom = (id: string) =>
      ports.rooms.create({
        id: asRoomId(id),
        slug: id,
        title: 'Test Room',
        category: 'casual',
        hostUserId: alice,
        isScheduled: false,
        scheduleCron: null,
        maxSpeakers: 4,
        status: 'live',
        createdAt: ports.clock.now(),
      });

    it('is false for two users who never met', async () => {
      await createRoom('room-1');
      expect(await ports.rooms.haveSharedRoomSession(alice, bob)).toBe(false);
    });

    it('is true while both are currently in the room', async () => {
      await createRoom('room-1');
      await ports.rooms.recordJoin({
        roomId: room1,
        userId: alice,
        role: 'host',
        joinedAt: ports.clock.now(),
        mutedByHost: false,
      });
      await ports.rooms.recordJoin({
        roomId: room1,
        userId: bob,
        role: 'listener',
        joinedAt: ports.clock.now(),
        mutedByHost: false,
      });
      expect(await ports.rooms.haveSharedRoomSession(alice, bob)).toBe(true);
    });

    it('is FALSE when they used the same room at different times', async () => {
      // This is the rule that stops anyone unlocking DMs with a stranger by
      // joining a popular room the stranger visited last week.
      await createRoom('room-1');

      const t0 = ports.clock.now();
      await ports.rooms.recordJoin({
        roomId: room1,
        userId: alice,
        role: 'listener',
        joinedAt: t0,
        mutedByHost: false,
      });
      ports.clock.advanceSeconds(60);
      await ports.rooms.recordLeave(room1, alice, ports.clock.now());

      ports.clock.advanceSeconds(60);
      await ports.rooms.recordJoin({
        roomId: room1,
        userId: bob,
        role: 'listener',
        joinedAt: ports.clock.now(),
        mutedByHost: false,
      });

      expect(await ports.rooms.haveSharedRoomSession(alice, bob)).toBe(false);
    });

    it('is true for overlapping-but-not-identical sessions', async () => {
      await createRoom('room-1');
      const t0 = ports.clock.now();
      await ports.rooms.recordJoin({
        roomId: room1,
        userId: alice,
        role: 'listener',
        joinedAt: t0,
        mutedByHost: false,
      });

      ports.clock.advanceSeconds(30);
      await ports.rooms.recordJoin({
        roomId: room1,
        userId: bob,
        role: 'listener',
        joinedAt: ports.clock.now(),
        mutedByHost: false,
      });

      ports.clock.advanceSeconds(30);
      await ports.rooms.recordLeave(room1, alice, ports.clock.now());

      expect(await ports.rooms.haveSharedRoomSession(alice, bob)).toBe(true);
    });

    it('a reconnect refreshes the open row rather than opening a second', async () => {
      await createRoom('room-1');
      const join = {
        roomId: room1,
        userId: alice,
        role: 'listener' as const,
        joinedAt: ports.clock.now(),
        mutedByHost: false,
      };
      await ports.rooms.recordJoin(join);
      await ports.rooms.recordJoin(join);

      // One open membership, not two.
      expect(await ports.rooms.findMembership(room1, alice)).not.toBeNull();
      await ports.rooms.recordLeave(room1, alice, ports.clock.now());
      expect(await ports.rooms.findMembership(room1, alice)).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe('MemoryRelationshipRepository', () => {
    it('returns `none` for an unrecorded pair rather than null', async () => {
      const rel = await ports.relationships.get(alice, bob);
      expect(rel.state).toBe('none');
    });

    it('is symmetric — one row per unordered pair', async () => {
      await ports.relationships.transition(
        alice,
        bob,
        'none',
        'dm_requested',
        { requestedBy: alice, blockedBy: null },
        ports.clock.now(),
      );

      // Reading from the other direction sees the same record.
      const reversed = await ports.relationships.get(bob, alice);
      expect(reversed.state).toBe('dm_requested');
      expect(reversed.requestedBy).toBe(alice);
    });

    it('compare-and-set refuses a stale transition', async () => {
      await ports.relationships.transition(
        alice,
        bob,
        'none',
        'blocked',
        { requestedBy: null, blockedBy: bob },
        ports.clock.now(),
      );

      // A racing "accept" that decided from the old state must lose.
      const result = await ports.relationships.transition(
        alice,
        bob,
        'dm_requested',
        'dm_open',
        { requestedBy: null, blockedBy: null },
        ports.clock.now(),
      );
      expect(result).toBeNull();
      expect((await ports.relationships.get(alice, bob)).state).toBe('blocked');
    });

    it('lists blocks in both directions', async () => {
      await ports.relationships.transition(
        alice,
        bob,
        'none',
        'blocked',
        { requestedBy: null, blockedBy: alice },
        ports.clock.now(),
      );
      expect(await ports.relationships.listBlockedIds(alice)).toEqual([bob]);
      // The blocked party also cannot see the blocker.
      expect(await ports.relationships.listBlockedIds(bob)).toEqual([alice]);
    });
  });

  // -------------------------------------------------------------------------
  describe('MemorySurpriseRepository', () => {
    const createSurprise = (code: string) =>
      ports.surprises.create({
        id: asUserId('s1') as never,
        code,
        senderId: alice,
        theme: 'love',
        message: 'hello',
        tasks: [{ text: 'call me', done: false }],
        createdAt: ports.clock.now(),
        expiresAt: new Date(ports.clock.nowMs() + 86_400_000),
      });

    it('redeems exactly once', async () => {
      await createSurprise('LOVE2847');

      const first = await ports.surprises.redeem('LOVE2847', bob, 'happy', ports.clock.now());
      expect(first).not.toBeNull();

      // The second claimant loses. This is the compare-and-set the port requires.
      const second = await ports.surprises.redeem(
        'LOVE2847',
        asUserId('carol'),
        'sad',
        ports.clock.now(),
      );
      expect(second).toBeNull();
    });

    it('refuses to redeem an expired surprise', async () => {
      await createSurprise('LOVE2847');
      ports.clock.advanceDays(2);
      expect(await ports.surprises.redeem('LOVE2847', bob, 'happy', ports.clock.now())).toBeNull();
    });

    it('rejects a duplicate code', async () => {
      await createSurprise('LOVE2847');
      await expect(createSurprise('LOVE2847')).rejects.toThrow(/already in use/i);
    });
  });

  // -------------------------------------------------------------------------
  describe('MemoryRateLimiter', () => {
    it('allows up to the limit then blocks', async () => {
      const { limit, windowSec } = LIMITS.dmRequest;

      for (let i = 0; i < limit; i += 1) {
        expect((await ports.rateLimiter.check('k', limit, windowSec)).allowed).toBe(true);
      }
      expect((await ports.rateLimiter.check('k', limit, windowSec)).allowed).toBe(false);
    });

    it('consumes even when blocked, so hammering earns no free window', async () => {
      await ports.rateLimiter.check('k', 1, 60);
      const blocked = await ports.rateLimiter.check('k', 1, 60);
      expect(blocked.allowed).toBe(false);
      expect(blocked.remaining).toBe(0);
    });

    it('resets after the window', async () => {
      await ports.rateLimiter.check('k', 1, 60);
      expect((await ports.rateLimiter.check('k', 1, 60)).allowed).toBe(false);

      ports.clock.advanceSeconds(61);
      expect((await ports.rateLimiter.check('k', 1, 60)).allowed).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe('MemoryMediaRoomProvider', () => {
    it('records the publish grant it was handed, and never decides one', async () => {
      // The adapter must not make authorization decisions; it records them.
      await ports.media.issueJoinToken(alice, room1, false);
      expect(ports.media.grantFor(room1, alice)).toBe(false);
      expect(ports.media.issuedTokens.at(-1)?.canPublish).toBe(false);

      await ports.media.issueJoinToken(alice, room1, true);
      expect(ports.media.grantFor(room1, alice)).toBe(true);
    });

    it('revokes publish server-side', async () => {
      await ports.media.issueJoinToken(alice, room1, true);
      await ports.media.revokePublish(alice, room1);
      expect(ports.media.grantFor(room1, alice)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe('MemoryTokenService', () => {
    it('rejects a refresh token where an access token is expected', async () => {
      // Otherwise a refresh token — which outlives every ban — becomes a
      // permanent access credential.
      const refresh = await ports.tokens.issueRefreshToken(alice, 'session-1');
      expect(await ports.tokens.verifyAccessToken(refresh.token)).toBeNull();
    });

    it('verifies a genuine access token', async () => {
      const access = await ports.tokens.issueAccessToken(alice, 'session-1');
      const claims = await ports.tokens.verifyAccessToken(access.token);
      expect(claims?.userId).toBe(alice);
      expect(claims?.sessionId).toBe('session-1');
    });

    it('expires an access token', async () => {
      const access = await ports.tokens.issueAccessToken(alice, 'session-1');
      ports.clock.advanceSeconds(901);
      expect(await ports.tokens.verifyAccessToken(access.token)).toBeNull();
    });

    it('ROTATES refresh tokens — a replay fails and kills the session', async () => {
      const refresh = await ports.tokens.issueRefreshToken(alice, 'session-1');

      expect(await ports.tokens.rotateRefreshToken(refresh.token)).not.toBeNull();
      // Second use of the same token means it was probably stolen.
      expect(await ports.tokens.rotateRefreshToken(refresh.token)).toBeNull();
    });

    it('revokeAllSessions kills ACCESS tokens too, not just refresh tokens', async () => {
      // The ban path depends on this: a session whose refresh token was already
      // rotated away would otherwise survive with a valid access token.
      const access = await ports.tokens.issueAccessToken(alice, 'session-1');
      expect(await ports.tokens.verifyAccessToken(access.token)).not.toBeNull();

      await ports.tokens.revokeAllSessions(alice);
      expect(await ports.tokens.verifyAccessToken(access.token)).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe('MemoryAuthChallengeStore', () => {
    it('accepts the right code exactly once', async () => {
      await ports.challenges.issue('a@example.com', 'email', '123456');
      expect(await ports.challenges.consume('a@example.com', '123456')).toBe('ok');
      // Single-use: a replay fails.
      expect(await ports.challenges.consume('a@example.com', '123456')).toBe('expired');
    });

    it('expires', async () => {
      await ports.challenges.issue('a@example.com', 'email', '123456', 60);
      ports.clock.advanceSeconds(61);
      expect(await ports.challenges.consume('a@example.com', '123456')).toBe('expired');
    });

    it(`destroys the challenge after ${MAX_CHALLENGE_ATTEMPTS} wrong guesses`, async () => {
      // A 6-digit code with unlimited attempts is a 6-digit code with no security.
      await ports.challenges.issue('a@example.com', 'email', '123456');

      for (let i = 0; i < MAX_CHALLENGE_ATTEMPTS - 1; i += 1) {
        expect(await ports.challenges.consume('a@example.com', '000000')).toBe('invalid');
      }
      expect(await ports.challenges.consume('a@example.com', '000000')).toBe('too_many_attempts');
      // Even the correct code no longer works.
      expect(await ports.challenges.consume('a@example.com', '123456')).toBe('expired');
    });

    it('re-issuing invalidates the previous code', async () => {
      await ports.challenges.issue('a@example.com', 'email', '111111');
      await ports.challenges.issue('a@example.com', 'email', '222222');
      expect(await ports.challenges.consume('a@example.com', '111111')).toBe('invalid');
      expect(await ports.challenges.consume('a@example.com', '222222')).toBe('ok');
    });

    it('peek never exposes the code', async () => {
      await ports.challenges.issue('a@example.com', 'email', '123456');
      const peeked = await ports.challenges.peek('a@example.com');
      expect(JSON.stringify(peeked)).not.toContain('123456');
    });
  });

  // -------------------------------------------------------------------------
  describe('MemoryMessageRepository', () => {
    it('bounds the room buffer, matching the Redis LTRIM', async () => {
      for (let i = 0; i < ROOM_BUFFER_SIZE + 20; i += 1) {
        await ports.messages.appendRoomMessage({
          id: asMessageId(`m${i}`),
          scope: 'room',
          roomId: room1,
          recipientId: null,
          senderId: alice,
          text: `message ${i}`,
          sentAt: ports.clock.now(),
        });
      }

      const recent = await ports.messages.recentRoomMessages(room1, 1000);
      expect(recent).toHaveLength(ROOM_BUFFER_SIZE);
      // Oldest first, and the truly old ones are gone.
      expect(recent[0]?.text).toBe(`message 20`);
      expect(recent.at(-1)?.text).toBe(`message ${ROOM_BUFFER_SIZE + 19}`);
    });

    it('keeps DM threads unbounded and symmetric', async () => {
      await ports.messages.appendDirectMessage({
        id: asMessageId('d1'),
        scope: 'dm',
        roomId: null,
        recipientId: bob,
        senderId: alice,
        text: 'hi',
        sentAt: ports.clock.now(),
      });

      // Readable from either side of the pair.
      expect(await ports.messages.directThread(alice, bob, 10)).toHaveLength(1);
      expect(await ports.messages.directThread(bob, alice, 10)).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  describe('MemoryEventBus', () => {
    it('delivers asynchronously, matching Redis pub/sub', async () => {
      const seen: string[] = [];
      await ports.bus.subscribe('moderation', (event) => {
        seen.push(event.type);
      });

      // Deliberately NOT awaited yet: the assertion below is about what has
      // happened by the time `publish` returns, before any microtask runs.
      const publishing = ports.bus.publish('moderation', {
        type: 'user.banned',
        userId: alice,
        permanent: true,
        reason: 'x',
      });

      // Handlers do not run inside publish. A fake that delivered synchronously
      // would be easier to test against than Redis pub/sub actually is, and
      // every test would then assert a guarantee production does not provide.
      expect(seen).toHaveLength(0);

      await publishing;
      await ports.bus.flush();
      expect(seen).toEqual(['user.banned']);
    });

    it('a throwing subscriber does not break the publisher', async () => {
      await ports.bus.subscribe('moderation', () => {
        throw new Error('subscriber exploded');
      });

      await expect(
        ports.bus.publish('moderation', {
          type: 'user.banned',
          userId: alice,
          permanent: true,
          reason: 'x',
        }),
      ).resolves.toBeUndefined();

      await ports.bus.flush();
      expect(ports.bus.handlerErrors).toHaveLength(1);
    });

    it('unsubscribe stops delivery', async () => {
      const seen: string[] = [];
      const off = await ports.bus.subscribe('presence', (e) => void seen.push(e.type));
      await off();

      await ports.bus.publish('presence', {
        type: 'presence.reaped',
        userId: alice,
        roomId: room1,
      });
      await ports.bus.flush();
      expect(seen).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('MemoryRealtimeTransport', () => {
    it('records emissions instead of transmitting', async () => {
      await ports.recorder.emitToRoom(room1, 'user:left', { roomId: room1, userId: alice });
      expect(ports.recorder.emissionsTo(room1, 'user:left')).toHaveLength(1);
    });

    it('records the except-user target separately', async () => {
      await ports.recorder.emitToRoomExcept(room1, alice, 'user:left', {
        roomId: room1,
        userId: bob,
      });
      const [emission] = ports.recorder.emissionsTo(room1);
      expect(emission?.target).toMatchObject({ kind: 'room', exceptUserId: alice });
    });

    it('records forced disconnects', async () => {
      ports.recorder.connect(alice);
      await ports.recorder.disconnectUser(alice, 'banned');
      expect(ports.recorder.disconnected).toEqual([{ userId: alice, reason: 'banned' }]);
      expect(await ports.recorder.isUserConnected(alice)).toBe(false);
    });
  });
});
