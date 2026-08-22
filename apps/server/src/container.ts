import type { Config } from './config.js';
import type { Logger } from './domain/ports/Logger.js';
import type { Ports } from './domain/ports/index.js';
import type { RealtimeTransport } from './domain/ports/RealtimeTransport.js';
import { systemClock } from './domain/ports/Clock.js';
import { createMemoryPorts } from './adapters/memory/index.js';
import { CryptoIdGenerator } from './adapters/memory/MemoryIdGenerator.js';
import { MemoryNotificationSender } from './adapters/memory/MemoryNotificationSender.js';
import { JwtTokenService } from './adapters/auth/JwtTokenService.js';
import { LiveKitMediaRoomProvider } from './adapters/livekit/LiveKitMediaRoomProvider.js';
import { createDatabase } from './adapters/postgres/db.js';
import { PostgresRelationshipRepository } from './adapters/postgres/PostgresRelationshipRepository.js';
import { PostgresReportRepository } from './adapters/postgres/PostgresReportRepository.js';
import { PostgresRoomRepository } from './adapters/postgres/PostgresRoomRepository.js';
import { PostgresSurpriseRepository } from './adapters/postgres/PostgresSurpriseRepository.js';
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
   * EVERY DOMAIN PORT NOW HAS A REAL ADAPTER.
   *
   * This used to be a phase-boundary escape hatch: ports whose adapters had not
   * been built yet fell back to the in-memory fakes, with a loud warning that
   * their data vanished on restart. As of Phase 5 that list is empty —
   * `surprises` was the last one, and it is now PostgresSurpriseRepository.
   *
   * What remains is ONE placeholder, and it is a different kind of thing: the
   * realtime transport cannot exist until the socket server does, and the
   * socket server needs the use cases, which need the ports. `attachRealtime`
   * closes that cycle a few lines after boot. The fake stands in for the gap
   * between constructing the container and attaching the transport — measured
   * in milliseconds, before anything can be listening.
   *
   * Do NOT reintroduce a fallback here for a port whose adapter is merely
   * unfinished. A fake in production wiring is data loss that reports success.
   */
  const realtimePlaceholder = createMemoryPorts({
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
    reports: new PostgresReportRepository(db),
    relationships: new PostgresRelationshipRepository(db, clock),
    media: new LiveKitMediaRoomProvider(
      {
        url: config.LIVEKIT_URL,
        apiKey: config.LIVEKIT_API_KEY,
        apiSecret: config.LIVEKIT_API_SECRET,
        tokenTtlSeconds: config.LIVEKIT_TOKEN_TTL_SECONDS,
      },
      clock,
      logger,
    ),
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

    surprises: new PostgresSurpriseRepository(db),

    // Replaced by attachRealtime once the socket server exists. See the note
    // above — this is a construction-order placeholder, not a missing adapter.
    realtime: realtimePlaceholder.realtime,
  };

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
