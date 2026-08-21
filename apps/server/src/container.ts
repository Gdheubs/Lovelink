import type { Config } from './config.js';
import type { Logger } from './domain/ports/Logger.js';
import type { Ports } from './domain/ports/index.js';
import type { RealtimeTransport } from './domain/ports/RealtimeTransport.js';
import { systemClock } from './domain/ports/Clock.js';
import { createMemoryPorts } from './adapters/memory/index.js';
import { CryptoIdGenerator } from './adapters/memory/MemoryIdGenerator.js';
import { MemoryNotificationSender } from './adapters/memory/MemoryNotificationSender.js';
import { JwtTokenService } from './adapters/auth/JwtTokenService.js';
import { createDatabase } from './adapters/postgres/db.js';
import { PostgresRoomRepository } from './adapters/postgres/PostgresRoomRepository.js';
import { PostgresUserRepository } from './adapters/postgres/PostgresUserRepository.js';
import { CompositeMessageRepository } from './adapters/messages/CompositeMessageRepository.js';
import { createRedisClient } from './adapters/redis/client.js';
import { RedisAuthChallengeStore } from './adapters/redis/RedisAuthChallengeStore.js';
import { RedisEventBus } from './adapters/redis/RedisEventBus.js';
import { RedisMetrics } from './adapters/redis/RedisMetrics.js';
import { RedisPresenceStore } from './adapters/redis/RedisPresenceStore.js';
import { RedisRateLimiter } from './adapters/redis/RedisRateLimiter.js';

/**
 * Adapter selection — half of the composition root.
 *
 * WHY THIS IS THE ONLY PLACE THAT BRANCHES ON `PERSISTENCE`
 * ---------------------------------------------------------
 * Swapping LiveKit for mediasoup, or Redis for Valkey, must touch
 * /src/adapters and this file, and nothing else. That promise is only true if
 * no other module ever asks "which mode are we in?" — so this function is the
 * single branch, and everything downstream receives a `Ports` bundle it cannot
 * tell the origin of.
 *
 * `PERSISTENCE=memory` is not a database toggle. It replaces EVERY port with an
 * in-process fake, which is what lets `npm run dev:memory` boot the whole
 * product with no Docker at all.
 */

/** Ports with the `readonly` stripped, so the container alone can mutate them. */
type MutablePorts = { -readonly [K in keyof Ports]: Ports[K] };

export interface ContainerOptions {
  readonly config: Config;
  readonly logger: Logger;
}

export interface Container {
  readonly ports: Ports;

  /**
   * Supply the realtime transport once it exists.
   *
   * WHY A SETTER RATHER THAN A CONSTRUCTOR ARGUMENT: the Socket.io transport
   * needs an `http.Server` to attach to, and that server is created by the HTTP
   * edge — which itself needs the ports. The cycle is real, so it is broken
   * explicitly here rather than with a cast at the call site. This is the ONLY
   * late binding in the object graph, and keeping it to one named method means
   * it stays that way.
   */
  attachRealtime(transport: RealtimeTransport): void;

  /** Release connections in reverse order of acquisition. */
  shutdown(): Promise<void>;
}

