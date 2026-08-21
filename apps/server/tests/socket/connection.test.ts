import { afterEach, describe, expect, it } from 'vitest';
import { startSocketHarness, sleep, type SocketHarness } from './harness.js';
import { startPresenceReaper } from '../../src/adapters/socketio/presenceReaper.js';

/**
 * Socket connection lifecycle: authentication, presence integrity, and races.
 *
 * These are the behaviours that only appear over a REAL socket. A use-case test
 * cannot tell you whether an expired token is rejected at the handshake, or
 * whether a client that vanishes without warning is eventually removed from the
 * room, because neither question exists until there is a connection to lose.
 *
 * Presence tests use a deliberately short TTL so the suite waits seconds rather
 * than a minute. The harness runs on wall-clock time on purpose — the transport
 * underneath has its own timers, and a frozen clock would put the two out of
 * step in a way that hides exactly the bugs being hunted here.
 */
describe('socket connection lifecycle', () => {
  let harness: SocketHarness | null = null;

  afterEach(async () => {
    await harness?.close();
    harness = null;
  });

  // -------------------------------------------------------------------------
  describe('authentication at the handshake', () => {
    it('REFUSES a connection with no token', async () => {
      harness = await startSocketHarness();
      const result = await harness.connectRaw();

      expect(result.connected).toBe(false);
      expect(result.error).toBe('UNAUTHENTICATED');
    });

    it('refuses an empty token', async () => {
      harness = await startSocketHarness();
      expect((await harness.connectRaw('')).connected).toBe(false);
    });

    it('refuses a garbage token', async () => {
      harness = await startSocketHarness();
      const result = await harness.connectRaw('not-a-real-token');

      expect(result.connected).toBe(false);
      expect(result.error).toBe('UNAUTHENTICATED');
    });

    it('refuses a REFRESH token presented at the handshake', async () => {
      // A refresh token outlives every ban. Accepting one here would be a
      // quiet, total privilege escalation.
      harness = await startSocketHarness();
      const alice = await harness.createUser('Alice');
      const refresh = await harness.ports.tokens.issueRefreshToken(alice.id, 'session-x');

      expect((await harness.connectRaw(refresh.token)).connected).toBe(false);
    });

    it('accepts a valid access token', async () => {
      harness = await startSocketHarness();
      const alice = await harness.createUser('Alice');
      const token = await harness.tokenFor(alice);

      expect((await harness.connectRaw(token)).connected).toBe(true);
    });

    it('refuses a token whose session was revoked', async () => {
      harness = await startSocketHarness();
      const alice = await harness.createUser('Alice');
      const token = await harness.tokenFor(alice);

      await harness.ports.tokens.revokeAllSessions(alice.id);

      expect((await harness.connectRaw(token)).connected).toBe(false);
    });

    it('refuses a BANNED user even with a valid token', async () => {
      // Status is checked at the handshake, which closes the window between a
      // ban being issued and that user's next connection attempt.
      harness = await startSocketHarness();
      const alice = await harness.createUser('Alice');
      const token = await harness.tokenFor(alice);

      await harness.ports.users.updateStatus(alice.id, 'banned');

      const result = await harness.connectRaw(token);
      expect(result.connected).toBe(false);
      expect(result.error).toBe('BANNED');
    });

    it('SEVERS a live socket when the account is banned mid-session', async () => {
      // The other half of enforcement: the handshake check cannot help someone
      // who is already connected.
      harness = await startSocketHarness();
      const alice = await harness.createUser('Alice');
      const client = await harness.connect(alice);

      const room = await harness.useCases.createRoom.execute(alice, {
        title: 'Ban Room',
        category: 'casual',
      });
      client.emit('room:join', { roomId: room.id });
      await client.next('room:state');

      await harness.ports.users.updateStatus(alice.id, 'banned');

      // The next thing they try is refused AND the socket is closed, rather
      // than the ban taking effect only on their next reconnect.
      client.emit('chat:send', { roomId: room.id, text: 'still here' });

      const dropped = await client.until(() => !client.socket.connected, 3_000);
      expect(dropped).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe('presence integrity', () => {
    it('removes a client that vanishes without room:leave, and tells the room', async () => {
      // The defining presence problem: a phone locks, a tunnel swallows the
      // connection, and no leave event is ever sent.
      harness = await startSocketHarness({ presenceTtlSeconds: 2 });

      const alice = await harness.createUser('Alice');
      const bob = await harness.createUser('Bob');

      const room = await harness.useCases.createRoom.execute(alice, {
        title: 'Ghost Room',
        category: 'casual',
      });

      const aliceClient = await harness.connect(alice);
      const bobClient = await harness.connect(bob);

      aliceClient.emit('room:join', { roomId: room.id });
      await aliceClient.next('room:state');
      bobClient.emit('room:join', { roomId: room.id });
      await bobClient.next('room:state');

      expect(await harness.ports.presence.countRoomMembers(room.id)).toBe(2);

      // Run the reaper as production does.
      const stopReaper = startPresenceReaper({
        ports: harness.ports,
        useCases: harness.useCases,
        intervalSeconds: 1,
      });

      try {
        aliceClient.clear();
        bobClient.clear();

        // Alice's client dies HARD — no leave event.
        aliceClient.socket.disconnect();

        // Bob keeps heartbeating, exactly as a live client does. Without this
        // the test proves nothing: BOTH would lapse and be reaped, and "the
        // room is empty" would look like success.
        const bobHeartbeat = setInterval(() => {
          bobClient.emit('presence:heartbeat', { rooms: [room.id] });
        }, 500);

        try {
          // Wait past 2x the heartbeat window, as the audit requires.
          await sleep(5_000);

          // Alice is gone, and Bob — who kept talking — is not.
          expect(await harness.ports.presence.countRoomMembers(room.id)).toBe(1);
          expect(await harness.ports.presence.getMember(room.id, bob.id)).not.toBeNull();
          expect(await harness.ports.presence.getMember(room.id, alice.id)).toBeNull();
        } finally {
          clearInterval(bobHeartbeat);
        }

        // And Bob was TOLD, rather than silently holding a stale member list.
        const departures = bobClient.all<{ userId: string }>('user:left');
        expect(departures.some((d) => d.userId === alice.id)).toBe(true);
      } finally {
        stopReaper();
        bobClient.disconnect();
      }
    }, 20_000);

    it('restores the UI exactly on reconnect via the room:state snapshot', async () => {
      harness = await startSocketHarness({ presenceTtlSeconds: 30 });

      const alice = await harness.createUser('Alice');
      const bob = await harness.createUser('Bob');
      const room = await harness.useCases.createRoom.execute(alice, {
        title: 'Reconnect Room',
        category: 'casual',
      });

      const aliceClient = await harness.connect(alice);
      aliceClient.emit('room:join', { roomId: room.id });
      await aliceClient.next('room:state');

      const bobClient = await harness.connect(bob);
      bobClient.emit('room:join', { roomId: room.id });
      await bobClient.next('room:state');

      aliceClient.emit('chat:send', { roomId: room.id, text: 'before the drop' });
      await bobClient.next('chat:message');

      // Bob's connection dies and comes back on a NEW socket.
      bobClient.disconnect();
      await sleep(300);

      const bobAgain = await harness.connect(bob);
      bobAgain.emit('room:join', { roomId: room.id });

      const snapshot = await bobAgain.next<{
        members: { user: { id: string } }[];
        recentMessages: { text: string }[];
        selfRole: string;
      }>('room:state');

      expect(snapshot).not.toBeNull();
      // Everything the UI needs, in one message: who is here, what was said,
      // and what this user is allowed to do.
      expect(snapshot?.members.map((m) => m.user.id).sort()).toEqual([alice.id, bob.id].sort());
      expect(snapshot?.recentMessages.some((m) => m.text === 'before the drop')).toBe(true);
      expect(snapshot?.selfRole).toBe('listener');

      bobAgain.disconnect();
      aliceClient.disconnect();
    }, 20_000);

    it('cleans up presence when the socket simply closes', async () => {
      harness = await startSocketHarness({ presenceTtlSeconds: 30 });

      const alice = await harness.createUser('Alice');
      const room = await harness.useCases.createRoom.execute(alice, {
        title: 'Disconnect Room',
        category: 'casual',
      });

      const client = await harness.connect(alice);
      client.emit('room:join', { roomId: room.id });
      await client.next('room:state');
      expect(await harness.ports.presence.countRoomMembers(room.id)).toBe(1);

      client.disconnect();

      // The disconnect handler runs immediately — this is the common path, and
      // it must not wait for the TTL.
      await sleep(400);
      expect(await harness.ports.presence.countRoomMembers(room.id)).toBe(0);
    }, 15_000);
  });

  // -------------------------------------------------------------------------
  describe('race conditions', () => {
    it('double-tapping room:join settles at exactly one membership', async () => {
      harness = await startSocketHarness();
      const alice = await harness.createUser('Alice');
      const bob = await harness.createUser('Bob');

      const room = await harness.useCases.createRoom.execute(alice, {
        title: 'Race Room',
        category: 'casual',
      });

      const observer = await harness.connect(alice);
      observer.emit('room:join', { roomId: room.id });
      await observer.next('room:state');
      observer.clear();

      const client = await harness.connect(bob);
      // Five joins fired without waiting — the impatient double-tap, amplified.
      for (let i = 0; i < 5; i += 1) client.emit('room:join', { roomId: room.id });
      await sleep(500);

      expect(await harness.ports.presence.countRoomMembers(room.id)).toBe(2);

      // And the room was told about Bob EXACTLY once, not five times.
      const arrivals = observer
        .all<{ member: { user: { id: string } } }>('user:joined')
        .filter((a) => a.member.user.id === bob.id);
      expect(arrivals).toHaveLength(1);

      client.disconnect();
      observer.disconnect();
    }, 15_000);

    it('join followed immediately by leave settles as left', async () => {
      harness = await startSocketHarness();
      const alice = await harness.createUser('Alice');
      const room = await harness.useCases.createRoom.execute(alice, {
        title: 'Flap Room',
        category: 'casual',
      });

      const client = await harness.connect(alice);
      client.emit('room:join', { roomId: room.id });
      client.emit('room:leave', { roomId: room.id });
      await sleep(400);

      expect(await harness.ports.presence.countRoomMembers(room.id)).toBe(0);
      expect(await harness.ports.rooms.findMembership(room.id, alice.id)).toBeNull();

      client.disconnect();
    }, 15_000);

    it('leaving twice announces the departure only once', async () => {
      harness = await startSocketHarness();
      const alice = await harness.createUser('Alice');
      const bob = await harness.createUser('Bob');
      const room = await harness.useCases.createRoom.execute(alice, {
        title: 'Double Leave',
        category: 'casual',
      });

      const observer = await harness.connect(alice);
      observer.emit('room:join', { roomId: room.id });
      await observer.next('room:state');

      const client = await harness.connect(bob);
      client.emit('room:join', { roomId: room.id });
      await client.next('room:state');
      await sleep(150);
      observer.clear();

      client.emit('room:leave', { roomId: room.id });
      client.emit('room:leave', { roomId: room.id });
      client.emit('room:leave', { roomId: room.id });
      await sleep(400);

      const departures = observer
        .all<{ userId: string }>('user:left')
        .filter((d) => d.userId === bob.id);
      expect(departures).toHaveLength(1);

      client.disconnect();
      observer.disconnect();
    }, 15_000);

    it('two tabs for one user share presence and survive one closing', async () => {
      // Multi-tab is the everyday version of a race: the same user, two sockets,
      // one of which goes away.
      harness = await startSocketHarness({ presenceTtlSeconds: 30 });
      const alice = await harness.createUser('Alice');
      const room = await harness.useCases.createRoom.execute(alice, {
        title: 'Two Tabs',
        category: 'casual',
      });

      const tabA = await harness.connect(alice);
      const tabB = await harness.connect(alice);

      tabA.emit('room:join', { roomId: room.id });
      await tabA.next('room:state');
      tabB.emit('room:join', { roomId: room.id });
      await tabB.next('room:state');

      // One person, one presence entry — not two.
      expect(await harness.ports.presence.countRoomMembers(room.id)).toBe(1);

      // Closing ONE tab must not remove the person from the room — the other
      // tab is still open and still rendering it. Presence is per USER;
      // disconnect is per SOCKET, and conflating them makes anyone with two
      // tabs vanish the moment they close either.
      tabA.disconnect();
      await sleep(500);

      expect(await harness.ports.presence.countRoomMembers(room.id)).toBe(1);
      expect(await harness.ports.presence.getMember(room.id, alice.id)).not.toBeNull();

      // Closing the LAST tab does remove them.
      tabB.disconnect();
      await sleep(500);
      expect(await harness.ports.presence.countRoomMembers(room.id)).toBe(0);
    }, 15_000);
  });
});
