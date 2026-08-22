import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createRoom,
  sleep,
  startSocketHarness,
  type SocketHarness,
  type TestClient,
} from './harness.js';
import type { User } from '../../src/domain/entities/User.js';
import type { RoomId } from '../../src/domain/values/ids.js';
import { callRoomId } from '../../src/domain/values/ids.js';

/**
 * PHASE 5 OVER A REAL SOCKET.
 *
 * WHY THIS EXISTS ALONGSIDE tests/app/connections.test.ts
 * -------------------------------------------------------
 * That suite proves the RULES. This one proves the EDGE actually reaches them,
 * and the edge is where the previous audit found every one of its real bugs —
 * none of which any use-case test could have seen:
 *
 *   - a handler registered under a name nothing sends, so it silently does
 *     nothing forever;
 *   - a client-supplied id trusted somewhere between the schema and the use
 *     case;
 *   - a domain error thrown inside an async socket listener, which is an
 *     unhandled rejection and takes the process down;
 *   - an event delivered to the wrong socket — which for a media token means
 *     handing a microphone credential to someone else's device.
 *
 * The last one is why several tests below assert on which client did NOT
 * receive something. In a broadcast bug the happy path still looks perfect.
 */
describe('connections over sockets', () => {
  let harness: SocketHarness;

  let alice: User;
  let bob: User;
  let mallory: User;
  let roomId: RoomId;

  const clients: TestClient[] = [];

  /**
   * Connect, remember it for cleanup, and widen `next` to mean "the event,
   * whether or not it has already arrived".
   *
   * WHY THE OVERRIDE
   * ----------------
   * The harness's `next` snapshots how many of an event it has seen and then
   * waits for one MORE. That is right for "did another one arrive?", and wrong
   * for almost everything here, because one action produces events on two
   * sockets at once: by the time a test has awaited the recipient's copy, the
   * sender's echo has already landed, and a forward-only wait sits there until
   * it times out.
   *
   * The failure mode is what makes this worth a comment — the test does not
   * report "already arrived", it reports "never arrived", which reads exactly
   * like the delivery bug it was written to catch.
   */
  const connect = async (user: User): Promise<TestClient> => {
    const client = await harness.connect(user);
    clients.push(client);

    return {
      ...client,
      async next<T>(event: string, timeoutMs = 2_000): Promise<T | null> {
        await client.until(() => client.all(event).length > 0, timeoutMs);
        const seen = client.all<T>(event);
        return seen.length > 0 ? seen[seen.length - 1]! : null;
      },
    };
  };

  /**
   * The evidence rung 3 needs: overlapping time in one room.
   *
   * A REAL sleep, not a clock advance. This harness runs on wall time on
   * purpose — a real socket server's own timers do — so `clock.advanceSeconds`
   * is inert here, both sessions would start and end in the same millisecond,
   * and `haveSharedRoomSession` correctly reports no overlap for two intervals
   * that merely touch. Fifty milliseconds is plenty to make the overlap real.
   */
  const shareARoom = async (a: User, b: User): Promise<void> => {
    await harness.useCases.joinRoom.execute(a, roomId);
    await harness.useCases.joinRoom.execute(b, roomId);
    await sleep(50);
    await harness.useCases.leaveRoom.execute({ userId: a.id, roomId, reason: 'left' });
    await harness.useCases.leaveRoom.execute({ userId: b.id, roomId, reason: 'left' });
  };

  const openDm = async (a: User, b: User): Promise<void> => {
    await shareARoom(a, b);
    await harness.useCases.requestDm.execute(await refresh(a), b.id);
    await harness.useCases.acceptDm.execute(await refresh(b), a.id);
  };

  const refresh = async (user: User): Promise<User> =>
    (await harness.ports.users.findById(user.id)) ?? user;

  beforeAll(async () => {
    harness = await startSocketHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    for (const client of clients.splice(0)) client.disconnect();

    alice = await harness.createUser('Alice');
    bob = await harness.createUser('Bob');
    mallory = await harness.createUser('Mallory');
    roomId = await createRoom(harness, alice);
  });

  // ==========================================================================
  describe('dm:request', () => {
    it('reaches the person asked, over their own socket', async () => {
      await shareARoom(alice, bob);

      const aliceClient = await connect(alice);
      const bobClient = await connect(bob);

      aliceClient.emit('dm:request', { userId: bob.id });

      const requested = await bobClient.next<{ fromUserId: string }>('dm:requested');
      expect(requested?.fromUserId).toBe(alice.id);
    });

    it('is REFUSED without a shared room, and says so over the socket', async () => {
      const aliceClient = await connect(alice);
      const mallorysClient = await connect(mallory);

      aliceClient.emit('dm:request', { userId: mallory.id });

      const error = await aliceClient.next<{ code: string }>('error');
      expect(error?.code).toBe('TRUST_LADDER_VIOLATION');

      // And nothing reached the person who was never legitimately reachable.
      expect(mallorysClient.all('dm:requested')).toHaveLength(0);
    });

    it('a malformed payload is refused without killing the connection', async () => {
      const aliceClient = await connect(alice);

      // An async listener that throws is an unhandled rejection; the process
      // would die and every other user's call would drop with it.
      aliceClient.emit('dm:request', { userId: 'not-a-uuid' });

      const error = await aliceClient.next<{ code: string }>('error');
      expect(error?.code).toBe('VALIDATION_FAILED');
      expect(aliceClient.socket.connected).toBe(true);
    });

    it('opens the conversation for BOTH parties when accepted', async () => {
      await shareARoom(alice, bob);

      const aliceClient = await connect(alice);
      const bobClient = await connect(bob);

      aliceClient.emit('dm:request', { userId: bob.id });
      await bobClient.next('dm:requested');

      bobClient.emit('dm:accept', { userId: alice.id });

      const forAlice = await aliceClient.next<{ withUserId: string }>('dm:opened');
      const forBob = await bobClient.next<{ withUserId: string }>('dm:opened');

      // Symmetric, because the conversation now is.
      expect(forAlice?.withUserId).toBe(bob.id);
      expect(forBob?.withUserId).toBe(alice.id);
    });

    it('DECLINING TELLS THE REQUESTER NOTHING', async () => {
      await shareARoom(alice, bob);

      const aliceClient = await connect(alice);
      const bobClient = await connect(bob);

      aliceClient.emit('dm:request', { userId: bob.id });
      await bobClient.next('dm:requested');
      aliceClient.clear();

      bobClient.emit('dm:decline', { userId: alice.id });

      // Not "declined", not an error, nothing. From Alice's side this is
      // indistinguishable from a request Bob has not answered yet — which is
      // the kindest available ambiguity, and the one Bob chose.
      expect(await aliceClient.next('dm:opened', 300)).toBeNull();
      expect(aliceClient.all('error')).toHaveLength(0);
    });
  });

  // ==========================================================================
  describe('dm:message', () => {
    it('is refused when the DM was only requested, never accepted', async () => {
      await shareARoom(alice, bob);
      await harness.useCases.requestDm.execute(await refresh(alice), bob.id);

      const aliceClient = await connect(alice);
      const bobClient = await connect(bob);

      aliceClient.emit('dm:message', { userId: bob.id, text: 'hello?' });

      const error = await aliceClient.next<{ code: string }>('error');
      expect(error?.code).toBe('TRUST_LADDER_VIOLATION');
      expect(bobClient.all('dm:message')).toHaveLength(0);
    });

    it('arrives at the recipient and echoes to the sender', async () => {
      await openDm(alice, bob);

      const aliceClient = await connect(alice);
      const bobClient = await connect(bob);

      aliceClient.emit('dm:message', { userId: bob.id, text: 'hey' });

      const received = await bobClient.next<{ text: string }>('dm:message');
      const echoed = await aliceClient.next<{ text: string }>('dm:message');

      expect(received?.text).toBe('hey');
      expect(echoed?.text).toBe('hey');
    });

    it('DOES NOT REACH ANYONE ELSE', async () => {
      await openDm(alice, bob);

      const aliceClient = await connect(alice);
      await connect(bob);
      const mallorysClient = await connect(mallory);

      aliceClient.emit('dm:message', { userId: bob.id, text: 'private' });
      await aliceClient.next('dm:message');

      // A DM broadcast to a room channel would look completely correct to both
      // participants. This is the only assertion that catches it.
      expect(mallorysClient.all('dm:message')).toHaveLength(0);
    });

    it('a block stops the very next message', async () => {
      await openDm(alice, bob);
      const aliceClient = await connect(alice);
      const bobClient = await connect(bob);

      aliceClient.emit('dm:message', { userId: bob.id, text: 'one' });
      await bobClient.next('dm:message');

      await harness.useCases.blockUser.execute(await refresh(bob), alice.id);
      aliceClient.clear();
      bobClient.clear();

      aliceClient.emit('dm:message', { userId: bob.id, text: 'two' });

      const error = await aliceClient.next<{ code: string }>('error');
      expect(error?.code).toBe('BLOCKED');
      expect(bobClient.all('dm:message')).toHaveLength(0);
    });
  });

  // ==========================================================================
  describe('call signalling', () => {
    it('rings the recipient without handing them a token', async () => {
      await openDm(alice, bob);

      const aliceClient = await connect(alice);
      const bobClient = await connect(bob);

      aliceClient.emit('call:invite', { userId: bob.id });

      const incoming = await bobClient.next<Record<string, unknown>>('call:incoming');
      expect(incoming).not.toBeNull();
      expect(JSON.stringify(incoming)).not.toContain('token');
    });

    it('does not tell the CALLER the call was accepted merely for dialling', async () => {
      await openDm(alice, bob);

      const aliceClient = await connect(alice);
      const bobClient = await connect(bob);

      aliceClient.emit('call:invite', { userId: bob.id });
      await bobClient.next('call:incoming');

      // Acknowledging the dial with `call:accepted` would make the caller's UI
      // show a connected call to a phone still ringing.
      expect(await aliceClient.next('call:accepted', 300)).toBeNull();
    });

    it('connects both sides, each with their own token', async () => {
      await openDm(alice, bob);

      const aliceClient = await connect(alice);
      const bobClient = await connect(bob);

      aliceClient.emit('call:invite', { userId: bob.id });
      await bobClient.next('call:incoming');

      bobClient.emit('call:accept', { userId: alice.id });

      const forBob = await bobClient.next<{
        callRoomId: string;
        mediaToken: { token: string };
      }>('call:accepted');
      const forAlice = await aliceClient.next<{
        callRoomId: string;
        mediaToken: { token: string };
      }>('call:accepted');

      const expected = callRoomId(alice.id, bob.id);
      expect(forBob?.callRoomId).toBe(expected);
      expect(forAlice?.callRoomId).toBe(expected);

      // Same room, DIFFERENT credentials. A shared token would let either
      // party's leak grant the other's identity in the room.
      expect(forBob?.mediaToken.token).not.toBe(forAlice?.mediaToken.token);
    });

    it('NEVER SENDS A MEDIA TOKEN TO A THIRD PARTY', async () => {
      await openDm(alice, bob);

      const aliceClient = await connect(alice);
      const bobClient = await connect(bob);
      const mallorysClient = await connect(mallory);

      aliceClient.emit('call:invite', { userId: bob.id });
      await bobClient.next('call:incoming');
      bobClient.emit('call:accept', { userId: alice.id });
      await bobClient.next('call:accepted');

      // A token is a credential to open a microphone in a two-person room.
      expect(mallorysClient.all('call:accepted')).toHaveLength(0);
      expect(mallorysClient.all('call:incoming')).toHaveLength(0);
    });

    it('refuses a caller trying to accept their own call', async () => {
      await openDm(alice, bob);

      const aliceClient = await connect(alice);
      const bobClient = await connect(bob);

      aliceClient.emit('call:invite', { userId: bob.id });
      await bobClient.next('call:incoming');
      aliceClient.clear();

      aliceClient.emit('call:accept', { userId: bob.id });

      const error = await aliceClient.next<{ code: string }>('error');
      expect(error?.code).toBe('NO_PENDING_CALL');

      // The critical part: Bob's client was never told the call connected, so
      // it never joined audio he did not answer.
      expect(bobClient.all('call:accepted')).toHaveLength(0);
    });

    it('refuses a call to someone with no open DM', async () => {
      const aliceClient = await connect(alice);
      const mallorysClient = await connect(mallory);

      aliceClient.emit('call:invite', { userId: mallory.id });

      const error = await aliceClient.next<{ code: string }>('error');
      expect(error?.code).toBe('TRUST_LADDER_VIOLATION');
      expect(mallorysClient.all('call:incoming')).toHaveLength(0);
    });

    it('declining reaches the caller and frees the line', async () => {
      await openDm(alice, bob);

      const aliceClient = await connect(alice);
      const bobClient = await connect(bob);

      aliceClient.emit('call:invite', { userId: bob.id });
      await bobClient.next('call:incoming');

      bobClient.emit('call:decline', { userId: alice.id });
      const declined = await aliceClient.next<{ withUserId: string }>('call:declined');
      expect(declined?.withUserId).toBe(bob.id);

      // And the pair can call again immediately, without waiting out a timeout.
      aliceClient.clear();
      bobClient.clear();
      aliceClient.emit('call:invite', { userId: bob.id });
      expect(await bobClient.next('call:incoming')).not.toBeNull();
    });

    it('reports a busy line as CALL_BUSY, not a flat refusal', async () => {
      await openDm(alice, bob);

      const aliceClient = await connect(alice);
      const bobClient = await connect(bob);

      aliceClient.emit('call:invite', { userId: bob.id });
      await bobClient.next('call:incoming');
      bobClient.clear();

      bobClient.emit('call:invite', { userId: alice.id });

      // A retryable state must not arrive as FORBIDDEN — the client would
      // stop offering the retry.
      const error = await bobClient.next<{ code: string }>('error');
      expect(error?.code).toBe('CALL_BUSY');
    });
  });

  // ==========================================================================
  describe('ordering and identity at the edge', () => {
    it('processes a request and an accept in the order they were sent', async () => {
      await shareARoom(alice, bob);

      const aliceClient = await connect(alice);
      const bobClient = await connect(bob);

      aliceClient.emit('dm:request', { userId: bob.id });
      await bobClient.next('dm:requested');

      // Fired back to back with no await between: the accept must not be
      // processed before the request it answers.
      bobClient.emit('dm:accept', { userId: alice.id });
      bobClient.emit('dm:message', { userId: alice.id, text: 'first words' });

      const message = await aliceClient.next<{ text: string }>('dm:message');
      expect(message?.text).toBe('first words');
    });

    it('never trusts a client-claimed sender identity', async () => {
      await openDm(alice, bob);

      const mallorysClient = await connect(mallory);
      const bobClient = await connect(bob);

      // Mallory emits a message "to" Bob, who has an open DM with Alice — not
      // with her. The only identity that counts is the one on her socket.
      mallorysClient.emit('dm:message', { userId: bob.id, text: 'hi from alice' });

      const error = await mallorysClient.next<{ code: string }>('error');
      expect(error?.code).toBe('TRUST_LADDER_VIOLATION');
      expect(bobClient.all('dm:message')).toHaveLength(0);
    });

    it('a banned account is severed mid-conversation', async () => {
      await openDm(alice, bob);

      const aliceClient = await connect(alice);
      await connect(bob);

      await harness.ports.users.updateStatus(alice.id, 'banned');

      aliceClient.emit('dm:message', { userId: bob.id, text: 'still here?' });

      // Re-reading the actor per event is what makes moderation take effect in
      // seconds rather than whenever the client next reconnects.
      const error = await aliceClient.next<{ code: string }>('error');
      expect(error?.code).toBe('BANNED');
      await aliceClient.until(() => !aliceClient.socket.connected, 2_000);
      expect(aliceClient.socket.connected).toBe(false);
    });
  });
});
