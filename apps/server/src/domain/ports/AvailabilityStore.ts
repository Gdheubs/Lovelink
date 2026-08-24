import type { Availability, Intent } from '../values/presenceIntent.js';
import type { UserId } from '../values/ids.js';

/**
 * PORT: what someone is here for tonight, and whether their door is open.
 *
 * WHY THIS IS ITS OWN PORT AND NOT TWO COLUMNS ON `users`
 * -------------------------------------------------------
 * Both values are about TONIGHT, and a column has no opinion about time. Stored
 * on the user they would persist until overwritten, which turns "I am here to
 * listen" into a profile field — a bio with extra steps — and leaves someone
 * advertising "open to meeting" a fortnight after they stopped meaning it.
 *
 * Expressing them as expiring state makes the lifetime part of the interface
 * rather than a cleanup job somebody has to remember to write.
 *
 * THE FAILURE DIRECTION IS THE POINT
 * ----------------------------------
 * An implementation backed by a store that can be lost — Redis — means losing
 * it CLOSES every open door and clears every intent. For a signal about
 * availability to strangers, failing closed is the only acceptable direction,
 * and it is the reason this is deliberately not durable.
 *
 * INVARIANT: reads must never resurrect expired state. A door that was open
 * eight hours ago is closed, and an implementation that returns it as open is
 * broken in the one way that matters.
 */
export interface AvailabilityStore {
  /**
   * What this person is here for, and whether their door is open.
   * Returns the closed default for anyone who has said nothing.
   */
  get(userId: UserId): Promise<Availability>;

  /** Batch read, for a screen showing several people at once. */
  getMany(userIds: readonly UserId[]): Promise<ReadonlyMap<UserId, Availability>>;

  /**
   * Set tonight's intent. Replaces any previous one and restarts its clock —
   * changing your mind should not inherit the old expiry.
   */
  setIntent(userId: UserId, intent: Intent, ttlSeconds: number): Promise<void>;

  /** Clear it now, without waiting for the TTL. */
  clearIntent(userId: UserId): Promise<void>;

  /**
   * Open or close the door.
   *
   * Closing takes effect immediately and completely: someone who changes their
   * mind must not stay visible for the remainder of a TTL.
   */
  setOpenDoor(userId: UserId, open: boolean, ttlSeconds: number): Promise<void>;
}
