import type { Config } from './config.js';
import type { Logger } from './domain/ports/Logger.js';
import type { Ports } from './domain/ports/index.js';
import type { RealtimeTransport } from './domain/ports/RealtimeTransport.js';
import { createMemoryPorts } from './adapters/memory/index.js';

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
 * product — signup, rooms, chat, surprises — with no Docker at all.
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
  const { config, logger } = options;

  if (config.PERSISTENCE === 'memory') {
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

  // Phase 1 wires the Postgres and Redis adapters in here. Until then, failing
  // loudly beats silently falling back to memory and losing a user's data.
  throw new Error(
    `PERSISTENCE=${config.PERSISTENCE} is not wired up yet. Use PERSISTENCE=memory (npm run dev:memory).`,
  );
}
