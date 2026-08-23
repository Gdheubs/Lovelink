import type { PushSubscription } from './PushSender.js';
import type { UserId } from '../values/ids.js';

/**
 * PORT: where a device's push registration lives.
 *
 * WHY IT IS SEPARATE FROM PushSender
 * ----------------------------------
 * Storing a subscription and delivering to one are different concerns with
 * different failure modes and different lifetimes. Storage is ours and is
 * durable; delivery is a third party's and fails constantly. Folding them
 * together would mean the Postgres adapter had opinions about FCM.
 *
 * WHY THE ENDPOINT IS THE IDENTITY
 * --------------------------------
 * The browser gives no other stable handle for a device, and the same endpoint
 * can legitimately move between accounts — a shared laptop where one person
 * signs out and another signs in produces the same endpoint under a new user.
 * `save` therefore REPLACES the owner rather than adding a second row, which is
 * what stops the previous user's notifications landing on someone else's
 * screen.
 */
export interface StoredPushSubscription extends PushSubscription {
  readonly userId: UserId;
  readonly createdAt: Date;
  /** Last time a push to this endpoint succeeded. Null until one has. */
  readonly lastSeenAt: Date | null;
}

export interface PushSubscriptionRepository {
  /**
   * Register a device, or move an existing endpoint to this user.
   *
   * Idempotent: a client that re-subscribes on every load — which is the
   * correct client behaviour, since browsers rotate subscriptions — must not
   * accumulate rows.
   */
  save(subscription: PushSubscription & { userId: UserId; createdAt: Date }): Promise<void>;

  /** Every device this person has registered. */
  listForUser(userId: UserId): Promise<readonly StoredPushSubscription[]>;

  /** Forget one device. Silent when it was already gone. */
  remove(endpoint: string): Promise<void>;

  /**
   * Delete endpoints the push service has declared permanently dead.
   *
   * Called with whatever `PushSender.send` reported as expired. Without this
   * the table only ever grows, and every notification pays to push into
   * browsers that no longer exist.
   */
  removeMany(endpoints: readonly string[]): Promise<void>;

  /** Record that a push to this endpoint was accepted. */
  touch(endpoint: string, at: Date): Promise<void>;
}
