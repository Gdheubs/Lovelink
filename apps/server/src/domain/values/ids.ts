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
