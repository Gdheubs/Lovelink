import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryPorts, type MemoryPorts } from '../../src/adapters/memory/index.js';
import { createUseCases, type UseCases } from '../../src/app/index.js';
import type { User } from '../../src/domain/entities/User.js';
import type { RoomId } from '../../src/domain/values/ids.js';
import { asUserId, callRoomId } from '../../src/domain/values/ids.js';
import { CALL_RING_TIMEOUT_MS } from '../../src/domain/entities/Relationship.js';
import { LIMITS } from '../../src/domain/ports/RateLimiter.js';
import { TRUST_DELTAS } from '../../src/domain/values/trust.js';
import type { DomainError } from '../../src/domain/errors.js';

/**
 * PHASE 5 — the trust ladder, end to end.
 *
 * The exit criterion for this phase is a single journey: meet in a room, send a
 * surprise, open a DM, make a 1:1 call. This suite walks it, and then spends
 * most of its length on the ways it must NOT be walkable — because every rung
 * is a promise to a user about who can reach them, and a rung that can be
 * skipped is a promise broken silently.
 *
 * WHAT IS DELIBERATELY NOT MOCKED
 * -------------------------------
 * Nothing. These run against the in-memory fakes, which are the same objects
 * the socket suite and `dev:memory` use, and whose behaviour is pinned against
 * the real adapters by the contract suites in tests/adapters. A test double
 * written for this file alone would be free to agree with whatever the code
 * happens to do.
 */
