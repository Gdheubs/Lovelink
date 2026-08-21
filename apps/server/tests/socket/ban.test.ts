import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startSocketHarness, sleep, type SocketHarness } from './harness.js';
import { startModerationSubscriber } from '../../src/adapters/socketio/moderationSubscriber.js';
import { createUseCases, type UseCases } from '../../src/app/index.js';
import type { User } from '../../src/domain/entities/User.js';
import { asUserId } from '../../src/domain/values/ids.js';

/**
 * PHASE 4 EXIT CRITERION, over a real socket:
 *
 *   "a reported user can be reviewed and banned, and their socket drops
 *    within seconds."
 *
 * The interesting part is not that a ban is recorded — the use-case tests cover
 * that. It is that a person who is CONNECTED AND MID-ABUSE right now stops
 * being able to reach the room, immediately, without depending on their client
 * cooperating.
 *
 * Four separate things have to hold, and each is tested:
 *   1. the live socket is severed;
 *   2. the room stops hearing them (media grant revoked, presence gone);
 *   3. they cannot reconnect;
 *   4. their existing tokens are dead, so a second device or tab is no help.
 */
describe('ban enforcement over a real socket', () => {
  let harness: SocketHarness;
  let moderatedUseCases: UseCases;
  let stopSubscriber: (() => Promise<void>) | null = null;

  let moderator: User;
  let host: User;
  let mallory: User;

  beforeEach(async () => {
    harness = await startSocketHarness({ presenceTtlSeconds: 60 });

    moderator = await harness.createUser('Mod');
    host = await harness.createUser('Hosty');
    mallory = await harness.createUser('Mallory');

    // A second use-case bundle over the SAME ports, with the moderator on the
    // allowlist. The harness builds its own with none, which is correct for
    // every other suite — moderator authority is config, so a test that needs
    // it says so explicitly.
    moderatedUseCases = createUseCases(harness.ports, {
      echoLoginCode: true,
      moderatorUserIds: [moderator.id],
    });

    // The cross-process enforcement path, exactly as main.ts wires it.
    stopSubscriber = await startModerationSubscriber({ ports: harness.ports });
  });

  afterEach(async () => {
    if (stopSubscriber !== null) await stopSubscriber();
    stopSubscriber = null;
    await harness.close();
  });

  it('severs a live socket within seconds of the ban', async () => {
    const room = await harness.useCases.createRoom.execute(host, {
      title: 'Enforcement Room',
      category: 'casual',
    });

    const hostClient = await harness.connect(host);
    const malloryClient = await harness.connect(mallory);

    hostClient.emit('room:join', { roomId: room.id });
    await hostClient.next('room:state');
    malloryClient.emit('room:join', { roomId: room.id });
    await malloryClient.next('room:state');
    await sleep(120);

    // Mid-abuse: on the stage, with the floor.
    await moderatedUseCases.approveSpeaker.execute(host, { roomId: room.id, userId: mallory.id });
    await sleep(150);
    expect(harness.ports.media.grantFor(room.id, mallory.id)).toBe(true);

    hostClient.clear();

    const bannedAt = Date.now();
    await moderatedUseCases.banUser.execute(moderator.id, {
      targetId: mallory.id,
      reason: 'harassment',
      hours: null,
    });

    // 1. THE SOCKET DROPS.
    const dropped = await malloryClient.until(() => !malloryClient.socket.connected, 5_000);
    expect(dropped).toBe(true);
    expect(Date.now() - bannedAt).toBeLessThan(5_000);

    // 2. THE ROOM GOES QUIET. `null` here means removed from the media room
    //    entirely, which is stronger than a revoked grant — either way, what
    //    must NOT be true is that they can still publish.
    expect(harness.ports.media.grantFor(room.id, mallory.id)).not.toBe(true);
    expect(await harness.ports.presence.getMember(room.id, mallory.id)).toBeNull();

    // ...and the room was told.
    const departures = hostClient.all<{ userId: string }>('user:left');
    expect(departures.some((d) => d.userId === mallory.id)).toBe(true);

    hostClient.disconnect();
  }, 25_000);

  it('a banned user CANNOT reconnect', async () => {
    const client = await harness.connect(mallory);
    const token = await harness.tokenFor(mallory);

    await moderatedUseCases.banUser.execute(moderator.id, {
      targetId: mallory.id,
      reason: 'abuse',
      hours: null,
    });
    await client.until(() => !client.socket.connected, 5_000);

    // The handshake refuses them, so a client that simply retries gets nowhere.
    const retry = await harness.connectRaw(token);
    expect(retry.connected).toBe(false);
  }, 25_000);

  it('a SECOND TAB is no help — every session is revoked', async () => {
    // The obvious workaround, and the reason revoking credentials is a
    // separate step from severing the socket.
    const tabA = await harness.connect(mallory);
    const tabB = await harness.connect(mallory);

    await moderatedUseCases.banUser.execute(moderator.id, {
      targetId: mallory.id,
      reason: 'abuse',
      hours: null,
    });

    expect(await tabA.until(() => !tabA.socket.connected, 5_000)).toBe(true);
    expect(await tabB.until(() => !tabB.socket.connected, 5_000)).toBe(true);

    // A freshly-minted token for a banned account is refused at the handshake.
    const fresh = await harness.tokenFor(mallory);
    expect((await harness.connectRaw(fresh)).connected).toBe(false);
  }, 25_000);

  it('the ban survives the moderator going away — it is a durable fact', async () => {
    await moderatedUseCases.banUser.execute(moderator.id, {
      targetId: mallory.id,
      reason: 'abuse',
      hours: null,
    });

    expect(
      await harness.ports.reports.findActiveBan(mallory.id, harness.ports.clock.now()),
    ).not.toBeNull();
    expect((await harness.ports.users.findById(mallory.id))!.status).toBe('banned');
  }, 20_000);

  it('LIFTING a ban lets them back in', async () => {
    await moderatedUseCases.banUser.execute(moderator.id, {
      targetId: mallory.id,
      reason: 'mistake',
      hours: null,
    });
    expect((await harness.connectRaw(await harness.tokenFor(mallory))).connected).toBe(false);

    await moderatedUseCases.liftBan.execute(moderator.id, mallory.id);

    expect((await harness.connectRaw(await harness.tokenFor(mallory))).connected).toBe(true);
  }, 20_000);

  it('a non-moderator cannot ban, even with a live socket', async () => {
    const attacker = await harness.connect(host);

    await expect(
      moderatedUseCases.banUser.execute(host.id, {
        targetId: mallory.id,
        reason: 'I dislike them',
        hours: null,
      }),
    ).rejects.toThrow();

    expect((await harness.ports.users.findById(mallory.id))!.status).toBe('active');
    attacker.disconnect();
  }, 20_000);

  it('a kicked user keeps their account and can join another room', async () => {
    // A host runs a room; a moderator runs the platform. The boundary matters.
    const roomA = await harness.useCases.createRoom.execute(host, {
      title: 'Room A',
      category: 'casual',
    });
    const roomB = await harness.useCases.createRoom.execute(host, {
      title: 'Room B',
      category: 'casual',
    });

    const hostClient = await harness.connect(host);
    const malloryClient = await harness.connect(mallory);

    hostClient.emit('room:join', { roomId: roomA.id });
    await hostClient.next('room:state');
    malloryClient.emit('room:join', { roomId: roomA.id });
    await malloryClient.next('room:state');
    await sleep(120);

    hostClient.emit('room:kick', { roomId: roomA.id, userId: mallory.id });

    const kicked = await malloryClient.next<{ roomId: string }>('room:kicked');
    expect(kicked?.roomId).toBe(roomA.id);
    await sleep(200);

    expect(await harness.ports.presence.getMember(roomA.id, mallory.id)).toBeNull();
    // Still connected, still an account, still welcome elsewhere.
    expect(malloryClient.socket.connected).toBe(true);

    // THE POINT OF THIS TEST: a kick is room-scoped. Being asked to leave one
    // room must not lock someone out of the platform — which it did, until the
    // trust starting balance was introduced.
    malloryClient.clear();
    malloryClient.emit('room:join', { roomId: roomB.id });

    const joinedB = await malloryClient.next<{ roomId: string }>('room:state');
    expect(malloryClient.all('error')).toHaveLength(0);
    expect(joinedB?.roomId).toBe(roomB.id);

    hostClient.disconnect();
    malloryClient.disconnect();
  }, 25_000);

  it('report:submit is acknowledged without revealing anything about the target', async () => {
    const reporter = await harness.connect(host);

    try {
      reporter.clear();
      reporter.emit('report:submit', {
        targetId: mallory.id,
        category: 'harassment',
        note: 'kept interrupting',
      });

      const ack = await reporter.next<{ message: string }>('error');
      expect(ack).not.toBeNull();
      expect(ack?.message).toMatch(/thank you/i);
      // Deliberately says nothing about prior reports or the target's standing.
      expect(ack?.message).not.toMatch(/\d/);

      const queue = await moderatedUseCases.listReportQueue.execute(moderator.id);
      expect(queue.some((q) => q.report.targetId === mallory.id)).toBe(true);
    } finally {
      reporter.disconnect();
    }
  }, 20_000);

  it('a non-moderator cannot read the queue', async () => {
    await expect(moderatedUseCases.listReportQueue.execute(asUserId(host.id))).rejects.toThrow(
      /moderator/i,
    );
  }, 20_000);
});
