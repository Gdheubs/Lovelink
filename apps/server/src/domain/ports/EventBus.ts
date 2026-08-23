import type { RoomId, UserId } from '../values/ids.js';

/**
 * PORT: EventBus
 *
 * WHY THIS EXISTS
 * ---------------
 * The API process and the realtime process are separate modules today and
 * separate processes tomorrow (see architecture §3). When the API bans a user,
 * the socket holding that user's connection may live in a different process —
 * so enforcement cannot be a function call, it has to be a message.
 *
 * This is deliberately NOT the same port as RealtimeTransport:
 *
 *   EventBus          = server -> server. Fan-out between our own processes.
 *   RealtimeTransport = server -> client. Delivery to a browser.
 *
 * Conflating them is the mistake that makes a system impossible to scale out,
 * because every "notify the user" call site silently assumes the socket is
 * local.
 *
 * INVARIANT: events are FACTS about things that already happened, named in the
 * past tense, and carry enough data for a subscriber to act without a database
 * read on the hot path. Delivery is at-most-once and unordered — subscribers
 * must be idempotent and must not assume they saw the previous event.
 */

/** The channel catalogue. One channel per concern, not one per event type. */
export type BusChannel = 'moderation' | 'presence' | 'surprise' | 'relationship' | 'rooms';

/**
 * Enforcement events. A subscriber that misses one leaves a banned user
 * connected, so the ban path ALSO checks status on the next socket action —
 * belt and braces, because the bus is not a guarantee.
 */
export interface UserBannedEvent {
  readonly type: 'user.banned';
  readonly userId: UserId;
  readonly permanent: boolean;
  readonly reason: string;
}

export interface UserKickedEvent {
  readonly type: 'user.kicked';
  readonly userId: UserId;
  readonly roomId: RoomId;
  readonly byUserId: UserId;
}

export interface SurpriseReceivedEvent {
  readonly type: 'surprise.received';
  readonly recipientId: UserId;
  readonly surpriseId: string;
  readonly senderDisplayName: string;
}

export interface RelationshipChangedEvent {
  readonly type: 'relationship.changed';
  readonly userA: UserId;
  readonly userB: UserId;
  readonly state: string;
}

export interface PresenceReapedEvent {
  readonly type: 'presence.reaped';
  readonly userId: UserId;
  readonly roomId: RoomId;
}

/**
 * A scheduled room reached its time and was opened by the sweep.
 *
 * Published so any process can react — a future push-notification worker in
 * particular. It carries what a notification needs (the title, the slug to
 * link to) rather than only an id, because the subscriber may be in a
 * different process with no database handle.
 */
export interface RoomOpenedEvent {
  readonly type: 'room.opened';
  readonly roomId: RoomId;
  readonly slug: string;
  readonly title: string;
  /** False would mean a host opened it by hand; only the sweep publishes today. */
  readonly scheduled: boolean;
}

export type BusEvent =
  | RoomOpenedEvent
  | UserBannedEvent
  | UserKickedEvent
  | SurpriseReceivedEvent
  | RelationshipChangedEvent
  | PresenceReapedEvent;

export type BusHandler = (event: BusEvent) => void | Promise<void>;

export interface EventBus {
  publish(channel: BusChannel, event: BusEvent): Promise<void>;

  /**
   * Subscribe to a channel.
   * Returns an unsubscribe function — without one, hot-reloading in dev stacks
   * duplicate handlers until every event fires a dozen times.
   */
  subscribe(channel: BusChannel, handler: BusHandler): Promise<() => Promise<void>>;

  /** Release connections. Called on graceful shutdown. */
  close(): Promise<void>;
}