describe('connections — the trust ladder', () => {
  let ports: MemoryPorts;
  let useCases: UseCases;

  let alice: User;
  let bob: User;
  let stranger: User;
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

    // Mirrors registration; without the starting balance a fixture user is one
    // penalty away from restricted, which no real account ever is.
    await ports.users.appendTrustEvent({
      userId: user.id,
      delta: TRUST_DELTAS.account_created,
      reason: 'account_created',
      context: null,
      createdAt: ports.clock.now(),
    });

    return (await ports.users.findById(user.id)) ?? user;
  };

  /** Reload, because trust events and status changes are not visible on a stale copy. */
  const refresh = async (user: User): Promise<User> =>
    (await ports.users.findById(user.id)) ?? user;

  /** The evidence rung 3 requires: time in the same room that actually overlapped. */
  const shareARoom = async (a: User, b: User): Promise<void> => {
    await useCases.joinRoom.execute(a, roomId);
    await useCases.joinRoom.execute(b, roomId);
    ports.clock.advanceSeconds(60);
    await useCases.leaveRoom.execute({ userId: a.id, roomId, reason: 'left' });
    await useCases.leaveRoom.execute({ userId: b.id, roomId, reason: 'left' });
  };

  /** Walk the ladder to an open DM between two people. */
  const openDm = async (a: User, b: User): Promise<void> => {
    await shareARoom(a, b);
    await useCases.requestDm.execute(await refresh(a), b.id);
    await useCases.acceptDm.execute(await refresh(b), a.id);
  };

  const errorOf = async (fn: () => Promise<unknown>): Promise<DomainError> => {
    try {
      await fn();
    } catch (error) {
      return error as DomainError;
    }
    throw new Error('expected the call to be refused, but it succeeded');
  };

  beforeEach(async () => {
    ports = createMemoryPorts({ presenceTtlSeconds: 60 });
    useCases = createUseCases(ports, { echoLoginCode: true, moderatorUserIds: [] });

    alice = await makeUser('Alice');
    bob = await makeUser('Bob');
    stranger = await makeUser('Stranger');

    const room = await useCases.createRoom.execute(alice, {
      title: 'Late Night Talk',
      category: 'casual',
    });
    roomId = room.id;
    ports.recorder.clear();
  });

  // ==========================================================================
  describe('THE JOURNEY — meet, surprise, DM, call', () => {
    it('walks the whole ladder', async () => {
      // 1. MEET. Both in the same room, at the same time.
      await shareARoom(alice, bob);

      // 2. SURPRISE. Needs no relationship at all — it is how one starts.
      const { displayCode } = await useCases.createSurprise.execute(await refresh(alice), {
        theme: 'thinking_of_you',
        message: 'good talking to you tonight',
        tasks: ['drink some water'],
      });
      expect(displayCode).toMatch(/^[A-Z]{4}-[A-Z0-9]+$/);

      const revealed = await useCases.redeemSurprise.execute(await refresh(bob), {
        code: displayCode,
        mood: 'tired',
        ip: '198.51.100.7',
      });
      expect(revealed.from.displayName).toBe('Alice');
      expect(revealed.reveal).toContain('Alice');
      expect(revealed.personalMessage).toBe('good talking to you tonight');

      // 3. DM. Request, then consent.
      await useCases.requestDm.execute(await refresh(alice), bob.id);
      await useCases.acceptDm.execute(await refresh(bob), alice.id);

      const sent = await useCases.sendDm.execute(await refresh(alice), {
        toUserId: bob.id,
        text: 'hey!',
      });
      expect(sent.text).toBe('hey!');

      // 4. CALL. Only reachable because the DM is open.
      await useCases.inviteToCall.execute(await refresh(alice), bob.id);
      const session = await useCases.acceptCall.execute(await refresh(bob), alice.id);

      expect(session.callRoomId).toBe(callRoomId(alice.id, bob.id));
      expect(session.mediaToken.canPublish).toBe(true);
    });
  });

  // ==========================================================================
  describe('rung 3 — a DM request needs a shared room', () => {
    it('refuses someone you have never been in a room with', async () => {
      const error = await errorOf(async () => useCases.requestDm.execute(alice, stranger.id));
      expect(error.code).toBe('TRUST_LADDER_VIOLATION');
    });

    it('is not satisfied by having visited the same room at different times', async () => {
      // The bug this guards: treating "was a member of room X" as evidence.
      // A popular room would then unlock every person who ever passed through.
      await useCases.joinRoom.execute(alice, roomId);
      ports.clock.advanceSeconds(60);
      await useCases.leaveRoom.execute({ userId: alice.id, roomId, reason: 'left' });

      ports.clock.advanceSeconds(3600);

      await useCases.joinRoom.execute(bob, roomId);
      ports.clock.advanceSeconds(60);
      await useCases.leaveRoom.execute({ userId: bob.id, roomId, reason: 'left' });

      const error = await errorOf(async () => useCases.requestDm.execute(await refresh(alice), bob.id));
      expect(error.code).toBe('TRUST_LADDER_VIOLATION');
    });

    it('notifies the person being asked, and nobody else', async () => {
      await shareARoom(alice, bob);
      ports.recorder.clear();

      await useCases.requestDm.execute(await refresh(alice), bob.id);

      expect(ports.recorder.emissionsToUser(bob.id, 'dm:requested')).toHaveLength(1);
      expect(ports.recorder.emissionsToUser(alice.id, 'dm:requested')).toHaveLength(0);
    });

    it('a pending request grants NO messaging rights', async () => {
      await shareARoom(alice, bob);
      await useCases.requestDm.execute(await refresh(alice), bob.id);

      // The entire point of request-then-accept: asking is not messaging.
      const error = await errorOf(async () =>
        useCases.sendDm.execute(await refresh(alice), { toUserId: bob.id, text: 'hello?' }),
      );
      expect(error.code).toBe('TRUST_LADDER_VIOLATION');
    });

    it('THE REQUESTER CANNOT ACCEPT THEIR OWN REQUEST', async () => {
      await shareARoom(alice, bob);
      await useCases.requestDm.execute(await refresh(alice), bob.id);

      // Without the direction check, Alice opens her own channel to Bob.
      const error = await errorOf(async () => useCases.acceptDm.execute(await refresh(alice), bob.id));
      expect(error.code).toBe('NOT_FOUND');
    });

    it('declining tells the requester nothing at all', async () => {
      await shareARoom(alice, bob);
      await useCases.requestDm.execute(await refresh(alice), bob.id);
      ports.recorder.clear();

      await useCases.declineDm.execute(await refresh(bob), alice.id);

      // Silence is the kindest available ambiguity: from Alice's side this is
      // indistinguishable from a request Bob has not got to yet.
      expect(ports.recorder.emissionsToUser(alice.id)).toHaveLength(0);
    });

    it('a declined request can be made again later, not blocked forever', async () => {
      await shareARoom(alice, bob);
      await useCases.requestDm.execute(await refresh(alice), bob.id);
      await useCases.declineDm.execute(await refresh(bob), alice.id);

      await expect(
        useCases.requestDm.execute(await refresh(alice), bob.id),
      ).resolves.toBeUndefined();
    });

    it('limits how many requests one person can fire off', async () => {
      await shareARoom(alice, bob);

      // Exhaust the window against people Alice has legitimately met.
      const others: User[] = [];
      for (let i = 0; i < LIMITS.dmRequest.limit; i += 1) {
        const other = await makeUser(`Other${i}`);
        await shareARoom(alice, other);
        others.push(other);
      }
      for (const other of others) {
        await useCases.requestDm.execute(await refresh(alice), other.id);
      }

      const error = await errorOf(async () => useCases.requestDm.execute(await refresh(alice), bob.id));
      expect(error.code).toBe('RATE_LIMITED');
    });
  });

  // ==========================================================================
  describe('rung 3b — messaging an open conversation', () => {
    beforeEach(async () => {
      await openDm(alice, bob);
      ports.recorder.clear();
    });

    it('delivers to the recipient AND the sender’s other devices', async () => {
      await useCases.sendDm.execute(await refresh(alice), { toUserId: bob.id, text: 'hi' });

      expect(ports.recorder.emissionsToUser(bob.id, 'dm:message')).toHaveLength(1);
      // Someone typing on a phone with a laptop open must see it in both.
      expect(ports.recorder.emissionsToUser(alice.id, 'dm:message')).toHaveLength(1);
    });

    it('persists, so the thread survives a reload', async () => {
      await useCases.sendDm.execute(await refresh(alice), { toUserId: bob.id, text: 'first' });
      await useCases.sendDm.execute(await refresh(bob), { toUserId: alice.id, text: 'second' });

      const page = await useCases.readDmThread.execute(await refresh(bob), {
        withUserId: alice.id,
      });

      expect(page.messages.map((m) => m.text)).toEqual(['second', 'first']);
    });

    it('A BLOCK TAKES EFFECT ON THE VERY NEXT MESSAGE', async () => {
      // The bug this guards: authorizing once when the thread opens and
      // trusting a long-lived socket thereafter. Someone who blocks mid-
      // conversation expects the next message refused, not the one after both
      // sides happen to reconnect.
      await useCases.blockUser.execute(await refresh(bob), alice.id);

      const error = await errorOf(async () =>
        useCases.sendDm.execute(await refresh(alice), { toUserId: bob.id, text: 'still here' }),
      );
      expect(error.code).toBe('BLOCKED');
    });

    it('a blocked person cannot re-read the history either', async () => {
      await useCases.sendDm.execute(await refresh(alice), { toUserId: bob.id, text: 'hello' });
      await useCases.blockUser.execute(await refresh(bob), alice.id);

      // A safety action people assume is complete must actually be complete.
      const error = await errorOf(async () =>
        useCases.readDmThread.execute(await refresh(alice), { withUserId: bob.id }),
      );
      expect(error.code).toBe('BLOCKED');
    });

    it('a restricted account cannot message anyone', async () => {
      await ports.users.appendTrustEvent({
        userId: alice.id,
        delta: TRUST_DELTAS.banned,
        reason: 'banned',
        context: null,
        createdAt: ports.clock.now(),
      });

      const error = await errorOf(async () =>
        useCases.sendDm.execute(await refresh(alice), { toUserId: bob.id, text: 'hi' }),
      );
      expect(error.code).toBe('TRUST_LADDER_VIOLATION');
    });
  });

  // ==========================================================================
  describe('rung 4 — the 1:1 call', () => {
    beforeEach(async () => {
      await openDm(alice, bob);
      ports.recorder.clear();
    });

    it('cannot be reached without an open DM', async () => {
      const error = await errorOf(async () =>
        useCases.inviteToCall.execute(await refresh(alice), stranger.id),
      );
      expect(error.code).toBe('TRUST_LADDER_VIOLATION');
    });

    it('rings the other person, carrying NO media token', async () => {
      await useCases.inviteToCall.execute(await refresh(alice), bob.id);

      const incoming = ports.recorder.emissionsToUser(bob.id, 'call:incoming');
      expect(incoming).toHaveLength(1);

      // A ringing phone must not arrive with the credential to open a
      // microphone. That distinction IS the consent step.
      expect(JSON.stringify(incoming[0]?.payload)).not.toContain('token');
    });

    it('issues no publishing credential until someone answers', async () => {
      await useCases.inviteToCall.execute(await refresh(alice), bob.id);

      // Scoped to the CALL room: joining a normal room issues tokens too, and
      // those are in the same list.
      const room = callRoomId(alice.id, bob.id);
      const forTheCall = ports.media.issuedTokens.filter((t) => t.roomId === room);

      // Every unanswered call would otherwise leave a live publish token in a
      // browser belonging to a call that never happened.
      expect(forTheCall).toHaveLength(0);
    });

    it('gives both parties a token at the moment it is answered', async () => {
      await useCases.inviteToCall.execute(await refresh(alice), bob.id);
      const session = await useCases.acceptCall.execute(await refresh(bob), alice.id);

      expect(session.mediaToken.canPublish).toBe(true);

      const accepted = ports.recorder.lastPayload('call:accepted');
      expect(accepted?.withUserId).toBe(bob.id);
      expect(accepted?.mediaToken.token.length).toBeGreaterThan(0);
    });

    it('puts both people in the SAME room, derived not allocated', async () => {
      await useCases.inviteToCall.execute(await refresh(alice), bob.id);
      const session = await useCases.acceptCall.execute(await refresh(bob), alice.id);

      const accepted = ports.recorder.lastPayload('call:accepted');
      expect(session.callRoomId).toBe(accepted?.callRoomId);
      // Same answer from either side's point of view, with no lookup.
      expect(callRoomId(bob.id, alice.id)).toBe(callRoomId(alice.id, bob.id));
    });

    it('THE CALLER CANNOT ACCEPT THEIR OWN CALL', async () => {
      await useCases.inviteToCall.execute(await refresh(alice), bob.id);

      // Without this, Alice self-accepts, `call:accepted` is emitted to Bob,
      // and his client joins audio he never agreed to.
      const error = await errorOf(async () => useCases.acceptCall.execute(await refresh(alice), bob.id));
      expect(error.code).toBe('NO_PENDING_CALL');
    });

    it('refuses a second call into a phone that is already ringing', async () => {
      await useCases.inviteToCall.execute(await refresh(alice), bob.id);

      const error = await errorOf(async () => useCases.inviteToCall.execute(await refresh(bob), alice.id));
      expect(error.code).toBe('CALL_BUSY');
    });

    it('refuses to answer a ring that already timed out', async () => {
      await useCases.inviteToCall.execute(await refresh(alice), bob.id);
      ports.clock.advanceMs(CALL_RING_TIMEOUT_MS + 1);

      const error = await errorOf(async () => useCases.acceptCall.execute(await refresh(bob), alice.id));
      expect(error.code).toBe('NO_PENDING_CALL');
    });

    it('RECOVERS FROM A CALLER WHOSE BROWSER DIED MID-RING', async () => {
      // No hang-up is ever sent. Without the staleness rule this pair could
      // never call each other again.
      await useCases.inviteToCall.execute(await refresh(alice), bob.id);
      ports.clock.advanceMs(CALL_RING_TIMEOUT_MS + 1);

      await expect(
        useCases.inviteToCall.execute(await refresh(bob), alice.id),
      ).resolves.toBeDefined();
    });

    it('hanging up frees the line for another call', async () => {
      await useCases.inviteToCall.execute(await refresh(alice), bob.id);
      await useCases.acceptCall.execute(await refresh(bob), alice.id);
      await useCases.endCall.execute(await refresh(bob), alice.id);

      await expect(
        useCases.inviteToCall.execute(await refresh(alice), bob.id),
      ).resolves.toBeDefined();
    });

    it('hanging up twice is not an error', async () => {
      await useCases.inviteToCall.execute(await refresh(alice), bob.id);
      await useCases.endCall.execute(await refresh(bob), alice.id);

      // A local timeout and a user tapping the button both send this.
      await expect(useCases.endCall.execute(await refresh(bob), alice.id)).resolves.toBeUndefined();
    });

    it('declining tells the caller, and closes the room they are sitting in', async () => {
      await useCases.inviteToCall.execute(await refresh(alice), bob.id);
      ports.recorder.clear();

      await useCases.endCall.execute(await refresh(bob), alice.id);

      expect(ports.recorder.emissionsToUser(alice.id, 'call:declined')).toHaveLength(1);
      expect(ports.media.closedRooms).toContain(callRoomId(alice.id, bob.id));
    });

    it('a connected call does not become re-dialable after the ring timeout', async () => {
      await useCases.inviteToCall.execute(await refresh(alice), bob.id);
      await useCases.acceptCall.execute(await refresh(bob), alice.id);

      // Mid-conversation. Without clearing `requestedBy` on answer, this looks
      // like an abandoned ring and Alice's phone rings while she is talking
      // to the person ringing her.
      ports.clock.advanceMs(CALL_RING_TIMEOUT_MS * 5);

      const error = await errorOf(async () => useCases.inviteToCall.execute(await refresh(bob), alice.id));
      expect(error.code).toBe('CALL_BUSY');
    });

    it('anyone may end a call, including a restricted account', async () => {
      await useCases.inviteToCall.execute(await refresh(alice), bob.id);
      await useCases.acceptCall.execute(await refresh(bob), alice.id);

      await ports.users.appendTrustEvent({
        userId: bob.id,
        delta: TRUST_DELTAS.banned,
        reason: 'banned',
        context: null,
        createdAt: ports.clock.now(),
      });

      // Being able to leave a conversation is not a privilege that can be
      // revoked.
      await expect(useCases.endCall.execute(await refresh(bob), alice.id)).resolves.toBeUndefined();
    });
  });

  // ==========================================================================
  describe('surprises', () => {
    it('a code can be opened exactly once', async () => {
      const { displayCode } = await useCases.createSurprise.execute(alice, {
        theme: 'love',
        message: 'thinking of you',
      });

      await useCases.redeemSurprise.execute(await refresh(bob), {
        code: displayCode,
        mood: 'happy',
        ip: '198.51.100.7',
      });

      const error = await errorOf(async () =>
        useCases.redeemSurprise.execute(await refresh(stranger), {
          code: displayCode,
          mood: 'sad',
          ip: '198.51.100.8',
        }),
      );
      expect(error.code).toBe('ALREADY_REDEEMED');
    });

    it('accepts a code however it was transcribed', async () => {
      const { displayCode } = await useCases.createSurprise.execute(alice, {
        theme: 'miss',
        message: 'come back',
      });

      const mangled = displayCode.toLowerCase().replace('-', ' ');
      await expect(
        useCases.redeemSurprise.execute(await refresh(bob), {
          code: mangled,
          mood: 'soft',
          ip: '198.51.100.7',
        }),
      ).resolves.toBeDefined();
    });

    it('an unknown code and an expired one are indistinguishable', async () => {
      const { displayCode } = await useCases.createSurprise.execute(alice, {
        theme: 'love',
        message: 'x',
      });
      ports.clock.advanceDays(31);

      const expired = await errorOf(async () =>
        useCases.redeemSurprise.execute(await refresh(bob), {
          code: displayCode,
          mood: 'meh',
          ip: '198.51.100.7',
        }),
      );
      const unknown = await errorOf(async () =>
        useCases.redeemSurprise.execute(await refresh(bob), {
          code: 'LOVE9Z9Z',
          mood: 'meh',
          ip: '198.51.100.7',
        }),
      );

      // Telling them apart would confirm which codes were ever real.
      expect(expired.code).toBe(unknown.code);
      expect(expired.message).toBe(unknown.message);
    });

    it('you cannot open your own surprise', async () => {
      const { displayCode } = await useCases.createSurprise.execute(alice, {
        theme: 'congrats',
        message: 'well done me',
      });

      const error = await errorOf(async () =>
        useCases.redeemSurprise.execute(await refresh(alice), {
          code: displayCode,
          mood: 'happy',
          ip: '198.51.100.7',
        }),
      );
      expect(error.code).toBe('CONFLICT');
    });

    it('tells the sender it landed, WITHOUT saying how the reader felt', async () => {
      const { displayCode } = await useCases.createSurprise.execute(alice, {
        theme: 'love',
        message: 'x',
      });
      ports.recorder.clear();

      await useCases.redeemSurprise.execute(await refresh(bob), {
        code: displayCode,
        mood: 'sad',
        ip: '198.51.100.7',
      });

      const ping = ports.recorder.emissionsToUser(alice.id, 'surprise:received');
      expect(ping).toHaveLength(1);
      // The mood was disclosed to the app in order to choose a message, not to
      // the sender. "They opened it and they were sad" was never agreed to.
      expect(JSON.stringify(ping[0]?.payload)).not.toContain('sad');
    });

    it('the message depends on the mood the RECIPIENT chose', async () => {
      const a = await useCases.createSurprise.execute(alice, { theme: 'love', message: 'x' });
      const b = await useCases.createSurprise.execute(alice, { theme: 'love', message: 'x' });

      const sad = await useCases.redeemSurprise.execute(await refresh(bob), {
        code: a.displayCode,
        mood: 'sad',
        ip: '198.51.100.7',
      });
      const happy = await useCases.redeemSurprise.execute(await refresh(stranger), {
        code: b.displayCode,
        mood: 'happy',
        ip: '198.51.100.8',
      });

      expect(sad.reveal).not.toBe(happy.reveal);
    });

    it('re-opening shows the same words, not a re-roll', async () => {
      const { displayCode } = await useCases.createSurprise.execute(alice, {
        theme: 'sorry',
        message: 'x',
      });
      const opened = await useCases.redeemSurprise.execute(await refresh(bob), {
        code: displayCode,
        mood: 'angry',
        ip: '198.51.100.7',
      });

      const listed = await useCases.listMySurprises.execute(await refresh(bob));
      expect(listed.received[0]?.mood).toBe('angry');
      expect(listed.received[0]?.id).toBe(opened.id);
    });

    it('only the recipient can tick off a task', async () => {
      const { surprise, displayCode } = await useCases.createSurprise.execute(alice, {
        theme: 'love',
        message: 'x',
        tasks: ['drink water'],
      });
      await useCases.redeemSurprise.execute(await refresh(bob), {
        code: displayCode,
        mood: 'tired',
        ip: '198.51.100.7',
      });

      const error = await errorOf(async () =>
        useCases.toggleSurpriseTask.execute(await refresh(alice), {
          surpriseId: surprise.id,
          taskIndex: 0,
          done: true,
        }),
      );
      expect(error.code).toBe('NOT_FOUND');

      const updated = await useCases.toggleSurpriseTask.execute(await refresh(bob), {
        surpriseId: surprise.id,
        taskIndex: 0,
        done: true,
      });
      expect(updated.tasks[0]?.done).toBe(true);
    });

    it('the sender never learns the recipient’s mood from their own list', async () => {
      const { displayCode } = await useCases.createSurprise.execute(alice, {
        theme: 'love',
        message: 'x',
      });
      await useCases.redeemSurprise.execute(await refresh(bob), {
        code: displayCode,
        mood: 'sad',
        ip: '198.51.100.7',
      });

      const listed = await useCases.listMySurprises.execute(await refresh(alice));
      expect(listed.sent[0]?.opened).toBe(true);
      expect(JSON.stringify(listed.sent[0])).not.toContain('sad');
    });

    it('a received surprise does not echo the claim code back', async () => {
      const { displayCode } = await useCases.createSurprise.execute(alice, {
        theme: 'love',
        message: 'x',
      });
      await useCases.redeemSurprise.execute(await refresh(bob), {
        code: displayCode,
        mood: 'meh',
        ip: '198.51.100.7',
      });

      const listed = await useCases.listMySurprises.execute(await refresh(bob));
      expect(JSON.stringify(listed.received[0])).not.toContain(displayCode.replace('-', ''));
    });

    it('limits redemption attempts, which is what makes a short code safe', async () => {
      for (let i = 0; i < LIMITS.surpriseRedeem.limit; i += 1) {
        await errorOf(async () =>
          useCases.redeemSurprise.execute(bob, {
            code: `LOVE000${i}`,
            mood: 'meh',
            ip: '198.51.100.7',
          }),
        );
      }

      const error = await errorOf(async () =>
        useCases.redeemSurprise.execute(bob, {
          code: 'LOVE9999',
          mood: 'meh',
          ip: '198.51.100.7',
        }),
      );
      expect(error.code).toBe('RATE_LIMITED');
    });

    it('a restricted account cannot send surprises to strangers', async () => {
      await ports.users.appendTrustEvent({
        userId: alice.id,
        delta: TRUST_DELTAS.banned,
        reason: 'banned',
        context: null,
        createdAt: ports.clock.now(),
      });

      const error = await errorOf(async () =>
        useCases.createSurprise.execute(await refresh(alice), { theme: 'love', message: 'x' }),
      );
      expect(error.code).toBe('TRUST_LADDER_VIOLATION');
    });
  });

  // ==========================================================================
  describe('the connections list', () => {
    it('is empty for someone who has met nobody', async () => {
      const view = await useCases.listConnections.execute(alice);
      expect(view.connections).toHaveLength(0);
      expect(view.incomingRequests).toHaveLength(0);
    });

    it('shows a pending request ONLY to the person who was asked', async () => {
      await shareARoom(alice, bob);
      await useCases.requestDm.execute(await refresh(alice), bob.id);

      const asked = await useCases.listConnections.execute(await refresh(bob));
      expect(asked.incomingRequests.map((c) => c.user.displayName)).toEqual(['Alice']);

      // Showing Alice her own pending request tells her Bob has not answered,
      // which invites a second ask — exactly the pressure consent should avoid.
      const requester = await useCases.listConnections.execute(await refresh(alice));
      expect(requester.incomingRequests).toHaveLength(0);
      expect(requester.connections).toHaveLength(0);
    });

    it('lists an open conversation for both people', async () => {
      await openDm(alice, bob);

      for (const user of [alice, bob]) {
        const view = await useCases.listConnections.execute(await refresh(user));
        expect(view.connections).toHaveLength(1);
        expect(view.connections[0]?.can.canSendDm).toBe(true);
        expect(view.connections[0]?.can.canCall).toBe(true);
      }
    });

    it('does not offer a call button to a merely-requested connection', async () => {
      await shareARoom(alice, bob);
      await useCases.requestDm.execute(await refresh(alice), bob.id);

      const view = await useCases.listConnections.execute(await refresh(bob));
      expect(view.incomingRequests[0]?.can.canSendDm).toBe(false);
      expect(view.incomingRequests[0]?.can.canCall).toBe(false);
    });
  });
});
