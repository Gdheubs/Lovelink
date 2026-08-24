import { Redis, type RedisOptions } from 'ioredis';
import type { Logger } from '../../domain/ports/Logger.js';

/**
 * Redis connection factory.
 *
 * WHY SEVERAL CONNECTIONS AND NOT ONE
 * -----------------------------------
 * A Redis connection in SUBSCRIBE mode cannot run ordinary commands. So the
 * EventBus needs its own subscriber connection, separate from the one everything
 * else uses for GET/INCR/EXPIRE. The Socket.io Redis adapter needs a further
 * pair for the same reason.
 *
 * Getting this wrong produces a confusing failure — commands start returning
 * "only (P)SUBSCRIBE / ... allowed in this context" from a code path that has
 * nothing to do with pub/sub — so the factory makes the separation explicit
 * rather than leaving it to whoever wires things up.
 */

export type RedisClient = Redis;

export interface RedisFactoryOptions {
  readonly url: string;
  readonly logger: Logger;
}

function baseOptions(logger: Logger, role: string): RedisOptions {
  return {
    // Retry with backoff, capped. Redis holds presence and rate limits: losing
    // it degrades the product but must not crash the process, because a crash
    // takes every live voice room down with it.
    retryStrategy: (times) => Math.min(times * 200, 5_000),
    maxRetriesPerRequest: 3,
    // Queue commands issued before the connection is ready rather than
    // rejecting them, so a request arriving during a reconnect waits instead of
    // failing.
    enableOfflineQueue: true,
    lazyConnect: false,
    connectionName: `loverlink-${role}`,
    reconnectOnError(error) {
      // READONLY means we have been pointed at a replica after a failover.
      // Reconnecting picks up the new primary; anything else is not something
      // a reconnect fixes.
      if (error.message.includes('READONLY')) {
        logger.warn({ role }, 'redis returned READONLY; reconnecting to find the primary');
        return true;
      }
      return false;
    },
  };
}

export function createRedisClient(options: RedisFactoryOptions, role: string): RedisClient {
  const log = options.logger.child({ component: 'redis', role });
  const client = new Redis(options.url, baseOptions(log, role));

  // Without an error listener, ioredis emits 'error' as an unhandled event and
  // Node terminates the process. This is the difference between "Redis blipped"
  // and "the API restarted".
  client.on('error', (error: Error) => {
    log.error({ err: error.message }, 'redis connection error');
  });

  client.on('reconnecting', () => {
    log.warn({}, 'redis reconnecting');
  });

  client.on('ready', () => {
    log.info({}, 'redis ready');
  });

  return client;
}

/**
 * Key namespacing.
 *
 * Every key this application writes is prefixed, so that a shared Redis (a
 * cheap managed instance, or a developer's local one running three projects)
 * cannot produce a collision — and so `KEYS loverlink:*` is a safe way to see
 * exactly what we own.
 */
export const KEY = {
  presenceRoom: (roomId: string) => `loverlink:presence:room:${roomId}`,
  presenceMember: (roomId: string, userId: string) =>
    `loverlink:presence:member:${roomId}:${userId}`,
  presenceUserRooms: (userId: string) => `loverlink:presence:user:${userId}`,
  /** Sorted set of every live member entry, scored by expiry — the reaper's index. */
  presenceExpiryIndex: 'loverlink:presence:expiry',
  rateLimit: (key: string) => `loverlink:rl:${key}`,
  challenge: (identifier: string) => `loverlink:auth:challenge:${identifier}`,
  refreshToken: (token: string) => `loverlink:auth:refresh:${token}`,
  sessionRevoked: (sessionId: string) => `loverlink:auth:revoked:${sessionId}`,
  userSessions: (userId: string) => `loverlink:auth:sessions:${userId}`,
  roomMessages: (roomId: string) => `loverlink:chat:room:${roomId}`,
  metricTotal: (name: string) => `loverlink:metric:total:${name}`,
  metricDaily: (name: string, day: string) => `loverlink:metric:day:${name}:${day}`,
  busChannel: (channel: string) => `loverlink:bus:${channel}`,
  /* Tonight's state. Both carry a TTL — see AvailabilityStore for why losing
     them must CLOSE a door rather than leave one open. */
  intent: (userId: string) => `loverlink:tonight:intent:${userId}`,
  openDoor: (userId: string) => `loverlink:tonight:door:${userId}`,
  /* Room pulse: a hash of userId -> feeling, with a whole-key TTL so a room's
     mood decays rather than accumulating. */
  roomPulse: (roomId: string) => `loverlink:pulse:${roomId}`,
} as const;
