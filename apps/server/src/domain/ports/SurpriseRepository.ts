import type { Surprise, SurpriseMood, SurpriseTask, SurpriseTheme } from '../entities/Surprise.js';
import type { SurpriseId, UserId } from '../values/ids.js';

/**
 * PORT: SurpriseRepository
 *
 * WHY `redeem` IS ITS OWN METHOD
 * ------------------------------
 * Redemption is a compare-and-set, not an update: "set recipient and openedAt
 * ONLY IF openedAt is still null". Exposing it as a generic `update` would make
 * every caller responsible for the race, and two people opening the same code
 * simultaneously would both win. Making the atomicity part of the interface
 * means the Postgres adapter can express it as a conditional UPDATE ... WHERE
 * opened_at IS NULL RETURNING, and the memory fake can be correct by being
 * synchronous.
 *
 * The boolean return says whether THIS caller was the one that claimed it.
 */

export interface CreateSurpriseInput {
  readonly id: SurpriseId;
  /** Normalized (uppercase, alphanumeric only) — see entities/Surprise.ts. */
  readonly code: string;
  readonly senderId: UserId;
  readonly theme: SurpriseTheme;
  readonly message: string;
  readonly tasks: readonly SurpriseTask[];
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export interface SurpriseRepository {
  create(input: CreateSurpriseInput): Promise<Surprise>;

  findById(id: SurpriseId): Promise<Surprise | null>;

  /** `code` must already be normalized by the caller. */
  findByCode(code: string): Promise<Surprise | null>;

  /**
   * Atomically claim an unredeemed surprise.
   * @returns the claimed surprise, or null if someone else got there first
   *          (or it was already open / expired).
   */
  redeem(
    code: string,
    recipientId: UserId,
    mood: SurpriseMood,
    openedAt: Date,
  ): Promise<Surprise | null>;

  /** Toggle one task's done flag. Index-based, matching the stored array order. */
  setTaskDone(id: SurpriseId, taskIndex: number, done: boolean): Promise<Surprise>;

  listSentBy(senderId: UserId, limit: number): Promise<readonly Surprise[]>;

  listReceivedBy(recipientId: UserId, limit: number): Promise<readonly Surprise[]>;
}
