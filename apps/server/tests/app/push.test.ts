import { createECDH, randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryPorts, type MemoryPorts } from '../../src/adapters/memory/index.js';
import { createUseCases, type UseCases } from '../../src/app/index.js';
import type { User } from '../../src/domain/entities/User.js';
import { asUserId } from '../../src/domain/values/ids.js';
import { TRUST_DELTAS } from '../../src/domain/values/trust.js';
import type { DomainError } from '../../src/domain/errors.js';

/**
 * PUSH NOTIFICATIONS.
 *
 * Two things here are worth more than the happy path, and both are the kind of
 * defect that ships quietly:
 *
 *   1. THE ENDPOINT IS A URL THE SERVER WILL LATER FETCH. An unvalidated one is
 *      server-side request forgery: register the cloud metadata address and the
 *      next notification makes the server retrieve its own credentials.
 *
 *   2. A NOTIFICATION IS RENDERED ON A LOCKED SCREEN, on a bus, on a desk in a
 *      shared house. It may say WHO and WHAT KIND. It may never say what was
 *      said. For a product whose entire premise is who-can-see-what, leaking
 *      message text onto a lock screen would undo the whole design — and no
 *      setting the user could find would take it back.
 */
describe('push notifications', () => {
  let ports: MemoryPorts;
  let useCases: UseCases;
  let alice: User;
  let bob: User;

  /**
   * A REAL subscription shape: a 65-byte uncompressed P-256 point and a
   * 16-byte auth secret, exactly as a browser produces.
   *
   * Generated rather than hard-coded because a hand-written constant is how
   * this fixture drifted into being invalid in the first place — and a test
   * suite that registers subscriptions no push service would accept proves
   * nothing about registering ones it would.
   */
  const VALID = (() => {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    return {
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
      p256dh: ecdh.getPublicKey().toString('base64url'),
      auth: randomBytes(16).toString('base64url'),
    };
  })();

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
    await ports.users.appendTrustEvent({
      userId: user.id,
      delta: TRUST_DELTAS.account_created,
      reason: 'account_created',
      context: null,
      createdAt: ports.clock.now(),
    });
    return (await ports.users.findById(user.id)) ?? user;
  };

  const errorOf = async (fn: () => Promise<unknown>): Promise<DomainError> => {
    try {
      await fn();
    } catch (error) {
      return error as DomainError;
    }
    throw new Error('expected that to be refused');
  };

  beforeEach(async () => {
    ports = createMemoryPorts({ presenceTtlSeconds: 60 });
    useCases = createUseCases(ports, { echoLoginCode: true, moderatorUserIds: [] });
    alice = await makeUser('Alice');
    bob = await makeUser('Bob');
  });

  // =========================================================================
  describe('registering a device', () => {
    it('stores it', async () => {
      await useCases.registerPushSubscription.execute(alice, VALID);

      const stored = await ports.pushSubscriptions.listForUser(alice.id);
      expect(stored).toHaveLength(1);
      expect(stored[0]?.endpoint).toBe(VALID.endpoint);
    });

    it('is idempotent, because clients re-register on every load', async () => {
      await useCases.registerPushSubscription.execute(alice, VALID);
      await useCases.registerPushSubscription.execute(alice, VALID);

      expect(await ports.pushSubscriptions.listForUser(alice.id)).toHaveLength(1);
    });

    it('keeps a person’s separate devices apart', async () => {
      await useCases.registerPushSubscription.execute(alice, VALID);
      await useCases.registerPushSubscription.execute(alice, {
        ...VALID,
        endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/xyz',
      });

      expect(await ports.pushSubscriptions.listForUser(alice.id)).toHaveLength(2);
    });

    it('MOVES A SHARED DEVICE TO ITS NEW OWNER', async () => {
      // A family laptop: one person signs out, another signs in, and the
      // browser hands back the SAME endpoint. Keeping both rows would keep
      // notifying the person who left — on a screen that is no longer theirs.
      await useCases.registerPushSubscription.execute(alice, VALID);
      await useCases.registerPushSubscription.execute(bob, VALID);

      expect(await ports.pushSubscriptions.listForUser(alice.id)).toHaveLength(0);
      expect(await ports.pushSubscriptions.listForUser(bob.id)).toHaveLength(1);
    });

    // -- the SSRF guard ---------------------------------------------------

    it('REFUSES THE CLOUD METADATA ADDRESS', async () => {
      // The canonical SSRF target. A notification would otherwise make the
      // server fetch its own instance credentials.
      const error = await errorOf(async () =>
        useCases.registerPushSubscription.execute(alice, {
          ...VALID,
          endpoint: 'https://169.254.169.254/latest/meta-data/iam/security-credentials/',
        }),
      );
      expect(error.code).toBe('VALIDATION_FAILED');
    });

    it('refuses loopback and private ranges', async () => {
      const internal = [
        'https://localhost/push',
        'https://127.0.0.1/push',
        'https://10.0.0.5/push',
        'https://192.168.1.10/push',
        'https://172.16.0.3/push',
        'https://redis.internal/push',
        'https://printer.local/push',
      ];

      for (const endpoint of internal) {
        const error = await errorOf(async () =>
          useCases.registerPushSubscription.execute(alice, { ...VALID, endpoint }),
        );
        expect(error.code, endpoint).toBe('VALIDATION_FAILED');
      }
    });

    it('refuses anything that is not https', async () => {
      for (const endpoint of ['http://fcm.googleapis.com/x', 'file:///etc/passwd', 'notaurl']) {
        const error = await errorOf(async () =>
          useCases.registerPushSubscription.execute(alice, { ...VALID, endpoint }),
        );
        expect(error.code, endpoint).toBe('VALIDATION_FAILED');
      }
    });

    it('refuses an absurdly long endpoint', async () => {
      const error = await errorOf(async () =>
        useCases.registerPushSubscription.execute(alice, {
          ...VALID,
          endpoint: `https://fcm.googleapis.com/${'x'.repeat(2000)}`,
        }),
      );
      expect(error.code).toBe('VALIDATION_FAILED');
    });

    it('refuses a subscription with no keys, which could never be encrypted to', async () => {
      const error = await errorOf(async () =>
        useCases.registerPushSubscription.execute(alice, { ...VALID, p256dh: '' }),
      );
      expect(error.code).toBe('VALIDATION_FAILED');
    });

    /**
     * REFUSES KEYS OF THE WRONG SIZE.
     *
     * Found live: a subscription whose `p256dh` is not a 65-byte uncompressed
     * P-256 point can NEVER receive a push. `web-push` rejects it before any
     * request is made, so the failure carries no HTTP status — which our
     * adapter correctly reads as "transient" and keeps. The row then lives
     * forever, retried on every notification, and nothing ever reports it.
     *
     * A key that cannot work is a validation error, and validation errors
     * belong at the edge where there is still someone to tell.
     */
    it('REFUSES A p256dh THAT IS NOT A 65-BYTE P-256 POINT', async () => {
      const error = await errorOf(async () =>
        useCases.registerPushSubscription.execute(alice, {
          ...VALID,
          // 43 bytes: a plausible-looking base64url string that is not a point.
          p256dh: 'BLc4xRzKlKORKWlbdgFaBrrPK3ydWAHo4M0gs0i1oEM',
        }),
      );
      expect(error.code).toBe('VALIDATION_FAILED');
    });

    it('refuses an auth secret that is not 16 bytes', async () => {
      const error = await errorOf(async () =>
        useCases.registerPushSubscription.execute(alice, { ...VALID, auth: 'dG9vLXNob3J0' }),
      );
      expect(error.code).toBe('VALIDATION_FAILED');
    });

    it('accepts keys of exactly the shape a browser produces', async () => {
      await expect(
        useCases.registerPushSubscription.execute(alice, VALID),
      ).resolves.toBeUndefined();
    });
  });

  // =========================================================================
  describe('removing a device', () => {
    it('forgets it', async () => {
      await useCases.registerPushSubscription.execute(alice, VALID);
      await useCases.removePushSubscription.execute(alice, VALID.endpoint);

      expect(await ports.pushSubscriptions.listForUser(alice.id)).toHaveLength(0);
    });

    it('removing one that was never there is not an error', async () => {
      await expect(
        useCases.removePushSubscription.execute(alice, VALID.endpoint),
      ).resolves.toBeUndefined();
    });
  });

  // =========================================================================
  describe('sending', () => {
    beforeEach(async () => {
      await useCases.registerPushSubscription.execute(bob, VALID);
      ports.push.clear();
    });

    it('reaches every device the person registered', async () => {
      await useCases.registerPushSubscription.execute(bob, {
        ...VALID,
        endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/xyz',
      });

      await useCases.sendPush.execute(bob.id, {
        title: 'Alice',
        body: 'is calling you',
        url: '/connections',
        tag: 'call',
        urgent: true,
      });

      expect(ports.push.sent).toHaveLength(2);
    });

    it('does nothing for someone with no devices', async () => {
      await useCases.sendPush.execute(alice.id, {
        title: 'Bob',
        body: 'is calling you',
        url: '/connections',
        tag: 'call',
        urgent: true,
      });

      expect(ports.push.sent).toHaveLength(0);
    });

    it('DELETES ENDPOINTS THE PUSH SERVICE SAYS ARE GONE', async () => {
      // A 404/410 is the ONLY signal we ever get that a device stopped
      // existing. Ignoring it means the table grows forever and every future
      // notification pays to push into browsers that are not there.
      ports.push.expireNext(VALID.endpoint);

      await useCases.sendPush.execute(bob.id, {
        title: 'Alice',
        body: 'is calling you',
        url: '/connections',
        tag: 'call',
        urgent: false,
      });

      expect(await ports.pushSubscriptions.listForUser(bob.id)).toHaveLength(0);
    });

    it('never throws, because a notification is not worth failing an action for', async () => {
      await expect(
        useCases.sendPush.execute(asUserId('11111111-1111-4111-8111-111111111111'), {
          title: 'x',
          body: 'y',
          url: '/rooms',
          tag: 'x',
          urgent: false,
        }),
      ).resolves.toBeUndefined();
    });
  });

  // =========================================================================
  describe('WHAT A LOCK SCREEN IS ALLOWED TO SAY', () => {
    beforeEach(async () => {
      await useCases.registerPushSubscription.execute(bob, VALID);
      ports.push.clear();
    });

    /** Walk the ladder so Alice may legitimately reach Bob. */
    const connect = async (): Promise<void> => {
      const room = await useCases.createRoom.execute(alice, {
        title: 'Meeting Room',
        category: 'casual',
      });
      await useCases.joinRoom.execute(alice, room.id);
      await useCases.joinRoom.execute(bob, room.id);
      ports.clock.advanceSeconds(60);
      await useCases.leaveRoom.execute({ userId: alice.id, roomId: room.id, reason: 'left' });
      await useCases.leaveRoom.execute({ userId: bob.id, roomId: room.id, reason: 'left' });
    };

    const refresh = async (user: User): Promise<User> =>
      (await ports.users.findById(user.id)) ?? user;

    it('a DM request says who, and nothing else', async () => {
      await connect();
      ports.push.clear();

      await useCases.requestDm.execute(await refresh(alice), bob.id);
      // The push is fire-and-forget; let the microtask queue drain.
      await new Promise((resolve) => setTimeout(resolve, 10));

      const messages = ports.push.messagesFor(bob.id);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.title).toBe('Alice');
      expect(messages[0]?.body).toBe('would like to message you');
      // Not urgent: someone asking to talk is a thing to find when you pick
      // your phone up, not a reason to make it buzz on a table.
      expect(messages[0]?.urgent).toBe(false);
    });

    it('A RINGING CALL IS THE ONLY URGENT NOTIFICATION', async () => {
      await connect();
      await useCases.requestDm.execute(await refresh(alice), bob.id);
      await useCases.acceptDm.execute(await refresh(bob), alice.id);
      ports.push.clear();

      await useCases.inviteToCall.execute(await refresh(alice), bob.id);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const messages = ports.push.messagesFor(bob.id);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.body).toBe('is calling you');
      expect(messages[0]?.urgent).toBe(true);
    });

    it('NO MESSAGE TEXT EVER REACHES A NOTIFICATION', async () => {
      await connect();
      await useCases.requestDm.execute(await refresh(alice), bob.id);
      await useCases.acceptDm.execute(await refresh(bob), alice.id);
      ports.push.clear();

      const secret = 'I am leaving him and I do not know what to do';
      await useCases.sendDm.execute(await refresh(alice), { toUserId: bob.id, text: secret });
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Sending a DM does not push at all today. The assertion that matters is
      // the second one: whatever DOES get sent must never carry the words.
      const serialized = JSON.stringify(ports.push.sent);
      expect(serialized).not.toContain('leaving him');
      expect(serialized).not.toContain(secret);
    });

    it('a notification never carries an internal identifier', async () => {
      await connect();
      ports.push.clear();

      await useCases.requestDm.execute(await refresh(alice), bob.id);
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Ids in a payload would be a small but real leak into a place we do not
      // control — the push service sees everything we send it.
      const messages = ports.push.messagesFor(bob.id);
      expect(JSON.stringify(messages)).not.toContain(alice.id);
      expect(JSON.stringify(messages)).not.toContain(bob.id);
    });
  });
});
