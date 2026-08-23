import webpush from 'web-push';
import type { Logger } from '../../domain/ports/Logger.js';
import type {
  PushMessage,
  PushResult,
  PushSender,
  PushSubscription,
} from '../../domain/ports/PushSender.js';
import type { UserId } from '../../domain/values/ids.js';

/**
 * ADAPTER: Web Push, via the `web-push` package.
 *
 * THE ONLY FILE IN THE SERVER THAT IMPORTS IT, which is the whole point of the
 * port. Web Push is not a simple HTTP call: each payload is encrypted to the
 * receiving device with ECDH plus HKDF plus AES-GCM (RFC 8291), and every
 * request carries a signed VAPID JWT (RFC 8292). Hand-rolling that is a way to
 * get subtle crypto wrong in a place where the failure is silent.
 *
 * WHY A DEPENDENCY IS THE RIGHT CALL HERE, GIVEN THE PROJECT'S PREMISE
 * -------------------------------------------------------------------
 * The rule this codebase enforces is a dependency-free CORE — nothing vendor
 * may appear in `/domain` or `/app`. Adapters are precisely where vendor code
 * is supposed to live, and this is the canonical case for it: a fiddly,
 * standardised protocol with a well-tested implementation, isolated behind an
 * interface that says nothing about it.
 *
 * WHAT MAKES A PUSH "FAILED" IS THE INTERESTING PART
 * --------------------------------------------------
 * Three outcomes, and conflating them is the common bug:
 *
 *   - 201/202 — accepted by the push service. NOT delivered; the service will
 *     try, and we will never hear how it went. There is no read receipt in this
 *     protocol and pretending otherwise leads to features that quietly assume
 *     one.
 *   - 404/410 — this endpoint is permanently gone. The ONLY signal we ever get
 *     that a device has stopped existing, and the caller must delete the row or
 *     the table grows forever.
 *   - anything else — transient. A 429 from an overloaded service, a network
 *     blip, a 500. Logged and dropped: a notification is a nudge, and retrying
 *     one from an hour ago would be worse than never sending it.
 */

export interface WebPushConfig {
  /** base64url, uncompressed P-256 point. Shared with clients. */
  readonly publicKey: string;
  readonly privateKey: string;
  /**
   * `mailto:` or an https URL identifying whoever runs this deployment.
   *
   * Required by VAPID, and not decoration: it is how a push service reaches a
   * human when a deployment misbehaves, instead of simply blocking it.
   */
  readonly subject: string;
}

/**
 * Payload ceiling.
 *
 * The spec guarantees 4096 bytes AFTER encryption, and encryption adds overhead
 * — so the plaintext budget is smaller than it looks. Everything this product
 * sends is a name and a short phrase, so this is a guard against a bug rather
 * than a real constraint; a payload over it is truncated rather than dropped,
 * because a clipped notification still tells someone to open the app.
 */
const MAX_PAYLOAD_BYTES = 3_000;

/** How long the push service should hold it if the device is offline. */
const TTL_URGENT_SECONDS = 60;
const TTL_NORMAL_SECONDS = 6 * 60 * 60;

export class WebPushSender implements PushSender {
  private readonly configured: boolean;

  constructor(
    config: WebPushConfig | null,
    private readonly logger: Logger,
  ) {
    this.configured = config !== null;

    if (config !== null) {
      webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
      this.publicKeyValue = config.publicKey;
    }
  }

  private publicKeyValue: string | null = null;

  publicKey(): string | null {
    return this.publicKeyValue;
  }

  async send(
    userId: UserId,
    subscriptions: readonly PushSubscription[],
    message: PushMessage,
  ): Promise<PushResult> {
    // A deployment with no keys is a supported state — local development has
    // none — and everything must keep working without them.
    if (!this.configured || subscriptions.length === 0) {
      return { sent: 0, expired: [] };
    }

    const payload = this.encode(message);
    const expired: string[] = [];
    let sent = 0;

    // Concurrent, because a person with three devices should not wait for three
    // sequential round trips to three different push services.
    await Promise.all(
      subscriptions.map(async (subscription) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: subscription.endpoint,
              keys: { p256dh: subscription.p256dh, auth: subscription.auth },
            },
            payload,
            {
              TTL: message.urgent ? TTL_URGENT_SECONDS : TTL_NORMAL_SECONDS,
              // A ringing call should interrupt; nothing else should wake a
              // dozing phone's radio ahead of schedule.
              urgency: message.urgent ? 'high' : 'normal',
            },
          );
          sent += 1;
        } catch (error) {
          const status = (error as { statusCode?: number }).statusCode;

          if (status === 404 || status === 410) {
            // Gone for good. The caller deletes it.
            expired.push(subscription.endpoint);
            return;
          }

          // Transient. Not retried: see the note at the top about a stale
          // notification being worse than none.
          this.logger.warn(
            { userId, status, endpoint: redactEndpoint(subscription.endpoint) },
            'push delivery failed',
          );
        }
      }),
    );

    return { sent, expired };
  }

  /**
   * The payload the service worker will parse.
   *
   * Note what is NOT here: no user id, no message text, no room contents. The
   * port's documentation explains why, and this is where it is actually true —
   * whatever ends up in this JSON is what appears on a lock screen.
   */
  private encode(message: PushMessage): string {
    const json = JSON.stringify({
      title: message.title,
      body: truncate(message.body, 140),
      url: message.url,
      tag: message.tag,
      urgent: message.urgent,
    });

    if (Buffer.byteLength(json, 'utf8') <= MAX_PAYLOAD_BYTES) return json;

    // Should be unreachable given the 140-character body. If it happens, a
    // clipped notification still does its one job.
    this.logger.warn({ bytes: Buffer.byteLength(json, 'utf8') }, 'push payload over budget');
    return JSON.stringify({
      title: message.title,
      body: 'Open Loverlink to see.',
      url: message.url,
      tag: message.tag,
      urgent: message.urgent,
    });
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * Endpoints are per-device secrets: anyone holding one can push to that device.
 *
 * Logging them in full would put a working notification channel into whatever
 * log aggregator this ends up in, so only enough to correlate two lines about
 * the same device ever reaches a log.
 */
function redactEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    return `${url.origin}/…${endpoint.slice(-6)}`;
  } catch {
    return '…';
  }
}
