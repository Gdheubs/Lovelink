import type { UserId } from '../values/ids.js';

/**
 * PORT: PushSender — the only way to reach someone whose app is closed.
 *
 * WHY THIS IS A PORT AND NOT JUST "call web-push"
 * -----------------------------------------------
 * Web Push is three third parties wearing one interface. A subscription's
 * endpoint points at whichever service the browser chose — Google's FCM,
 * Mozilla's autopush, Apple's — and each has its own failure modes, its own
 * idea of rate limiting, and its own opinion about payload size. None of that
 * belongs in a use case that only wants to say "tell this person their phone is
 * ringing".
 *
 * It also swaps: the realistic alternative to Web Push on iOS is a native
 * wrapper with APNs, and if that day comes it should be one adapter, not a
 * rewrite of every feature that notifies.
 *
 * THE THREE RULES EVERY IMPLEMENTATION FOLLOWS
 * --------------------------------------------
 *
 * 1. NEVER THROW FOR A DEAD SUBSCRIPTION. Endpoints expire constantly — a
 *    browser update, a cleared profile, a phone replaced. That is the normal
 *    case, not an error, and a thrown exception would turn "your friend has a
 *    new phone" into a failed request for the person who called them.
 *
 * 2. REPORT WHICH SUBSCRIPTIONS ARE GONE. The push service answers 404 or 410
 *    for an endpoint that will never work again, and that is the ONLY signal we
 *    ever get. A caller that ignores it accumulates dead rows forever and
 *    pushes to them on every notification, which is both a bill and a
 *    slow-growing latency problem.
 *
 * 3. THE PAYLOAD IS RENDERED ON A LOCKED SCREEN. Whatever goes in `body` may be
 *    read by anyone glancing at a phone on a table. See PushMessage.
 */

export interface PushSubscription {
  /** The push service's URL for this device. Unique; also the identity. */
  readonly endpoint: string;
  /** The device's public key, base64url. */
  readonly p256dh: string;
  /** The device's auth secret, base64url. */
  readonly auth: string;
}

/**
 * What a person will actually see.
 *
 * WHAT MUST NEVER BE IN HERE
 * --------------------------
 * The contents of a message, the text of a surprise, or anything a person said.
 * A notification appears on a lock screen in a shared house, and the product's
 * entire safety posture is about who can see what. "Priya sent you a message"
 * is the promise; "Priya: I'm leaving him" is a betrayal of it, and no setting
 * a user can find would undo having shown it.
 *
 * The use cases enforce this by construction — they build these from names and
 * event types, never from user text — and the service worker refuses to render
 * anything it was not given.
 */
export interface PushMessage {
  readonly title: string;
  /** One short line. Who, and what kind of thing — never what was said. */
  readonly body: string;
  /** Where tapping it should land. A path, not an absolute URL. */
  readonly url: string;
  /**
   * Replaces an existing notification with the same tag rather than stacking.
   *
   * Five separate "someone is in the room" notifications is the fastest way to
   * make a person turn them off permanently.
   */
  readonly tag: string;
  /**
   * Vibrate, persist, and re-alert.
   *
   * Reserved for a call actually ringing. Everything else is an interruption
   * that can wait until the phone is picked up anyway.
   */
  readonly urgent: boolean;
}

export interface PushResult {
  readonly sent: number;
  /**
   * Endpoints the push service says are permanently gone (404/410).
   *
   * The caller is expected to delete these. Nothing else ever tells us a
   * device has stopped existing.
   */
  readonly expired: readonly string[];
}

export interface PushSender {
  /**
   * Deliver to every one of a person's devices.
   *
   * Fan-out is here rather than in the caller because "a user" and "a device"
   * are different things: someone with a phone and a laptop has two
   * subscriptions and must be notified once, on both.
   */
  send(
    userId: UserId,
    subscriptions: readonly PushSubscription[],
    message: PushMessage,
  ): Promise<PushResult>;

  /**
   * The public VAPID key clients need in order to subscribe.
   *
   * Null when push is not configured. That is a supported state, not a broken
   * one — a local dev environment has no keys, and everything else must keep
   * working without them.
   */
  publicKey(): string | null;
}
