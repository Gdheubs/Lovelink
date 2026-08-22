/**
 * Branded id types.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every id in this system is a string, which means the compiler will happily let
 * you pass a roomId where a userId belongs — a class of bug that is invisible in
 * review and catastrophic in an authorization check (`kick(roomId, roomId)`).
 * Branding costs one cast at the boundary and eliminates the whole family.
 *
 * INVARIANT: ids are only minted by `IdGenerator` (a port) or re-hydrated from
 * the database at the adapter boundary. Domain code never constructs one from a
 * raw string except via the explicit `asX()` helpers below, which exist so that
 * the cast is greppable.
 */

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type UserId = Brand<string, 'UserId'>;
export type RoomId = Brand<string, 'RoomId'>;
export type SurpriseId = Brand<string, 'SurpriseId'>;
export type ReportId = Brand<string, 'ReportId'>;
export type MessageId = Brand<string, 'MessageId'>;
export type SessionId = Brand<string, 'SessionId'>;

export const asUserId = (v: string): UserId => v as UserId;
export const asRoomId = (v: string): RoomId => v as RoomId;
export const asSurpriseId = (v: string): SurpriseId => v as SurpriseId;
export const asReportId = (v: string): ReportId => v as ReportId;
export const asMessageId = (v: string): MessageId => v as MessageId;
export const asSessionId = (v: string): SessionId => v as SessionId;

/** Stable ordering for a pair of users, so `relationships` has one row per pair. */
export function orderedPair(a: UserId, b: UserId): readonly [UserId, UserId] {
  return a <= b ? [a, b] : [b, a];
}

/** Canonical key for a user pair — used for relationship lookups and rate-limit keys. */
export function pairKey(a: UserId, b: UserId): string {
  const [x, y] = orderedPair(a, b);
  return `${x}:${y}`;
}

/**
 * The media room two people share when they call each other.
 *
 * WHY IT IS DERIVED RATHER THAN ALLOCATED
 * ---------------------------------------
 * Both sides need to agree on the room name, and the obvious way to do that —
 * generate an id when the call starts and pass it around — means the name only
 * exists in a message that can be lost. A caller who reconnects mid-ring, or a
 * recipient whose `call:incoming` arrived twice, would otherwise have no way to
 * be sure they were about to join the same room.
 *
 * Deriving it from the pair makes the name a FACT rather than a message. It is
 * the same before, during and after the call, on both clients, after any
 * restart, with no lookup.
 *
 * IT IS DELIBERATELY NOT A `rooms` ROW. A 1:1 call must never appear in the
 * room directory, and the surest way to guarantee that is for it to have no row
 * to be listed from. It exists only as a name the media server knows.
 *
 * The value is not a secret and does not need to be: possession of the name
 * grants nothing. Joining requires a token, and tokens are only minted by
 * AcceptCall for the two people the relationship names.
 */
export function callRoomId(a: UserId, b: UserId): RoomId {
  const [x, y] = orderedPair(a, b);
  return asRoomId(`call-${x}-${y}`);
}
