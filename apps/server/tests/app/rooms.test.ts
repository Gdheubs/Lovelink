import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryPorts, type MemoryPorts } from '../../src/adapters/memory/index.js';
import { createUseCases, type UseCases } from '../../src/app/index.js';
import { MIN_SESSION_MS } from '../../src/app/rooms/LeaveRoom.js';
import type { User } from '../../src/domain/entities/User.js';
import type { RoomId } from '../../src/domain/values/ids.js';
import { LIMITS } from '../../src/domain/ports/RateLimiter.js';
import { ROOM_BUFFER_SIZE } from '../../src/domain/ports/MessageRepository.js';
import type { DomainError } from '../../src/domain/errors.js';

/**
 * Rooms, presence and chat — the Phase 2 backbone.
 *
 * The tests worth reading are the ones about DEPARTURE and RECONNECTION, not
 * arrival. Joining is easy; the difficulty of presence is that people vanish
 * without saying so, and that the same person may re-appear seconds later on a
 * new socket. Those two facts produce every hard bug in this layer.
 */
describe('rooms', () => {
  let ports: MemoryPorts;
  let useCases: UseCases;

  let host: User;
  let alice: User;
  let bob: User;
  let roomId: RoomId;

  const PRESENCE_TTL_SECONDS = 30;

  /** Register an account directly through the repository — auth is tested elsewhere. */
  const makeUser = async (name: string): Promise<User> => {
    const user = await ports.users.create({
      id: ports.ids.uuid() as User['id'],
      identifier: `${name}@example.com`,
      identifierKind: 'email',
      displayName: name,
      avatarSeed: `seed-${name}`,
      dob: new Date('1995-01-01T00:00:00.000Z'),
      createdAt: ports.clock.now(),
    });
    return user;
  };

  beforeEach(async () => {
    ports = createMemoryPorts({ presenceTtlSeconds: PRESENCE_TTL_SECONDS });
    useCases = createUseCases(ports, { echoLoginCode: true, moderatorUserIds: [] });

    host = await makeUser('Hosty');
    alice = await makeUser('Alice');
    bob = await makeUser('Bob');

    const room = await useCases.createRoom.execute(host, {
      title: 'Late Night Talk',
      category: 'late_night',
    });
    roomId = room.id;
  });

  // -------------------------------------------------------------------------
  describe('creating a room', () => {
    it('derives a slug from the title', async () => {
      const room = await useCases.createRoom.execute(host, {
        title: 'Deep Focus Session',
        category: 'study',
      });
      expect(room.slug).toBe('deep-focus-session');
    });

    it('resolves a slug collision instead of failing', async () => {
      const second = await useCases.createRoom.execute(host, {
        title: 'Late Night Talk',
        category: 'late_night',
      });
      expect(second.slug).toBe('late-night-talk-2');
    });

    it('rejects an unknown category', async () => {
      await expect(
        useCases.createRoom.execute(host, { title: 'Whatever', category: 'nonsense' }),
      ).rejects.toThrow(/category/i);
    });

    it('refuses to let a trust-restricted account host', async () => {
      // Hosting puts someone in charge of other people's safety.
      await ports.users.appendTrustEvent({
        userId: alice.id,
        delta: -30,
        reason: 'report_upheld',
        context: null,
        createdAt: ports.clock.now(),
      });
      const restricted = (await ports.users.findById(alice.id))!;

      await expect(
        useCases.createRoom.execute(restricted, { title: 'My Room', category: 'casual' }),
      ).rejects.toThrow(/limited/i);
    });

    it('does NOT mark the creator as present', async () => {
      // Creating a room and being in it are different actions.
      expect(await ports.presence.countRoomMembers(roomId)).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('joining', () => {
    it('puts everyone in as a LISTENER', async () => {
      const { state } = await useCases.joinRoom.execute(alice, roomId);
      expect(state.selfRole).toBe('listener');
    });

    it('recognises the room owner as host', async () => {
      const { state } = await useCases.joinRoom.execute(host, roomId);
      expect(state.selfRole).toBe('host');
    });

    it('has no way to request a role', async () => {
      // Compile-time property, asserted here so the intent is recorded: the
      // input is (user, roomId) and nothing else. Speaking is granted by
      // ApproveSpeaker, never requested at join.
      expect(useCases.joinRoom.execute.length).toBe(2);
    });

    it('announces a new arrival to the room but not to the joiner', async () => {
      await useCases.joinRoom.execute(alice, roomId);
      ports.recorder.clear();

      await useCases.joinRoom.execute(bob, roomId);

      const joined = ports.recorder.emissionsTo(roomId, 'user:joined');
      expect(joined).toHaveLength(1);
      // Excluded: the joiner receives the authoritative snapshot instead.
      expect(joined[0]?.target).toMatchObject({ exceptUserId: bob.id });
    });

    it('is IDEMPOTENT — a reconnect does not re-announce the user', async () => {
      // Otherwise a flaky connection looks, to everyone else, like a person
      // repeatedly walking in and out.
      await useCases.joinRoom.execute(alice, roomId);
      ports.recorder.clear();

      const second = await useCases.joinRoom.execute(alice, roomId);

      expect(second.isNewArrival).toBe(false);
      expect(ports.recorder.emissionsTo(roomId, 'user:joined')).toHaveLength(0);
    });

    it('writes BOTH live presence and a durable membership row', async () => {
      await useCases.joinRoom.execute(alice, roomId);

      // Live truth, for the member list.
      expect(await ports.presence.getMember(roomId, alice.id)).not.toBeNull();
      // Durable history, which the trust ladder reads and which must survive
      // a Redis flush.
      expect(await ports.rooms.findMembership(roomId, alice.id)).not.toBeNull();
    });

    it('refuses a closed room', async () => {
      await ports.rooms.updateStatus(roomId, 'closed');
      try {
        await useCases.joinRoom.execute(alice, roomId);
        expect.unreachable('should have refused');
      } catch (error) {
        expect((error as DomainError).code).toBe('ROOM_CLOSED');
      }
    });

    it('refuses a room that does not exist', async () => {
      await expect(useCases.joinRoom.execute(alice, 'not-a-room' as RoomId)).rejects.toThrow(
        /not found/i,
      );
    });

    it('is rate limited', async () => {
      for (let i = 0; i < LIMITS.roomJoin.limit; i += 1) {
        await useCases.joinRoom.execute(alice, roomId);
      }
      await expect(useCases.joinRoom.execute(alice, roomId)).rejects.toThrow(/too quickly/i);
    });
  });

  // -------------------------------------------------------------------------
  describe('the room:state snapshot', () => {
    it('includes every present member', async () => {
      await useCases.joinRoom.execute(host, roomId);
      await useCases.joinRoom.execute(alice, roomId);
      const { state } = await useCases.joinRoom.execute(bob, roomId);

      expect(state.members).toHaveLength(3);
      expect(state.members.map((m) => m.user.displayName).sort()).toEqual([
        'Alice',
        'Bob',
        'Hosty',
      ]);
    });

    it('orders host first, then by name', async () => {
      await useCases.joinRoom.execute(alice, roomId);
      await useCases.joinRoom.execute(bob, roomId);
      const { state } = await useCases.joinRoom.execute(host, roomId);

      expect(state.members[0]?.role).toBe('host');
      expect(state.members.slice(1).map((m) => m.user.displayName)).toEqual(['Alice', 'Bob']);
    });

    it('carries recent chat so a joiner is not staring at a blank room', async () => {
      await useCases.joinRoom.execute(alice, roomId);
      await useCases.sendChatMessage.execute(alice, { roomId, text: 'anyone around?' });

      const { state } = await useCases.joinRoom.execute(bob, roomId);
      expect(state.recentMessages).toHaveLength(1);
      expect(state.recentMessages[0]?.text).toBe('anyone around?');
    });

    it('HIDES a blocked user from the member list and the chat history', async () => {
      await useCases.joinRoom.execute(alice, roomId);
      await useCases.sendChatMessage.execute(alice, { roomId, text: 'hello' });

      await ports.relationships.transition(
        bob.id,
        alice.id,
        'none',
        'blocked',
        { requestedBy: null, blockedBy: bob.id },
        ports.clock.now(),
      );

      const { state } = await useCases.joinRoom.execute(bob, roomId);

      expect(state.members.map((m) => m.user.id)).not.toContain(alice.id);
      expect(state.recentMessages).toHaveLength(0);
    });

    it('never leaks a member’s private fields', async () => {
      await useCases.joinRoom.execute(alice, roomId);
      const { state } = await useCases.joinRoom.execute(bob, roomId);

      const serialized = JSON.stringify(state);
      expect(serialized).not.toContain('alice@example.com');
      expect(serialized).not.toContain('1995-01-01');
    });

    it('is a FULL snapshot on reconnect, reflecting what changed while away', async () => {
      await useCases.joinRoom.execute(alice, roomId);
      const first = await useCases.joinRoom.execute(bob, roomId);
      expect(first.state.members).toHaveLength(2);

      await useCases.leaveRoom.execute({ userId: alice.id, roomId });

      // Bob reconnects: the snapshot is correct without him having to
      // reconcile anything he may have missed.
      const reconnected = await useCases.joinRoom.execute(bob, roomId);
      expect(reconnected.state.members).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  describe('leaving', () => {
    it('removes presence and tells the room', async () => {
      await useCases.joinRoom.execute(alice, roomId);
      ports.recorder.clear();

      await useCases.leaveRoom.execute({ userId: alice.id, roomId });

      expect(await ports.presence.getMember(roomId, alice.id)).toBeNull();
      expect(ports.recorder.emissionsTo(roomId, 'user:left')).toHaveLength(1);
    });

    it('closes the durable membership row', async () => {
      await useCases.joinRoom.execute(alice, roomId);
      await useCases.leaveRoom.execute({ userId: alice.id, roomId });

      expect(await ports.rooms.findMembership(roomId, alice.id)).toBeNull();
    });

    it('is IDEMPOTENT — leaving twice announces once', async () => {
      // This runs from three places at once in production: an explicit
      // room:leave, the socket disconnect handler, and the presence reaper.
      await useCases.joinRoom.execute(alice, roomId);
      ports.recorder.clear();

      await useCases.leaveRoom.execute({ userId: alice.id, roomId });
      await useCases.leaveRoom.execute({ userId: alice.id, roomId });

      expect(ports.recorder.emissionsTo(roomId, 'user:left')).toHaveLength(1);
    });

    it('credits a real session to the trust ledger', async () => {
      await useCases.joinRoom.execute(alice, roomId);
      ports.clock.advanceMs(MIN_SESSION_MS + 1000);
      await useCases.leaveRoom.execute({ userId: alice.id, roomId });

      const events = await ports.users.listTrustEvents(alice.id, 10);
      expect(events.some((e) => e.reason === 'room_session_completed')).toBe(true);
    });

    it('does NOT credit a drive-by visit', async () => {
      // Otherwise join/leave churn is a trust-farming loop that unlocks DMs.
      await useCases.joinRoom.execute(alice, roomId);
      ports.clock.advanceMs(5_000);
      await useCases.leaveRoom.execute({ userId: alice.id, roomId });

      const events = await ports.users.listTrustEvents(alice.id, 10);
      expect(events.some((e) => e.reason === 'room_session_completed')).toBe(false);
    });

    it('does not credit a kick or a ban', async () => {
      await useCases.joinRoom.execute(alice, roomId);
      ports.clock.advanceMs(MIN_SESSION_MS + 1000);
      await useCases.leaveRoom.execute({ userId: alice.id, roomId, reason: 'kicked' });

      const events = await ports.users.listTrustEvents(alice.id, 10);
      expect(events.some((e) => e.reason === 'room_session_completed')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe('presence expiry and the heartbeat', () => {
    it('keeps a member alive while they heartbeat', async () => {
      await useCases.joinRoom.execute(alice, roomId);

      for (let i = 0; i < 5; i += 1) {
        ports.clock.advanceSeconds(PRESENCE_TTL_SECONDS - 5);
        const result = await useCases.heartbeat.execute({
          userId: alice.id,
          claimedRooms: [roomId],
        });
        expect(result.refreshed).toContain(roomId);
        expect(result.staleRooms).toHaveLength(0);
      }

      expect(await ports.presence.countRoomMembers(roomId)).toBe(1);
    });

    it('reports a lapsed room as stale rather than resurrecting it', async () => {
      // Silently reviving would leave this client's member list permanently out
      // of step with everyone else's, who already saw them leave.
      await useCases.joinRoom.execute(alice, roomId);
      ports.clock.advanceSeconds(PRESENCE_TTL_SECONDS + 1);

      const result = await useCases.heartbeat.execute({ userId: alice.id, claimedRooms: [roomId] });
      expect(result.refreshed).toHaveLength(0);
      expect(result.staleRooms).toContain(roomId);
    });

    it('a member who stops heartbeating disappears from the room', async () => {
      await useCases.joinRoom.execute(alice, roomId);
      await useCases.joinRoom.execute(bob, roomId);

      ports.clock.advanceSeconds(PRESENCE_TTL_SECONDS + 1);
      await useCases.heartbeat.execute({ userId: bob.id, claimedRooms: [roomId] }); // bob keeps going... but has lapsed too

      expect(await ports.presence.countRoomMembers(roomId)).toBe(0);
    });

    it('the reaper returns what it removed so departures can be announced', async () => {
      await useCases.joinRoom.execute(alice, roomId);
      ports.clock.advanceSeconds(PRESENCE_TTL_SECONDS + 1);

      const reaped = await ports.presence.reapExpired();
      expect(reaped.map((entry) => entry.userId)).toContain(alice.id);

      // Idempotent: a second sweep must not re-announce the same departure.
      expect(await ports.presence.reapExpired()).toHaveLength(0);
    });

    it('a heartbeat from someone in no rooms is harmless', async () => {
      // An older client that names nothing, from a user who is genuinely in no
      // rooms: neither refreshed nor stale, and certainly not an error.
      const result = await useCases.heartbeat.execute({ userId: alice.id });
      expect(result).toEqual({ refreshed: [], staleRooms: [] });
    });

    it('reports a room the CLIENT claims but the server has forgotten', async () => {
      // The asymmetric-knowledge case: the server reaped the entry and has
      // nothing to report, while the client is still rendering the room. Only
      // the client's claim can surface this.
      await useCases.joinRoom.execute(alice, roomId);
      ports.clock.advanceSeconds(PRESENCE_TTL_SECONDS + 1);
      await ports.presence.reapExpired();

      // The server now knows of no rooms for alice at all.
      expect(await ports.presence.getRoomsForUser(alice.id)).toHaveLength(0);

      const result = await useCases.heartbeat.execute({
        userId: alice.id,
        claimedRooms: [roomId],
      });
      expect(result.staleRooms).toContain(roomId);
    });

    it('never CREATES presence from a claimed room', async () => {
      // Which is why accepting the client's list is safe: it is a question,
      // not an assertion.
      await useCases.heartbeat.execute({ userId: bob.id, claimedRooms: [roomId] });
      expect(await ports.presence.getMember(roomId, bob.id)).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe('chat', () => {
    beforeEach(async () => {
      await useCases.joinRoom.execute(alice, roomId);
      await useCases.joinRoom.execute(bob, roomId);
      ports.recorder.clear();
    });

    it('broadcasts to the room INCLUDING the sender', async () => {
      // The sender sees the message the server accepted, with its id and
      // timestamp — not an optimistic local render that may differ.
      await useCases.sendChatMessage.execute(alice, { roomId, text: 'hello everyone' });

      const emissions = ports.recorder.emissionsTo(roomId, 'chat:message');
      expect(emissions).toHaveLength(1);
      expect(emissions[0]?.target).not.toHaveProperty('exceptUserId');
    });

    it('refuses someone who is not in the room', async () => {
      await expect(
        useCases.sendChatMessage.execute(host, { roomId, text: 'sneaking in' }),
      ).rejects.toThrow(/not in this room/i);
    });

    it('refuses someone whose presence has lapsed', async () => {
      // Authorization reads LIVE presence, not the durable row — someone who
      // left thirty seconds ago must not still be able to talk.
      ports.clock.advanceSeconds(PRESENCE_TTL_SECONDS + 1);
      await expect(
        useCases.sendChatMessage.execute(alice, { roomId, text: 'still here?' }),
      ).rejects.toThrow(/not in this room/i);
    });

    it('a host mute silences TEXT, not just audio', async () => {
      await ports.presence.setMutedByHost(roomId, alice.id, true);
      await expect(
        useCases.sendChatMessage.execute(alice, { roomId, text: 'and another thing' }),
      ).rejects.toThrow(/muted/i);
    });

    it('validates the message through the domain', async () => {
      await expect(
        useCases.sendChatMessage.execute(alice, { roomId, text: '   ' }),
      ).rejects.toThrow(/empty/i);

      await expect(
        useCases.sendChatMessage.execute(alice, { roomId, text: 'x'.repeat(501) }),
      ).rejects.toThrow(/500 characters/);
    });

    it('rejects a message carrying a bidi override', async () => {
      await expect(
        useCases.sendChatMessage.execute(alice, {
          roomId,
          text: `looks fine${String.fromCodePoint(0x202e)}but is not`,
        }),
      ).rejects.toThrow(/not allowed/i);
    });

    it('is rate limited per user PER ROOM', async () => {
      for (let i = 0; i < LIMITS.chatSend.limit; i += 1) {
        await useCases.sendChatMessage.execute(alice, { roomId, text: `message ${i}` });
      }
      await expect(
        useCases.sendChatMessage.execute(alice, { roomId, text: 'one too many' }),
      ).rejects.toThrow(/too quickly/i);

      // Bob is unaffected — being throttled is per-person, not per-room.
      await expect(
        useCases.sendChatMessage.execute(bob, { roomId, text: 'bob can still talk' }),
      ).resolves.toBeTruthy();
    });

    it('keeps only a bounded buffer of history', async () => {
      // Room chat is ephemeral by product design (ADR 0006).
      ports.rateLimiter.disabled = true;

      for (let i = 0; i < ROOM_BUFFER_SIZE + 15; i += 1) {
        await useCases.sendChatMessage.execute(alice, { roomId, text: `message ${i}` });
      }

      const { state } = await useCases.joinRoom.execute(host, roomId);
      expect(state.recentMessages).toHaveLength(ROOM_BUFFER_SIZE);
      expect(state.recentMessages[0]?.text).toBe('message 15');
    });
  });

  // -------------------------------------------------------------------------
  describe('typing indicators', () => {
    beforeEach(async () => {
      await useCases.joinRoom.execute(alice, roomId);
      ports.recorder.clear();
    });

    it('goes to everyone except the typist', async () => {
      await useCases.sendTypingIndicator.execute(alice, roomId);

      const emissions = ports.recorder.emissionsTo(roomId, 'chat:typing');
      expect(emissions).toHaveLength(1);
      expect(emissions[0]?.target).toMatchObject({ exceptUserId: alice.id });
    });

    it('is DROPPED rather than thrown when rate limited', async () => {
      // A user should not see an error for typing quickly, and there is nothing
      // useful for the client to do about one.
      for (let i = 0; i < LIMITS.chatTyping.limit + 5; i += 1) {
        await expect(useCases.sendTypingIndicator.execute(alice, roomId)).resolves.toBeUndefined();
      }
      expect(ports.recorder.emissionsTo(roomId, 'chat:typing').length).toBeLessThanOrEqual(
        LIMITS.chatTyping.limit,
      );
    });

    it('stays silent for a host-muted member', async () => {
      await ports.presence.setMutedByHost(roomId, alice.id, true);
      ports.recorder.clear();

      await useCases.sendTypingIndicator.execute(alice, roomId);
      expect(ports.recorder.emissionsTo(roomId, 'chat:typing')).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('reactions', () => {
    beforeEach(async () => {
      await useCases.joinRoom.execute(alice, roomId);
      ports.recorder.clear();
    });

    it('broadcasts an allowed reaction', async () => {
      await useCases.sendReaction.execute(alice, { roomId, reaction: 'heart' });
      expect(ports.recorder.emissionsTo(roomId, 'reaction:shown')).toHaveLength(1);
    });

    it('REFUSES an arbitrary glyph', async () => {
      // An open emoji field is a free-form text channel and a known route
      // around chat moderation.
      await expect(
        useCases.sendReaction.execute(alice, { roomId, reaction: '🖕' }),
      ).rejects.toThrow(/not available/i);

      await expect(
        useCases.sendReaction.execute(alice, { roomId, reaction: '<script>' }),
      ).rejects.toThrow(/not available/i);
    });

    it('refuses a host-muted member', async () => {
      await ports.presence.setMutedByHost(roomId, alice.id, true);
      await expect(
        useCases.sendReaction.execute(alice, { roomId, reaction: 'clap' }),
      ).rejects.toThrow(/muted/i);
    });

    it('is not persisted — a reconnecting client sees no stale reactions', async () => {
      await useCases.sendReaction.execute(alice, { roomId, reaction: 'heart' });
      const { state } = await useCases.joinRoom.execute(bob, roomId);
      expect(state.recentMessages).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('the room list', () => {
    it('orders busy rooms first', async () => {
      const quiet = await useCases.createRoom.execute(host, {
        title: 'Quiet Corner',
        category: 'study',
      });

      await useCases.joinRoom.execute(alice, roomId);
      await useCases.joinRoom.execute(bob, roomId);

      const rooms = await useCases.listRooms.execute();
      expect(rooms[0]?.id).toBe(roomId);
      expect(rooms[0]?.memberCount).toBe(2);
      expect(rooms.find((r) => r.id === quiet.id)?.memberCount).toBe(0);
    });

    it('filters by category', async () => {
      await useCases.createRoom.execute(host, { title: 'Study Hall', category: 'study' });

      const rooms = await useCases.listRooms.execute({ category: 'study' });
      expect(rooms).toHaveLength(1);
      expect(rooms[0]?.title).toBe('Study Hall');
    });

    it('hides closed rooms', async () => {
      await ports.rooms.updateStatus(roomId, 'closed');
      expect(await useCases.listRooms.execute()).toHaveLength(0);
    });

    it('clamps an absurd limit rather than failing', async () => {
      await expect(useCases.listRooms.execute({ limit: 100_000 })).resolves.toBeTruthy();
    });

    it('rejects an unknown category', async () => {
      await expect(useCases.listRooms.execute({ category: 'nope' })).rejects.toThrow(/category/i);
    });
  });

  // -------------------------------------------------------------------------
  describe('ten users in one room', () => {
    it('holds correct presence for all of them', async () => {
      // The Phase 2 exit criterion, as a unit test. The socket-level version
      // lives in scripts/roomLoadCheck.ts.
      ports.rateLimiter.disabled = true;

      const crowd: User[] = [];
      for (let i = 0; i < 10; i += 1) {
        crowd.push(await makeUser(`User${String(i).padStart(2, '0')}`));
      }

      for (const user of crowd) {
        await useCases.joinRoom.execute(user, roomId);
      }
      expect(await ports.presence.countRoomMembers(roomId)).toBe(10);

      // Everyone talks.
      for (const user of crowd) {
        await useCases.sendChatMessage.execute(user, {
          roomId,
          text: `hi from ${user.displayName}`,
        });
      }

      // The last joiner's snapshot sees everyone and every message.
      const { state } = await useCases.joinRoom.execute(crowd[0]!, roomId);
      expect(state.members).toHaveLength(10);
      expect(state.recentMessages).toHaveLength(10);

      // Half of them drop off without saying goodbye.
      for (const user of crowd.slice(0, 5)) {
        await ports.presence.setOffline(roomId, user.id);
      }
      expect(await ports.presence.countRoomMembers(roomId)).toBe(5);
    });
  });
});