export async function createContainer(options: ContainerOptions): Promise<Container> {
  return options.config.PERSISTENCE === 'memory'
    ? createMemoryContainer(options)
    : createProductionContainer(options);
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

function createMemoryContainer({ config, logger }: ContainerOptions): Container {
  const memory = createMemoryPorts({
    // Wall-clock time and crypto ids: `dev:memory` is a real developer
    // experience, not a test fixture. Only the TESTS want determinism.
    deterministic: false,
    logger,
    presenceTtlSeconds: config.PRESENCE_TTL_SECONDS,
    accessTokenTtlSeconds: config.ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTtlSeconds: config.REFRESH_TOKEN_TTL_SECONDS,
    // Config already refuses AUTH_ECHO_CODE in production, so this cannot
    // print a real user's login code.
    echoLoginCodes: config.AUTH_ECHO_CODE,
  });

  const ports: MutablePorts = { ...memory };

  logger.warn(
    { persistence: 'memory' },
    'running with IN-MEMORY adapters: all data is lost on restart',
  );

  return {
    ports,
    attachRealtime(transport) {
      ports.realtime = transport;
    },
    async shutdown() {
      await memory.bus.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Postgres + Redis
// ---------------------------------------------------------------------------

async function createProductionContainer({ config, logger }: ContainerOptions): Promise<Container> {
  const clock = systemClock;
  const ids = new CryptoIdGenerator();

  // -- Redis: three connections, because a subscriber cannot run commands ----
  const redis = createRedisClient({ url: config.REDIS_URL, logger }, 'commands');
  const redisPublisher = createRedisClient({ url: config.REDIS_URL, logger }, 'publisher');
  const redisSubscriber = createRedisClient({ url: config.REDIS_URL, logger }, 'subscriber');

  // -- Postgres --------------------------------------------------------------
  const db = createDatabase({
    connectionString: config.DATABASE_URL,
    poolMax: config.DATABASE_POOL_MAX,
    logger,
  });

  /**
   * PHASE BOUNDARY — read this before assuming a port is production-backed.
   *
   * Phases 0-2 are delivered. The ports belonging to LATER phases do not have
   * real adapters yet, so they fall back to the in-memory fakes. That is
   * deliberate and phase-appropriate (see docs/architecture.md §6), but it MUST
   * be loud: anything held by those ports disappears on restart.
   *
   * As each phase lands, its adapters replace the corresponding lines here and
   * the warning shrinks. When the list is empty, delete the fallback.
   */
  const pendingFallbacks = createMemoryPorts({
    deterministic: false,
    logger,
    presenceTtlSeconds: config.PRESENCE_TTL_SECONDS,
  });

  const ports: MutablePorts = {
    clock,
    ids,
    logger,

    // -- Phases 1-2: real ---------------------------------------------------
    users: new PostgresUserRepository(db),
    rooms: new PostgresRoomRepository(db),
    presence: new RedisPresenceStore(redis, clock, config.PRESENCE_TTL_SECONDS),
    messages: new CompositeMessageRepository(redis, db),
    tokens: new JwtTokenService(
      redis,
      clock,
      ids,
      {
        secret: config.JWT_SECRET,
        accessTtlSeconds: config.ACCESS_TOKEN_TTL_SECONDS,
        refreshTtlSeconds: config.REFRESH_TOKEN_TTL_SECONDS,
      },
      logger,
    ),
    challenges: new RedisAuthChallengeStore(redis),
    rateLimiter: new RedisRateLimiter(redis),
    metrics: new RedisMetrics(redis, clock, logger),
    bus: new RedisEventBus(redisPublisher, redisSubscriber, logger),

    // Console-logging sender until a real SMS/email provider is configured.
    // It reports success without sending, so a login code appears only in the
    // server log — usable on a private VPS, never acceptable for public signup.
    notifications: new MemoryNotificationSender(logger, config.AUTH_ECHO_CODE),

    // -- Awaiting their phase: in-memory ------------------------------------
    media: pendingFallbacks.media, // Phase 3
    reports: pendingFallbacks.reports, // Phase 4
    relationships: pendingFallbacks.relationships, // Phase 5
    surprises: pendingFallbacks.surprises, // Phase 5

    // Replaced by attachRealtime once the socket server exists.
    realtime: pendingFallbacks.realtime,
  };

  logger.warn(
    {
      inMemoryPorts: ['media', 'reports', 'relationships', 'surprises'],
    },
    'some ports are still in-memory pending their build phase: that data is lost on restart',
  );

  // Fail at boot rather than on the first user's request. A database that is
  // unreachable at startup is almost always a misconfiguration, and finding out
  // now beats finding out from a 500.
  if (!(await db.ping())) {
    throw new Error(
      `Cannot reach Postgres at the configured DATABASE_URL. Is docker compose up? Have you run npm run migrate?`,
    );
  }

  logger.info({ persistence: 'postgres' }, 'connected to postgres and redis');

  return {
    ports,
    attachRealtime(transport) {
      ports.realtime = transport;
    },
    async shutdown() {
      // Reverse order of acquisition: stop listening, then close the pools.
      await ports.bus.close().catch(() => undefined);
      await Promise.allSettled([
        redis.quit(),
        redisPublisher.quit(),
        redisSubscriber.quit(),
        db.close(),
      ]);
    },
  };
}
