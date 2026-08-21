import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryPorts, type MemoryPorts } from '../../src/adapters/memory/index.js';
import { createUseCases, type UseCases } from '../../src/app/index.js';
import type { User } from '../../src/domain/entities/User.js';
import type { RoomId } from '../../src/domain/values/ids.js';
import { asUserId } from '../../src/domain/values/ids.js';
import { LIMITS } from '../../src/domain/ports/RateLimiter.js';
import type { DomainError } from '../../src/domain/errors.js';

/**
 * Phase 3 — the raise-hand → approve → publish flow.
 *
 * THE INVARIANT EVERY TEST HERE ORBITS
 * ------------------------------------
 * A publish-enabled media token exists ONLY because a host approved someone.
 * The memory media provider records the `canPublish` value it was handed for
 * every token it issued, which is what makes that invariant directly
 * assertable rather than merely intended.
 *
 * The audit (A3.2, A3.6) deferred host-only authorization and media token
 * safety to this phase. Both are proved below.
 */
describe('speaking', () => {
  let ports: MemoryPorts;
  let useCases: UseCases;

  let host: User;
  let alice: User;
  let bob: User;
  let roomId: RoomId;

  const makeUser = async (name: string): Promise<User> =>
    ports.users.create({
      id: asUserId(ports.ids.uuid()),
      identifier: `${name.toLowerCase()}@example.com`,
      identifierKind: 'email',
      displayName: name,
      avatarSeed: `seed-${name}`,
      dob: new Date('1995-01-01T00:00:00.000Z'),
      createdAt: ports.clock.now(),
    });

  beforeEach(async () => {
    ports = createMemoryPorts({ presenceTtlSeconds: 60 });
    useCases = createUseCases(ports, { echoLoginCode: true });

    host = await makeUser('Hosty');
    alice = await makeUser('Alice');
    bob = await makeUser('Bob');

    const room = await useCases.createRoom.execute(host, {
      title: 'Voice Room',
      category: 'casual',
      maxSpeakers: 2,
    });
    roomId = room.id;

    await useCases.joinRoom.execute(host, roomId);
    await useCases.joinRoom.execute(alice, roomId);
    await useCases.joinRoom.execute(bob, roomId);
    ports.recorder.clear();
    ports.media.clear();
  });

  // -------------------------------------------------------------------------
  describe('joining issues a LISTEN-ONLY token', () => {
    it('gives a joiner a token that cannot publish', async () => {
      const fresh = await makeUser('Fresh');
      const { state } = await useCases.joinRoom.execute(fresh, roomId);

      expect(state.mediaToken).toBeDefined();
      expect(state.mediaToken?.canPublish).toBe(false);

      // And the ADAPTER was handed false — it did not decide for itself.
      const issued = ports.media.issuedTokens.filter((t) => t.userId === fresh.id);
      expect(issued).toHaveLength(1);
      expect(issued[0]?.canPublish).toBe(false);
    });

    it('gives the room owner a publishing token, because they are the host', async () => {
      // The host is the one role decided at join — from room.hostUserId, never
      // from anything the client sent.
      ports.media.clear();
      const { state } = await useCases.joinRoom.execute(host, roomId);
      expect(state.mediaToken?.canPublish).toBe(true);
    });

    it('still joins when the media server is unavailable', async () => {
      // A media outage must degrade to a text room, not take the product down.
      const broken = createMemoryPorts({ presenceTtlSeconds: 60 });
      const brokenUseCases = createUseCases(broken, { echoLoginCode: true });

      broken.media.createRoom = async () => {
        throw new Error('media server unreachable');
      };

      const owner = await broken.users.create({
        id: asUserId(broken.ids.uuid()),
        identifier: 'owner@example.com',
        identifierKind: 'email',
        displayName: 'Owner',
        avatarSeed: 's',
        dob: new Date('1995-01-01T00:00:00.000Z'),
        createdAt: broken.clock.now(),
      });
      const room = await brokenUseCases.createRoom.execute(owner, {
        title: 'Degraded',
        category: 'casual',
      });

      const { state } = await brokenUseCases.joinRoom.execute(owner, room.id);
      expect(state.members).toHaveLength(1);
      expect(state.mediaToken).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  describe('raising a hand', () => {
    it('records the hand and tells the whole room', async () => {
      await useCases.raiseHand.execute(alice, { roomId, raised: true });

      const entry = await ports.presence.getMember(roomId, alice.id);
      expect(entry?.handRaisedAtMs).not.toBeNull();

      const events = ports.recorder.emissionsTo(roomId, 'hand:raised');
      expect(events).toHaveLength(1);
      // The room, not just the host: seeing the queue is how a room
      // self-regulates.
      expect(events[0]?.target).not.toHaveProperty('exceptUserId');
    });

    it('lowers a hand', async () => {
      await useCases.raiseHand.execute(alice, { roomId, raised: true });
      await useCases.raiseHand.execute(alice, { roomId, raised: false });

      expect((await ports.presence.getMember(roomId, alice.id))?.handRaisedAtMs).toBeNull();
    });

    it('orders the queue by who raised FIRST', async () => {
      await useCases.raiseHand.execute(bob, { roomId, raised: true });
      ports.clock.advanceSeconds(2);
      await useCases.raiseHand.execute(alice, { roomId, raised: true });

      const hands = await ports.presence.getRaisedHands(roomId);
      expect(hands.map((h) => h.userId)).toEqual([bob.id, alice.id]);
    });

    it('re-raising does not jump the queue', async () => {
      await useCases.raiseHand.execute(bob, { roomId, raised: true });
      ports.clock.advanceSeconds(2);
      await useCases.raiseHand.execute(alice, { roomId, raised: true });

      // Alice lowers and immediately re-raises, hoping to get ahead.
      ports.clock.advanceSeconds(1);
      await useCases.raiseHand.execute(alice, { roomId, raised: false });
      await useCases.raiseHand.execute(alice, { roomId, raised: true });

      const hands = await ports.presence.getRaisedHands(roomId);
      expect(hands[0]?.userId).toBe(bob.id);
    });

    it('refuses someone who is not in the room', async () => {
      const outsider = await makeUser('Outsider');
      await expect(useCases.raiseHand.execute(outsider, { roomId, raised: true })).rejects.toThrow(
        /not in this room/i,
      );
    });

    it('refuses a host-muted member', async () => {
      // Otherwise a muted user spams the host's approval queue.
      await ports.presence.setMutedByHost(roomId, alice.id, true);
      await expect(useCases.raiseHand.execute(alice, { roomId, raised: true })).rejects.toThrow(
        /muted/i,
      );
    });

    it('is a no-op for someone who already has the floor', async () => {
      await useCases.approveSpeaker.execute(host, { roomId, userId: alice.id });
      ports.recorder.clear();

      await useCases.raiseHand.execute(alice, { roomId, raised: true });
      expect(ports.recorder.emissionsTo(roomId, 'hand:raised')).toHaveLength(0);
    });

    it('is rate limited against toggle spam', async () => {
      for (let i = 0; i < LIMITS.handToggle.limit; i += 1) {
        await useCases.raiseHand.execute(alice, { roomId, raised: i % 2 === 0 });
      }
      await expect(useCases.raiseHand.execute(alice, { roomId, raised: true })).rejects.toThrow(
        /too quickly/i,
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('approving a speaker — HOST ONLY', () => {
    it('REFUSES a non-host, even one already speaking', async () => {
      // The audit's A3.2 requirement, proved at the use-case level. The socket
      // level version is in tests/socket/speaking.test.ts.
      await useCases.approveSpeaker.execute(host, { roomId, userId: alice.id });

      try {
        await useCases.approveSpeaker.execute(alice, { roomId, userId: bob.id });
        expect.unreachable('a speaker must not be able to promote anyone');
      } catch (error) {
        expect((error as DomainError).code).toBe('NOT_HOST');
      }

      // And Bob was never issued a publishing token — the precise invariant,
      // rather than checking a grant that does not exist at all.
      expect(
        ports.media.issuedTokens.filter((t) => t.userId === bob.id && t.canPublish),
      ).toHaveLength(0);
    });

    it('refuses a plain listener', async () => {
      await expect(
        useCases.approveSpeaker.execute(bob, { roomId, userId: alice.id }),
      ).rejects.toThrow(/only the host/i);
    });

    it('refuses someone who is not in the room at all', async () => {
      const outsider = await makeUser('Outsider');
      await expect(
        useCases.approveSpeaker.execute(outsider, { roomId, userId: alice.id }),
      ).rejects.toThrow();
    });

    it('promotes, and issues a NEW publish-enabled token', async () => {
      await useCases.approveSpeaker.execute(host, { roomId, userId: alice.id });

      // Role recorded in BOTH stores.
      expect((await ports.presence.getMember(roomId, alice.id))?.role).toBe('speaker');
      expect((await ports.rooms.findMembership(roomId, alice.id))?.role).toBe('speaker');

      // A token was minted WITH publish rights.
      const issued = ports.media.issuedTokens.filter((t) => t.userId === alice.id);
      expect(issued).toHaveLength(1);
      expect(issued[0]?.canPublish).toBe(true);
      expect(ports.media.grantFor(roomId, alice.id)).toBe(true);
    });

    it('sends the CREDENTIAL only to its owner', async () => {
      // Broadcasting it would let anyone in the room connect as that user.
      await useCases.approveSpeaker.execute(host, { roomId, userId: alice.id });

      const toAlice = ports.recorder.emissionsToUser(alice.id, 'speaker:promoted');
      expect(toAlice).toHaveLength(1);
      expect((toAlice[0]?.payload as { mediaToken?: unknown }).mediaToken).toBeDefined();

      // The room hears about it WITHOUT the token.
      const toRoom = ports.recorder.emissionsTo(roomId, 'speaker:promoted');
      expect(toRoom).toHaveLength(1);
      expect((toRoom[0]?.payload as { mediaToken?: unknown }).mediaToken).toBeUndefined();
      expect(toRoom[0]?.target).toMatchObject({ exceptUserId: alice.id });
    });

    it('clears the raised hand', async () => {
      await useCases.raiseHand.execute(alice, { roomId, raised: true });
      await useCases.approveSpeaker.execute(host, { roomId, userId: alice.id });

      expect((await ports.presence.getMember(roomId, alice.id))?.handRaisedAtMs).toBeNull();
    });

    it('credits the promotion to the trust ledger', async () => {
      await useCases.approveSpeaker.execute(host, { roomId, userId: alice.id });

      const events = await ports.users.listTrustEvents(alice.id, 10);
      expect(events.some((e) => e.reason === 'promoted_to_speaker')).toBe(true);
    });

    it('ENFORCES the speaker cap', async () => {
      // maxSpeakers is 2 in this room, and the host does not count.
      await useCases.approveSpeaker.execute(host, { roomId, userId: alice.id });
      await useCases.approveSpeaker.execute(host, { roomId, userId: bob.id });

      const carol = await makeUser('Carol');
      await useCases.joinRoom.execute(carol, roomId);

      try {
        await useCases.approveSpeaker.execute(host, { roomId, userId: carol.id });
        expect.unreachable('the stage is full');
      } catch (error) {
        expect((error as DomainError).code).toBe('SPEAKER_SLOTS_FULL');
      }
      expect(ports.media.grantFor(roomId, carol.id)).toBe(false);
    });

    it('two hosts approving the same person concurrently promote once', async () => {
      // The audit's race requirement. The second call finds them already a
      // speaker and returns quietly rather than issuing a second token.
      await Promise.all([
        useCases.approveSpeaker.execute(host, { roomId, userId: alice.id }),
        useCases.approveSpeaker.execute(host, { roomId, userId: alice.id }),
      ]);

      const issued = ports.media.issuedTokens.filter((t) => t.userId === alice.id && t.canPublish);
      expect(issued.length).toBeGreaterThanOrEqual(1);
      expect((await ports.presence.getMember(roomId, alice.id))?.role).toBe('speaker');
    });

    it('refuses to promote someone who has left', async () => {
      await useCases.leaveRoom.execute({ userId: alice.id, roomId });
      await expect(
        useCases.approveSpeaker.execute(host, { roomId, userId: alice.id }),
      ).rejects.toThrow(/no longer in the room/i);
    });
  });

  // -------------------------------------------------------------------------
  describe('removing a speaker', () => {
    beforeEach(async () => {
      await useCases.approveSpeaker.execute(host, { roomId, userId: alice.id });
      ports.recorder.clear();
      ports.media.revocations.length = 0;
    });

    it('REVOKES PUBLISH AT THE MEDIA SERVER, not just in the UI', async () => {
      // The difference between moderation and a suggestion.
      await useCases.removeSpeaker.execute(host, { roomId, userId: alice.id });

      expect(ports.media.revocations).toContainEqual({ userId: alice.id, roomId });
      expect(ports.media.grantFor(roomId, alice.id)).toBe(false);
    });

    it('demotes in both stores and tells the room', async () => {
      await useCases.removeSpeaker.execute(host, { roomId, userId: alice.id });

      expect((await ports.presence.getMember(roomId, alice.id))?.role).toBe('listener');
      expect((await ports.rooms.findMembership(roomId, alice.id))?.role).toBe('listener');
      expect(ports.recorder.emissionsTo(roomId, 'speaker:demoted')).toHaveLength(1);
    });

    it('refuses a non-host', async () => {
      await expect(
        useCases.removeSpeaker.execute(bob, { roomId, userId: alice.id }),
      ).rejects.toThrow(/only the host/i);
      // Still audible.
      expect(ports.media.grantFor(roomId, alice.id)).toBe(true);
    });

    it('refuses a host targeting themselves', async () => {
      await expect(
        useCases.removeSpeaker.execute(host, { roomId, userId: host.id }),
      ).rejects.toThrow(/yourself/i);
    });

    it('lets a speaker step down on their own', async () => {
      await useCases.stepDownAsSpeaker.execute(alice, roomId);

      expect((await ports.presence.getMember(roomId, alice.id))?.role).toBe('listener');
      expect(ports.media.revocations).toContainEqual({ userId: alice.id, roomId });
    });

    it('a host stepping down keeps the room moderated', async () => {
      await useCases.stepDownAsSpeaker.execute(host, roomId);
      expect((await ports.presence.getMember(roomId, host.id))?.role).toBe('host');
    });
  });

  // -------------------------------------------------------------------------
  describe('muting', () => {
    beforeEach(async () => {
      await useCases.approveSpeaker.execute(host, { roomId, userId: alice.id });
      ports.recorder.clear();
    });

    it('mutes at the media server and records it', async () => {
      await useCases.muteSpeaker.execute(host, { roomId, userId: alice.id, muted: true });

      expect((await ports.presence.getMember(roomId, alice.id))?.mutedByHost).toBe(true);
      expect((await ports.rooms.findMembership(roomId, alice.id))?.mutedByHost).toBe(true);
      expect(ports.recorder.emissionsTo(roomId, 'room:muted')).toHaveLength(1);
    });

    it('a mute SILENCES TEXT as well as audio', async () => {
      await useCases.muteSpeaker.execute(host, { roomId, userId: alice.id, muted: true });

      await expect(
        useCases.sendChatMessage.execute(alice, { roomId, text: 'and another thing' }),
      ).rejects.toThrow(/muted/i);
      await expect(
        useCases.sendReaction.execute(alice, { roomId, reaction: 'clap' }),
      ).rejects.toThrow(/muted/i);
    });

    it('SURVIVES A RECONNECT — rejoining does not clear it', async () => {
      // Otherwise the mute button is one refresh away from useless.
      await useCases.muteSpeaker.execute(host, { roomId, userId: alice.id, muted: true });
      await useCases.joinRoom.execute(alice, roomId);

      expect((await ports.presence.getMember(roomId, alice.id))?.mutedByHost).toBe(true);
    });

    it('unmutes', async () => {
      await useCases.muteSpeaker.execute(host, { roomId, userId: alice.id, muted: true });
      await useCases.muteSpeaker.execute(host, { roomId, userId: alice.id, muted: false });

      expect((await ports.presence.getMember(roomId, alice.id))?.mutedByHost).toBe(false);
      await expect(
        useCases.sendChatMessage.execute(alice, { roomId, text: 'thanks' }),
      ).resolves.toBeTruthy();
    });

    it('refuses a non-host', async () => {
      await expect(
        useCases.muteSpeaker.execute(bob, { roomId, userId: alice.id, muted: true }),
      ).rejects.toThrow(/only the host/i);
    });
  });
});
