import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startSocketHarness, sleep, type SocketHarness } from './harness.js';
import { LIMITS } from '../../src/domain/ports/RateLimiter.js';
import type { User } from '../../src/domain/entities/User.js';

/**
 * Authorization and abuse controls, verified over a real socket.
 *
 * WHAT THESE PROVE THAT A USE-CASE TEST CANNOT
 * --------------------------------------------
 * A use case is called with a `User` the caller supplies, so a use-case test
 * inherently assumes the identity is correct. These tests attack that
 * assumption from the outside: can a client claim to be someone else, and can
 * it multiply its own allowance by opening a second connection?
 *
 * The second question is the one most often got wrong. Rate limiting that lives
 * in per-socket memory is invisible in every single-connection test and useless
 * in production, where opening a second tab doubles your quota.
 */
describe('socket authorization and limits', () => {
  let harness: SocketHarness;
  let alice: User;
  let bob: User;

  beforeAll(async () => {
    harness = await startSocketHarness();
    alice = await harness.createUser('Alice');
    bob = await harness.createUser('Bob');
  });

  afterAll(async () => {
    await harness.close();
  });

  // -------------------------------------------------------------------------
  describe('identity cannot be claimed by the client', () => {
    it('IGNORES a userId in the payload and uses the authenticated session', async () => {
      const room = await harness.useCases.createRoom.execute(alice, {
        title: 'Identity Room',
        category: 'casual',
      });

      const aliceClient = await harness.connect(alice);
      const bobClient = await harness.connect(bob);

      try {
        aliceClient.emit('room:join', { roomId: room.id });
        await aliceClient.next('room:state');
        bobClient.emit('room:join', { roomId: room.id });
        await bobClient.next('room:state');
        await sleep(100);
        aliceClient.clear();

        // Bob tries to speak AS ALICE by naming her in the payload.
        bobClient.emit('chat:send', {
          roomId: room.id,
          text: 'this should be attributed to Bob',
          userId: alice.id,
          senderId: alice.id,
          from: { id: alice.id, displayName: 'Alice' },
        });

        const message = await aliceClient.next<{ from: { id: string; displayName: string } }>(
          'chat:message',
        );

        expect(message).not.toBeNull();
        // Attributed to the SESSION, not to anything the payload claimed.
        expect(message?.from.id).toBe(bob.id);
        expect(message?.from.displayName).toBe('Bob');
      } finally {
        aliceClient.disconnect();
        bobClient.disconnect();
      }
    });

    it('cannot make someone else leave a room', async () => {
      const room = await harness.useCases.createRoom.execute(alice, {
        title: 'Eviction Room',
        category: 'casual',
      });

      const aliceClient = await harness.connect(alice);
      const bobClient = await harness.connect(bob);

      try {
        aliceClient.emit('room:join', { roomId: room.id });
        await aliceClient.next('room:state');
        bobClient.emit('room:join', { roomId: room.id });
        await bobClient.next('room:state');
        await sleep(100);

        // Bob tries to evict Alice. `room:leave` acts on the SESSION, so the
        // only person he can remove is himself.
        bobClient.emit('room:leave', { roomId: room.id, userId: alice.id });
        await sleep(300);

        expect(await harness.ports.presence.getMember(room.id, alice.id)).not.toBeNull();
        expect(await harness.ports.presence.getMember(room.id, bob.id)).toBeNull();
      } finally {
        aliceClient.disconnect();
        bobClient.disconnect();
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('rate limits are per USER, not per socket', () => {
    it('a second tab does NOT grant a second allowance', async () => {
      // The bug this exists to catch: a limiter kept in per-socket memory looks
      // correct in every single-connection test, and in production anyone
      // doubles their quota by opening another tab.
      const chatter = await harness.createUser('Chatter');
      const room = await harness.useCases.createRoom.execute(chatter, {
        title: 'Two Tab Limit',
        category: 'casual',
      });

      const tabA = await harness.connect(chatter);
      const tabB = await harness.connect(chatter);

      try {
        tabA.emit('room:join', { roomId: room.id });
        await tabA.next('room:state');
        tabB.emit('room:join', { roomId: room.id });
        await tabB.next('room:state');
        await sleep(150);
        tabA.clear();
        tabB.clear();

        // Spend the entire allowance on tab A.
        for (let i = 0; i < LIMITS.chatSend.limit; i += 1) {
          tabA.emit('chat:send', { roomId: room.id, text: `from tab A ${i}` });
        }
        await sleep(400);

        // Tab B is a different socket and the SAME user. It must already be
        // out of allowance.
        tabB.emit('chat:send', { roomId: room.id, text: 'from tab B' });
        await sleep(300);

        const errors = tabB.all<{ code: string }>('error');
        expect(errors.some((e) => e.code === 'RATE_LIMITED')).toBe(true);
      } finally {
        tabA.disconnect();
        tabB.disconnect();
      }
    }, 20_000);

    it('a reconnect does not reset the allowance', async () => {
      // A limiter tied to socket lifetime would hand a fresh quota to anyone
      // who reconnects — which an abusive client does trivially.
      const spammer = await harness.createUser('Spammer');
      const room = await harness.useCases.createRoom.execute(spammer, {
        title: 'Reconnect Limit',
        category: 'casual',
      });

      const first = await harness.connect(spammer);
      first.emit('room:join', { roomId: room.id });
      await first.next('room:state');

      for (let i = 0; i < LIMITS.chatSend.limit; i += 1) {
        first.emit('chat:send', { roomId: room.id, text: `burst ${i}` });
      }
      await sleep(400);
      first.disconnect();
      await sleep(200);

      const second = await harness.connect(spammer);
      try {
        second.emit('room:join', { roomId: room.id });
        await second.next('room:state');
        second.clear();

        second.emit('chat:send', { roomId: room.id, text: 'fresh socket, same person' });
        await sleep(300);

        const errors = second.all<{ code: string }>('error');
        expect(errors.some((e) => e.code === 'RATE_LIMITED')).toBe(true);
      } finally {
        second.disconnect();
      }
    }, 20_000);

    it('limits one user without affecting another', async () => {
      const loud = await harness.createUser('Loud');
      const quiet = await harness.createUser('Quiet');
      const room = await harness.useCases.createRoom.execute(loud, {
        title: 'Shared Room',
        category: 'casual',
      });

      const loudClient = await harness.connect(loud);
      const quietClient = await harness.connect(quiet);

      try {
        loudClient.emit('room:join', { roomId: room.id });
        await loudClient.next('room:state');
        quietClient.emit('room:join', { roomId: room.id });
        await quietClient.next('room:state');
        await sleep(150);
        quietClient.clear();

        for (let i = 0; i < LIMITS.chatSend.limit + 5; i += 1) {
          loudClient.emit('chat:send', { roomId: room.id, text: `loud ${i}` });
        }
        await sleep(400);

        quietClient.clear();
        quietClient.emit('chat:send', { roomId: room.id, text: 'just one from me' });

        const delivered = await quietClient.next<{ text: string }>('chat:message');
        expect(delivered?.text).toBe('just one from me');
        expect(quietClient.all<{ code: string }>('error')).toHaveLength(0);
      } finally {
        loudClient.disconnect();
        quietClient.disconnect();
      }
    }, 20_000);
  });

  // -------------------------------------------------------------------------
  describe('room membership is enforced from server state', () => {
    it('refuses chat from someone who never joined', async () => {
      const room = await harness.useCases.createRoom.execute(alice, {
        title: 'Outsider Room',
        category: 'casual',
      });

      const outsider = await harness.connect(bob);
      try {
        outsider.emit('chat:send', { roomId: room.id, text: 'I am not here' });

        const error = await outsider.next<{ code: string }>('error');
        expect(error).not.toBeNull();
        expect(error?.code).toBe('FORBIDDEN');
      } finally {
        outsider.disconnect();
      }
    });

    it('refuses chat after the sender has left', async () => {
      // Authorization reads LIVE presence, so leaving must take effect at once
      // rather than at the next reconnect.
      const room = await harness.useCases.createRoom.execute(alice, {
        title: 'Left Room',
        category: 'casual',
      });

      const client = await harness.connect(alice);
      try {
        client.emit('room:join', { roomId: room.id });
        await client.next('room:state');

        client.emit('room:leave', { roomId: room.id });
        await sleep(250);
        client.clear();

        client.emit('chat:send', { roomId: room.id, text: 'still talking' });

        const error = await client.next<{ code: string }>('error');
        expect(error?.code).toBe('FORBIDDEN');
      } finally {
        client.disconnect();
      }
    });

    it('a host mute silences text immediately, mid-session', async () => {
      const room = await harness.useCases.createRoom.execute(alice, {
        title: 'Mute Room',
        category: 'casual',
      });

      const client = await harness.connect(bob);
      try {
        client.emit('room:join', { roomId: room.id });
        await client.next('room:state');

        await harness.ports.presence.setMutedByHost(room.id, bob.id, true);
        client.clear();

        client.emit('chat:send', { roomId: room.id, text: 'and another thing' });

        const error = await client.next<{ code: string }>('error');
        expect(error?.code).toBe('FORBIDDEN');
      } finally {
        client.disconnect();
      }
    });
  });
});
