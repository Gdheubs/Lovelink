import type { User } from '../../domain/entities/User.js';
import type { Ports } from '../../domain/ports/index.js';
import type { PushMessage } from '../../domain/ports/PushSender.js';
import type { UserId } from '../../domain/values/ids.js';
import { ValidationError } from '../../domain/errors.js';

/**
 * USE CASE: register a device for notifications.
 *
 * WHY THE ENDPOINT IS VALIDATED AS A URL AND NOT JUST A STRING
 * ------------------------------------------------------------
 * It is a URL the server will later make a request TO. An unvalidated one is a
 * server-side request forgery vector: a client could register
 * `http://169.254.169.254/latest/meta-data/` and the next notification would
 * make the server fetch its own cloud credentials endpoint.
 *
 * So it must be https, and it must not point anywhere internal. The real push
 * services are all public HTTPS hosts, so nothing legitimate is lost.
 */
export interface RegisterPushSubscriptionInput {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}

/** Long enough for any real endpoint, short enough to bound the row. */
const MAX_ENDPOINT_LENGTH = 1024;

/**
 * The exact sizes a browser produces, and the only sizes that can ever work.
 *
 * `p256dh` is an UNCOMPRESSED P-256 public key: one 0x04 prefix byte plus two
 * 32-byte coordinates. `auth` is a 16-byte secret. Both are fixed by RFC 8291.
 *
 * WHY THIS IS CHECKED RATHER THAN LEFT TO THE PUSH LIBRARY
 * -------------------------------------------------------
 * Found by sending a real push with a made-up key. `web-push` rejects a
 * wrong-sized key BEFORE making any request, so the error carries no HTTP
 * status — and an error with no status is, correctly, treated as transient and
 * the subscription is kept. The row then lives forever, retried on every
 * notification that person should have received, and nothing ever surfaces it.
 *
 * A key that cannot work is not a transient failure. It is a validation error,
 * and validation errors belong at the edge, while there is still a caller to
 * tell.
 */
const P256DH_BYTES = 65;
const AUTH_BYTES = 16;

export class RegisterPushSubscription {
  constructor(private readonly ports: Ports) {}

  async execute(user: User, input: RegisterPushSubscriptionInput): Promise<void> {
    assertSafeEndpoint(input.endpoint);

    if (
      !isBase64UrlOfLength(input.p256dh, P256DH_BYTES) ||
      !isBase64UrlOfLength(input.auth, AUTH_BYTES)
    ) {
      throw new ValidationError('That subscription is not in a form we can use.');
    }

    await this.ports.pushSubscriptions.save({
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
      userId: user.id,
      createdAt: this.ports.clock.now(),
    });

    this.ports.logger.debug({ userId: user.id }, 'push subscription registered');
  }
}

/**
 * USE CASE: stop notifications for one device.
 *
 * Deliberately does NOT check that the endpoint belongs to the caller.
 *
 * That sounds wrong and is not. The endpoint is the device's own address, held
 * only by the browser that owns it — a caller who has one is that device. And
 * the failure modes are lopsided: refusing to unsubscribe someone who asked is
 * a person who cannot make their phone stop buzzing, while the worst an
 * attacker with a guessed endpoint achieves is switching off a notification.
 * Between those two, silence is the safer error.
 */
export class RemovePushSubscription {
  constructor(private readonly ports: Ports) {}

  async execute(_user: User, endpoint: string): Promise<void> {
    await this.ports.pushSubscriptions.remove(endpoint);
  }
}

/**
 * USE CASE: notify a person on whatever devices they have registered.
 *
 * WHAT THIS IS ALLOWED TO SAY
 * ---------------------------
 * A notification is rendered on a LOCKED SCREEN — on a bus, on a desk in a
 * shared office, on a phone someone else picks up. The rule, enforced here and
 * repeated in the service worker: it may say WHO and WHAT KIND, never WHAT.
 *
 *     "Priya sent you a message"        yes
 *     "Priya: I'm leaving him"          never
 *
 * That is why this use case takes a structured `PushMessage` built by its
 * caller from names and event types, and why no code path anywhere passes user
 * text into it. A product whose whole safety model is about who can see what
 * cannot spray message contents onto lock screens.
 *
 * WHY IT IS BEST-EFFORT
 * ---------------------
 * Everything here is a nudge to open an app that works perfectly without it.
 * A failure must never propagate into the action that triggered it: nobody's
 * call should fail because a push service was having a bad minute.
 */
export class SendPush {
  constructor(private readonly ports: Ports) {}

  async execute(userId: UserId, message: PushMessage): Promise<void> {
    try {
      const subscriptions = await this.ports.pushSubscriptions.listForUser(userId);
      if (subscriptions.length === 0) return;

      const result = await this.ports.push.send(userId, subscriptions, message);

      // The push service's 404/410 is the ONLY signal that a device is gone.
      // Ignoring it means the table grows forever and every future
      // notification pays to push into browsers that no longer exist.
      if (result.expired.length > 0) {
        await this.ports.pushSubscriptions.removeMany(result.expired);
        this.ports.logger.debug(
          { userId, removed: result.expired.length },
          'removed expired push subscriptions',
        );
      }
    } catch (error) {
      this.ports.logger.warn({ userId, err: String(error) }, 'push notification failed');
    }
  }
}

/**
 * Whether a string is base64url decoding to exactly `bytes` bytes.
 *
 * The character check comes first and is not decoration: `Buffer.from` with
 * base64 silently IGNORES anything outside the alphabet, so `"!!!!"` and `""`
 * both decode to zero bytes without complaint. Validating the alphabet is what
 * makes the length check mean what it says.
 */
function isBase64UrlOfLength(value: string, bytes: number): boolean {
  // Base64 of n bytes is ceil(n/3)*4 characters, minus any padding. Bounding
  // the string first means a megabyte of input is refused before it is decoded.
  if (value.length === 0 || value.length > Math.ceil(bytes / 3) * 4 + 4) return false;
  if (!/^[A-Za-z0-9\-_]+=*$/.test(value)) return false;

  return Buffer.from(value, 'base64url').length === bytes;
}

/**
 * Refuse an endpoint the server should not be making requests to.
 *
 * The check is deliberately a small allowlist of shapes rather than a blocklist
 * of addresses: blocklists of "internal" ranges are famously incomplete, and
 * every legitimate push service is an ordinary public HTTPS host.
 */
function assertSafeEndpoint(endpoint: string): void {
  if (endpoint.length === 0 || endpoint.length > MAX_ENDPOINT_LENGTH) {
    throw new ValidationError('That subscription is not in a form we can use.');
  }

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ValidationError('That subscription is not in a form we can use.');
  }

  if (url.protocol !== 'https:') {
    throw new ValidationError('That subscription is not in a form we can use.');
  }

  const host = url.hostname.toLowerCase();

  // Loopback, link-local and the cloud metadata address. `.localhost` and
  // trailing-dot forms are included because both resolve locally and both are
  // easy to forget.
  const internal =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '127.0.0.1' ||
    host.startsWith('127.') ||
    host === '::1' ||
    host === '[::1]' ||
    host === '0.0.0.0' ||
    host === '169.254.169.254' ||
    host.startsWith('169.254.') ||
    host.startsWith('10.') ||
    host.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host.endsWith('.internal') ||
    host.endsWith('.local');

  if (internal) {
    throw new ValidationError('That subscription is not in a form we can use.');
  }
}
