/**
 * The complete set of things the domain needs from the outside world.
 *
 * If you are adding an integration, it gets an interface here FIRST, then an
 * implementation in /src/adapters, then a fake in /src/adapters/memory. In that
 * order — writing the adapter first is how vendor concepts leak into the
 * interface (a port with a `RedisPipeline` in its signature is not a port).
 *
 * The `Ports` bundle below is what the composition root assembles and what
 * every use case draws from. Keeping it as one named type means adding a
 * dependency is a compile error at every construction site rather than a
 * runtime `undefined` in production.
 */

export * from './AuthChallengeStore.js';
export * from './Clock.js';
export * from './EventBus.js';
export * from './IdGenerator.js';
export * from './Logger.js';
export * from './MediaRoomProvider.js';
export * from './MessageRepository.js';
export * from './Metrics.js';
export * from './NotificationSender.js';
export * from './PresenceStore.js';
export * from './RateLimiter.js';
export * from './RealtimeTransport.js';
export * from './RelationshipRepository.js';
export * from './ReportRepository.js';
export * from './RoomRepository.js';
export * from './SurpriseRepository.js';
export * from './TokenService.js';
export * from './UserRepository.js';

import type { AuthChallengeStore } from './AuthChallengeStore.js';
import type { Clock } from './Clock.js';
import type { EventBus } from './EventBus.js';
import type { IdGenerator } from './IdGenerator.js';
import type { Logger } from './Logger.js';
import type { MediaRoomProvider } from './MediaRoomProvider.js';
import type { MessageRepository } from './MessageRepository.js';
import type { Metrics } from './Metrics.js';
import type { NotificationSender } from './NotificationSender.js';
import type { PresenceStore } from './PresenceStore.js';
import type { RateLimiter } from './RateLimiter.js';
import type { RealtimeTransport } from './RealtimeTransport.js';
import type { RelationshipRepository } from './RelationshipRepository.js';
import type { ReportRepository } from './ReportRepository.js';
import type { RoomRepository } from './RoomRepository.js';
import type { SurpriseRepository } from './SurpriseRepository.js';
import type { PushSubscriptionRepository } from './PushSubscriptionRepository.js';
import type { PushSender } from './PushSender.js';
import type { ObjectStore } from './ObjectStore.js';
import type { JobQueue } from './JobQueue.js';
import type { AvailabilityStore } from './AvailabilityStore.js';
import type { RoomPulseStore } from './RoomPulseStore.js';
import type { TokenService } from './TokenService.js';
import type { UserRepository } from './UserRepository.js';

/**
 * Everything the application ring may depend on.
 *
 * NOTE the absence of anything HTTP- or socket-shaped: use cases are called BY
 * an edge, they do not reach back into one. The only outbound realtime path is
 * `realtime` (server -> client) and `bus` (server -> server).
 */
export interface Ports {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly metrics: Metrics;

  readonly users: UserRepository;
  readonly rooms: RoomRepository;
  readonly surprises: SurpriseRepository;
  readonly pushSubscriptions: PushSubscriptionRepository;
  readonly push: PushSender;
  /**
   * Large files. No feature uses it yet — see the port for why it is defined
   * before there is one.
   */
  readonly objects: ObjectStore;
  /** Work that must not happen inside a request. Consumed by workers, not here. */
  readonly jobs: JobQueue;
  /** Tonight's intent and open door. Expires on its own; fails closed. */
  readonly availability: AvailabilityStore;
  /** How a room feels. Decays; never exposes who said what. */
  readonly pulse: RoomPulseStore;
  readonly reports: ReportRepository;
  readonly relationships: RelationshipRepository;
  readonly messages: MessageRepository;

  readonly presence: PresenceStore;
  readonly bus: EventBus;
  readonly realtime: RealtimeTransport;
  readonly rateLimiter: RateLimiter;
  readonly media: MediaRoomProvider;

  readonly tokens: TokenService;
  readonly challenges: AuthChallengeStore;
  readonly notifications: NotificationSender;
}
