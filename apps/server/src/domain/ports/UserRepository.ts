import type { IdentifierKind, User, UserStatus } from '../entities/User.js';
import type { TrustEvent } from '../entities/TrustEvent.js';
import type { StreakState } from '../values/streaks.js';
import type { UserId } from '../values/ids.js';

/**
 * PORT: UserRepository
 *
 * WHY THIS SHAPE
 * --------------
 * Plain CRUD plus exactly the queries the use cases need — no generic
 * `find(criteria)` escape hatch. A repository that accepts arbitrary query
 * objects is an ORM in disguise: it leaks storage semantics upward and makes it
 * impossible to know, from the interface alone, what the database is actually
 * asked to do (and therefore which indexes matter).
 *
 * MAPPING RULE: implementations return DOMAIN ENTITIES, never rows. The
 * row -> entity mapping happens inside the adapter, which is the only code that
 * knows a `dob` arrives as a string or that `trust_score` is a numeric.
 */

export interface CreateUserInput {
  readonly id: UserId;
  readonly identifier: string;
  readonly identifierKind: IdentifierKind;
  readonly displayName: string;
  readonly avatarSeed: string;
  readonly dob: Date;
  readonly createdAt: Date;
}

export interface UserRepository {
  create(input: CreateUserInput): Promise<User>;

  findById(id: UserId): Promise<User | null>;

  /** Lookup for login. `identifier` is already normalized by the auth use case. */
  findByIdentifier(identifier: string): Promise<User | null>;

  /** Batch load for member lists. Missing ids are simply absent from the result. */
  findManyByIds(ids: readonly UserId[]): Promise<readonly User[]>;

  updateProfile(id: UserId, changes: { displayName?: string; avatarSeed?: string }): Promise<User>;

  updateStatus(id: UserId, status: UserStatus): Promise<void>;

  /**
   * Append to the trust ledger AND refresh the cached `trust_score` projection.
   *
   * INVARIANT: these two writes must be atomic. A ledger entry without the
   * projection makes the score wrong until the next recompute; a projection
   * without the ledger makes it unexplainable. In Postgres this is one
   * transaction; the memory fake does both under one synchronous call.
   */
  appendTrustEvent(event: TrustEvent): Promise<number>;

  /** The user's ledger, newest first. Powers the admin view and "why am I limited?". */
  listTrustEvents(userId: UserId, limit: number): Promise<readonly TrustEvent[]>;

  // -- streaks -------------------------------------------------------------

  /**
   * Persist a recomputed streak.
   *
   * WHY THE WHOLE STATE RATHER THAN AN INCREMENT
   * --------------------------------------------
   * The decision of what the streak becomes is made by a pure function in the
   * domain, from the previous state and the user's own calendar. Offering an
   * `incrementStreak()` here would put that decision in the adapter — where the
   * daylight-saving arithmetic would have to be written twice, in SQL and in
   * JavaScript, and would eventually disagree.
   *
   * So the adapter's whole job is to write down an answer it did not make.
   *
   * `lastAt` is the UTC instant; `state.lastDay` is the local day it was
   * counted as. Both are stored: see migration 0002 for why the resolved day
   * must never be recomputed from the instant.
   */
  saveStreak(id: UserId, state: StreakState, lastAt: Date): Promise<void>;

  /** Change the timezone streak boundaries are computed in. */
  updateTimeZone(id: UserId, timeZone: string): Promise<void>;
}
