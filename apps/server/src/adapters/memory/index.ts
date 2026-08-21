import type { Logger } from '../../domain/ports/Logger.js';
import type { Ports } from '../../domain/ports/index.js';
import { nullLogger } from '../../domain/ports/Logger.js';
import { MemoryAuthChallengeStore } from './MemoryAuthChallengeStore.js';
import { MemoryClock } from './MemoryClock.js';
import { MemoryEventBus } from './MemoryEventBus.js';
import { CryptoIdGenerator, MemoryIdGenerator } from './MemoryIdGenerator.js';
import { MemoryMediaRoomProvider } from './MemoryMediaRoomProvider.js';
import { MemoryMessageRepository } from './MemoryMessageRepository.js';
import { MemoryMetrics } from './MemoryMetrics.js';
import { MemoryNotificationSender } from './MemoryNotificationSender.js';
import { MemoryPresenceStore } from './MemoryPresenceStore.js';
import { MemoryRateLimiter } from './MemoryRateLimiter.js';
import { MemoryRealtimeTransport } from './MemoryRealtimeTransport.js';
import { MemoryRelationshipRepository } from './MemoryRelationshipRepository.js';
import { MemoryReportRepository } from './MemoryReportRepository.js';
import { MemoryRoomRepository } from './MemoryRoomRepository.js';
import { MemorySurpriseRepository } from './MemorySurpriseRepository.js';
import { MemoryTokenService } from './MemoryTokenService.js';
import { MemoryUserRepository } from './MemoryUserRepository.js';

export * from './MemoryAuthChallengeStore.js';
export * from './MemoryClock.js';
export * from './MemoryEventBus.js';
export * from './MemoryIdGenerator.js';
export * from './MemoryMediaRoomProvider.js';
export * from './MemoryMessageRepository.js';
export * from './MemoryMetrics.js';
export * from './MemoryNotificationSender.js';
export * from './MemoryPresenceStore.js';
export * from './MemoryRateLimiter.js';
export * from './MemoryRealtimeTransport.js';
export * from './MemoryRelationshipRepository.js';
export * from './MemoryReportRepository.js';
export * from './MemoryRoomRepository.js';
export * from './MemorySurpriseRepository.js';
export * from './MemoryTokenService.js';
export * from './MemoryUserRepository.js';

/**
 * A complete, working Loverlink backend with no external services.
 *
 * WHY THIS FUNCTION IS THE PROOF OF THE ARCHITECTURE
 * --------------------------------------------------
 * If every port has an in-memory implementation and the whole application runs
 * on them, then the boundaries are real — not aspirational. The moment someone
 * imports `ioredis` into a use case, this stops compiling or stops working, and
 * they find out in seconds rather than at the next vendor migration.
 *
 * It serves two audiences with slightly different needs, hence the options:
 *
 *  - TESTS want determinism: a controllable clock, sequential ids, a recording
 *    transport. That is the default.
 *  - `npm run dev:memory` wants a REAL developer experience: wall-clock time,
 *    unguessable codes, and login codes echoed to the terminal. Pass
 *    `{ deterministic: false }`.
 */
export interface MemoryPortsOptions {
  /**
   * True (default) for tests: controllable clock, sequential ids.
   * False for `dev:memory`: system clock, crypto ids.
   */
  readonly deterministic?: boolean;
  readonly logger?: Logger;
  readonly presenceTtlSeconds?: number;
  readonly accessTokenTtlSeconds?: number;
  readonly refreshTokenTtlSeconds?: number;
  /** Print login codes to the log. Never enabled in production; config enforces it. */
  readonly echoLoginCodes?: boolean;
  /** Injected when the real socket transport should be used instead of the recorder. */
  readonly realtime?: Ports['realtime'];
}

/**
 * The concrete types are exposed alongside the `Ports` view so tests can reach
 * the fakes' extra helpers (`advanceMs`, `emissionsTo`, `lastCodeFor`) without
 * casting, while application code sees only the interfaces.
 */
export interface MemoryPorts extends Ports {
  readonly clock: MemoryClock;
  readonly users: MemoryUserRepository;
  readonly rooms: MemoryRoomRepository;
  readonly surprises: MemorySurpriseRepository;
  readonly reports: MemoryReportRepository;
  readonly relationships: MemoryRelationshipRepository;
  readonly messages: MemoryMessageRepository;
  readonly presence: MemoryPresenceStore;
  readonly bus: MemoryEventBus;
  readonly rateLimiter: MemoryRateLimiter;
  readonly media: MemoryMediaRoomProvider;
  readonly tokens: MemoryTokenService;
  readonly challenges: MemoryAuthChallengeStore;
  readonly notifications: MemoryNotificationSender;
  readonly metrics: MemoryMetrics;
  /**
   * The recording transport, always available even when a real socket
   * transport was injected — so a test can assert on what the server tried to
   * say without standing up a socket server.
   */
  readonly recorder: MemoryRealtimeTransport;
  /** Reset every store between tests without rebuilding the graph. */
  reset(): void;
}

export function createMemoryPorts(options: MemoryPortsOptions = {}): MemoryPorts {
  const {
    deterministic = true,
    logger = nullLogger,
    presenceTtlSeconds = 45,
    accessTokenTtlSeconds = 900,
    refreshTokenTtlSeconds = 60 * 60 * 24 * 30,
    echoLoginCodes = false,
    realtime,
  } = options;

  const clock = new MemoryClock(deterministic ? undefined : new Date());

  // In non-deterministic mode the clock must track wall time, or `dev:memory`
  // would freeze at boot and every TTL in the system would stop expiring.
  if (!deterministic) {
    const started = Date.now();
    const base = clock.nowMs();
    Object.defineProperty(clock, 'nowMs', {
      value: () => base + (Date.now() - started),
      writable: false,
    });
    Object.defineProperty(clock, 'now', {
      value: () => new Date(base + (Date.now() - started)),
      writable: false,
    });
  }

  const ids = deterministic ? new MemoryIdGenerator() : new CryptoIdGenerator();
  const metrics = new MemoryMetrics(clock);
  const nowFn = () => clock.now();

  const users = new MemoryUserRepository();
  const rooms = new MemoryRoomRepository();
  const surprises = new MemorySurpriseRepository(nowFn);
  const reports = new MemoryReportRepository();
  const relationships = new MemoryRelationshipRepository(nowFn);
  const messages = new MemoryMessageRepository();

  const presence = new MemoryPresenceStore(clock, presenceTtlSeconds);
  const bus = new MemoryEventBus();
  const recordingTransport = new MemoryRealtimeTransport();
  const rateLimiter = new MemoryRateLimiter(clock);
  const media = new MemoryMediaRoomProvider(clock);

  const tokens = new MemoryTokenService(clock, ids, accessTokenTtlSeconds, refreshTokenTtlSeconds);
  const challenges = new MemoryAuthChallengeStore(clock);
  const notifications = new MemoryNotificationSender(logger, echoLoginCodes);

  return {
    clock,
    ids,
    logger,
    metrics,
    users,
    rooms,
    surprises,
    reports,
    relationships,
    messages,
    presence,
    bus,
    realtime: realtime ?? recordingTransport,
    recorder: recordingTransport,
    rateLimiter,
    media,
    tokens,
    challenges,
    notifications,
    reset() {
      users.clear();
      rooms.clear();
      surprises.clear();
      reports.clear();
      relationships.clear();
      messages.clear();
      presence.clear();
      bus.clear();
      recordingTransport.clear();
      rateLimiter.clear();
      media.clear();
      tokens.clear();
      challenges.clear();
      notifications.clear();
      metrics.clear();
    },
  };
}
