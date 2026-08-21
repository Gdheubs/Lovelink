import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startSocketHarness, sleep, type SocketHarness } from './harness.js';
import type { User } from '../../src/domain/entities/User.js';

/**
 * HOST-ONLY EVENTS, ATTACKED FROM A REAL NON-HOST SOCKET.
 *
 * The audit (A3.2) requires exactly this: emit each host-only event from a
 * socket that is not the host and assert rejection. Use-case tests already
 * prove the rule; these prove the EDGE does not quietly bypass it — that no
 * handler reads a role from the payload, from the socket, or from the client's
 * own belief about itself.
 *
 * A3.6 (media token safety) is proved here too, end to end: a listener's token
 * carries `canPublish=false`, promotion issues a NEW one, and removal revokes
 * at the media server rather than merely telling the client to stop.
 */
describe('host-only events over a real socket', () => {
  let harness: SocketHarness;
  let host: User;
  let alice: User;
  let mallory: User;

  // A FRESH harness per test. The media provider records every token it ever
  // issued, so a shared instance would make "exactly one publishing token was
  // minted" count tokens from earlier tests — the same state-bleed lesson the
  // fuzz suite learned about shared clients.
  beforeEach(async () => {
    harness = await startSocketHarness({ presenceTtlSeconds: 60 });
    host = await harness.createUser('Hosty');
    alice = await harness.createUser('Alice');
    mallory = await harness.createUser('Mallory');
  });

  afterEach(async () => {
    await harness.close();
  });

  /** A room with the three of them in it, and everyone's client connected. */
  async function setUpRoom() {
    const room = await harness.useCases.createRoom.execute(host, {
      title: 'Stage Room',
      category: 'casual',
      maxSpeakers: 3,
    });

    const hostClient = await harness.connect(host);
    const aliceClient = await harness.connect(alice);
    const malloryClient = await harness.connect(mallory);

    for (const [client] of [[hostClient], [aliceClient], [malloryClient]] as const) {
      client.emit('room:join', { roomId: room.id });
      await client.next('room:state');
    }
    await sleep(120);

    return { room, hostClient, aliceClient, malloryClient };
  }

  // -------------------------------------------------------------------------
  it('a LISTENER cannot approve a speaker', async () => {
    const { room, hostClient, aliceClient, malloryClient } = await setUpRoom();

    try {
      malloryClient.clear();
      // Mallory, a listener, tries to give Alice the floor.
      malloryClient.emit('speaker:approve', { roomId: room.id, userId: alice.id });

      const error = await malloryClient.next<{ code: string }>('error');
      expect(error).not.toBeNull();
      expect(error?.code).toBe('NOT_HOST');

      // Alice is still a listener, and was never issued a publishing token.
      expect((await harness.ports.presence.getMember(room.id, alice.id))?.role).toBe('listener');
      expect(
        harness.ports.media.issuedTokens.filter((t) => t.userId === alice.id && t.canPublish),
      ).toHaveLength(0);
      expect(aliceClient.all('speaker:promoted')).toHaveLength(0);
    } finally {
      hostClient.disconnect();
      aliceClient.disconnect();
      malloryClient.disconnect();
    }
  }, 20_000);

  it('a SPEAKER cannot approve another speaker', async () => {
    const { room, hostClient, aliceClient, malloryClient } = await setUpRoom();

    try {
      // Alice is promoted legitimately.
      hostClient.emit('speaker:approve', { roomId: room.id, userId: alice.id });
      await aliceClient.next('speaker:promoted');

      aliceClient.clear();
      // Now Alice, a speaker, tries to promote Mallory.
      aliceClient.emit('speaker:approve', { roomId: room.id, userId: mallory.id });

      const error = await aliceClient.next<{ code: string }>('error');
      expect(error?.code).toBe('NOT_HOST');
      expect((await harness.ports.presence.getMember(room.id, mallory.id))?.role).toBe('listener');

      // Mallory DID see Alice's legitimate promotion broadcast, so filter by
      // subject: nobody was promoted who should not have been.
      const promotions = malloryClient
        .all<{ userId: string }>('speaker:promoted')
        .filter((p) => p.userId === mallory.id);
      expect(promotions).toHaveLength(0);
    } finally {
      hostClient.disconnect();
      aliceClient.disconnect();
      malloryClient.disconnect();
    }
  }, 20_000);

  it('a non-host cannot mute anyone', async () => {
    const { room, hostClient, aliceClient, malloryClient } = await setUpRoom();

    try {
      malloryClient.clear();
      malloryClient.emit('room:mute-user', {
        roomId: room.id,
        userId: alice.id,
        muted: true,
      });

      const error = await malloryClient.next<{ code: string }>('error');
      expect(error?.code).toBe('NOT_HOST');
      expect((await harness.ports.presence.getMember(room.id, alice.id))?.mutedByHost).toBe(false);
    } finally {
      hostClient.disconnect();
      aliceClient.disconnect();
      malloryClient.disconnect();
    }
  }, 20_000);

  it('a non-host cannot remove a speaker', async () => {
    const { room, hostClient, aliceClient, malloryClient } = await setUpRoom();

    try {
      hostClient.emit('speaker:approve', { roomId: room.id, userId: alice.id });
      await aliceClient.next('speaker:promoted');
      await sleep(100);

      malloryClient.clear();
      malloryClient.emit('speaker:remove', { roomId: room.id, userId: alice.id });

      const error = await malloryClient.next<{ code: string }>('error');
      expect(error?.code).toBe('NOT_HOST');

      // Alice still has the floor, and nothing was revoked at the media server.
      expect((await harness.ports.presence.getMember(room.id, alice.id))?.role).toBe('speaker');
      expect(harness.ports.media.revocations.filter((r) => r.userId === alice.id)).toHaveLength(0);
    } finally {
      hostClient.disconnect();
      aliceClient.disconnect();
      malloryClient.disconnect();
    }
  }, 20_000);

  // -------------------------------------------------------------------------
  it('the full flow: raise → approve → publish token → remove → revoked', async () => {
    const { room, hostClient, aliceClient, malloryClient } = await setUpRoom();

    try {
      // A listener's join token cannot publish.
      const joinState = aliceClient.all<{ mediaToken?: { canPublish: boolean } }>('room:state');
      expect(joinState.at(-1)?.mediaToken?.canPublish).toBe(false);

      // Raise — the whole room sees it.
      aliceClient.emit('hand:raise', { roomId: room.id });
      const raised = await hostClient.next<{ userId: string; raised: boolean }>('hand:raised');
      expect(raised?.userId).toBe(alice.id);
      expect(raised?.raised).toBe(true);

      // Host approves.
      hostClient.emit('speaker:approve', { roomId: room.id, userId: alice.id });

      // Alice receives a NEW token, and this one can publish.
      const promoted = await aliceClient.next<{
        mediaToken?: { token: string; canPublish?: boolean };
      }>('speaker:promoted');
      expect(promoted?.mediaToken).toBeDefined();

      const issued = harness.ports.media.issuedTokens.filter(
        (t) => t.userId === alice.id && t.canPublish,
      );
      expect(issued).toHaveLength(1);

      // The room is told, WITHOUT the credential.
      //
      // Read from what Mallory has ALREADY received rather than waiting for a
      // next one: the broadcast and Alice's private copy are emitted together,
      // so by now it has arrived and `next()` would wait for a second that
      // never comes.
      await malloryClient.until(() => malloryClient.all('speaker:promoted').length > 0);

      const roomSaw = malloryClient
        .all<{ mediaToken?: unknown; userId: string }>('speaker:promoted')
        .find((p) => p.userId === alice.id);

      expect(roomSaw).toBeDefined();
      expect(roomSaw?.mediaToken).toBeUndefined();

      // Host takes the floor back.
      await sleep(100);
      hostClient.emit('speaker:remove', { roomId: room.id, userId: alice.id });

      const demoted = await aliceClient.next<{ userId: string; reason: string }>('speaker:demoted');
      expect(demoted?.userId).toBe(alice.id);
      expect(demoted?.reason).toBe('host');

      // REVOKED AT THE MEDIA SERVER — not merely announced.
      expect(harness.ports.media.revocations).toContainEqual({
        userId: alice.id,
        roomId: room.id,
      });
      expect(harness.ports.media.grantFor(room.id, alice.id)).toBe(false);
    } finally {
      hostClient.disconnect();
      aliceClient.disconnect();
      malloryClient.disconnect();
    }
  }, 25_000);

  it('a speaker may step down without being the host', async () => {
    const { room, hostClient, aliceClient, malloryClient } = await setUpRoom();

    try {
      hostClient.emit('speaker:approve', { roomId: room.id, userId: alice.id });
      await aliceClient.next('speaker:promoted');
      await sleep(100);

      // Targeting themselves is the one case a non-host may use this event for.
      aliceClient.emit('speaker:remove', { roomId: room.id, userId: alice.id });
      await sleep(300);

      expect((await harness.ports.presence.getMember(room.id, alice.id))?.role).toBe('listener');
      expect(harness.ports.media.revocations).toContainEqual({
        userId: alice.id,
        roomId: room.id,
      });
    } finally {
      hostClient.disconnect();
      aliceClient.disconnect();
      malloryClient.disconnect();
    }
  }, 20_000);
});
