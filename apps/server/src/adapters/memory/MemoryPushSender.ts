import type {
  PushMessage,
  PushResult,
  PushSender,
  PushSubscription,
} from '../../domain/ports/PushSender.js';
import type { Logger } from '../../domain/ports/Logger.js';
import type { UserId } from '../../domain/values/ids.js';

/**
 * ADAPTER (memory): PushSender.
 *
 * Records what WOULD have been sent, and logs it. That makes `dev:memory` able
 * to exercise the whole notification path — including the "does this leak
 * anything onto a lock screen" question — with no VAPID keys, no push service,
 * and no device.
 *
 * IT MODELS EXPIRY, which matters more than it sounds. Dead endpoints are the
 * normal case in production, and a fake that always succeeds would let a caller
 * forget to delete them; the whole table would then grow silently until someone
 * noticed the send path getting slower. `expireNext` lets a test make that
 * happen on purpose.
 */
export class MemoryPushSender implements PushSender {
  /** Everything sent, for assertions. */
  readonly sent: { userId: UserId; endpoint: string; message: PushMessage }[] = [];

  /** Endpoints to report as permanently gone on the next send. */
  private readonly expiring = new Set<string>();

  constructor(
    private readonly logger: Logger,
    private readonly key: string | null = 'memory-vapid-public-key',
  ) {}

  publicKey(): string | null {
    return this.key;
  }

  async send(
    userId: UserId,
    subscriptions: readonly PushSubscription[],
    message: PushMessage,
  ): Promise<PushResult> {
    const expired: string[] = [];
    let sent = 0;

    for (const subscription of subscriptions) {
      if (this.expiring.has(subscription.endpoint)) {
        expired.push(subscription.endpoint);
        continue;
      }

      this.sent.push({ userId, endpoint: subscription.endpoint, message });
      sent += 1;

      // Logged at debug so a developer can see the notification they would
      // have received. The body is deliberately safe to log — see PushSender
      // for why nothing private is ever in it.
      this.logger.debug(
        { userId, title: message.title, body: message.body, url: message.url },
        'push (memory)',
      );
    }

    return { sent, expired };
  }

  // -- test helpers (not part of the port) ---------------------------------

  /** Make the next send report this endpoint as permanently gone. */
  expireNext(endpoint: string): void {
    this.expiring.add(endpoint);
  }

  messagesFor(userId: UserId): PushMessage[] {
    return this.sent.filter((entry) => entry.userId === userId).map((entry) => entry.message);
  }

  clear(): void {
    this.sent.length = 0;
    this.expiring.clear();
  }
}
