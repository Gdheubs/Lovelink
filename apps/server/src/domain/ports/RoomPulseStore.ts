import type { RoomFeeling } from '../values/roomFeeling.js';
import type { RoomId, UserId } from '../values/ids.js';

/**
 * PORT: how a room feels, according to the people currently in it.
 *
 * WHY THE VOTES ARE KEYED BY USER AND STILL ANONYMOUS
 * ---------------------------------------------------
 * The store knows who voted — it has to, or one person could vote fifty times
 * and a room's mood would be whoever cared most. What no screen ever learns is
 * WHO SAID WHAT: the read that builds the pulse returns a bag of feelings with
 * the identities discarded.
 *
 * There IS a `voteOf`, and it is the one exception: a screen has to be able to
 * show someone their own choice selected, or the control reads as broken after
 * a reload. What makes that safe is not the port — it is that exactly one use
 * case calls it, and only ever with the authenticated caller's own id.
 *
 * The rule to hold, then, is about call sites rather than capability: nothing
 * may pass an id it did not authenticate. That is an ordinary authorization
 * discipline, and pretending the method should not exist would just mean a
 * screen that forgets what you told it.
 *
 * WHY IT DECAYS RATHER THAN ACCUMULATING
 * --------------------------------------
 * A room's mood at 2am is not its mood at 8pm. Implementations expire the whole
 * set, so a room that has gone quiet stops claiming to be playful without
 * anything having to run — and there is no permanent record of what anyone
 * thought of a room they were in.
 *
 * WHY THE THRESHOLD IS NOT ENFORCED HERE
 * --------------------------------------
 * This returns raw votes; `summarizePulse` in the domain decides whether there
 * are enough of them to show anything. That split is deliberate: the rule is
 * about what may be DISPLAYED, it is the same rule for every edge, and it
 * belongs somewhere unit-testable rather than in an adapter.
 */
export interface RoomPulseStore {
  /**
   * Record how this person finds the room. Replaces their previous answer.
   *
   * `windowSeconds` refreshes the whole room's expiry, which is right: a room
   * that is still being voted in is still live.
   */
  vote(
    roomId: RoomId,
    userId: UserId,
    feeling: RoomFeeling,
    windowSeconds: number,
  ): Promise<void>;

  /**
   * Every current vote, IDENTITIES DISCARDED.
   *
   * Returns feelings only — never a map, never a list of voters. The shape of
   * the return value is the anonymity guarantee.
   */
  currentVotes(roomId: RoomId): Promise<readonly RoomFeeling[]>;

  /**
   * What ONE person said, for showing them their own selection.
   *
   * CALLERS MUST PASS ONLY THE AUTHENTICATED USER'S OWN ID. There is no
   * legitimate reason to ask this about anybody else, and doing so would turn
   * an anonymous mood into a record of who thought what about a room they were
   * in.
   */
  voteOf(roomId: RoomId, userId: UserId): Promise<RoomFeeling | null>;

  /** Forget a room's pulse entirely. Called when a room closes. */
  clear(roomId: RoomId): Promise<void>;
}
