import { createUseCases } from './app/index.js';
import { createHttpServer } from './adapters/http/server.js';
import { createLogger } from './adapters/observability/PinoLogger.js';
import { createSocketServer } from './adapters/socketio/server.js';
import { startPresenceReaper } from './adapters/socketio/presenceReaper.js';
import { loadConfig } from './config.js';
import { createContainer } from './container.js';

/**
 * THE COMPOSITION ROOT.
 *
 * This is the one file allowed to know about everything. It reads config,
 * builds adapters, injects them into use cases, hands those to the edges, and
 * wires up shutdown. Nothing else in the codebase constructs an adapter.
 *
 * The payoff is stated in architecture §2: swapping LiveKit for mediasoup, or
 * Redis for Valkey, requires changes ONLY in /src/adapters and here. If you
 * ever find yourself needing to change a use case to swap a vendor, the port
 * was wrong — fix the port, not the use case.
 *
 * BOOT ORDER, and why it is this order:
 *   1. config      — fail before anything else is allocated
 *   2. logger      — so every later step is observable
 *   3. ports       — adapters, minus the socket transport
 *   4. use cases   — pure wiring over ports
 *   5. HTTP server — needs use cases
 *   6. socket server — needs the HTTP server to attach to
 *   7. transport injection — the ports bundle gets its realtime implementation
 *      last, because it cannot exist before step 6
 *   8. listen      — only now do we accept traffic
 */

async function main(): Promise<void> {
  // 1. Config first. A missing variable should crash here, on line one of the
  //    deploy log, not silently disable something an hour later.
  const config = loadConfig();

  // 2. Logger.
  const logger = createLogger({
    level: config.LOG_LEVEL,
    pretty: config.LOG_PRETTY && !config.isProduction,
    name: 'loverlink-api',
  });

  logger.info(
    {
      env: config.NODE_ENV,
      persistence: config.PERSISTENCE,
      realtimeInProcess: config.REALTIME_IN_PROCESS,
    },
    'starting Loverlink server',
  );

  // 3. Adapters.
  const container = await createContainer({ config, logger });
  const { ports } = container;

  // 4. Use cases.
  const useCases = createUseCases();

  // 5. HTTP edge.
  const app = await createHttpServer({ config, ports, useCases });

  // 6 & 7. Realtime edge.
  //
  // Mounted on the API's HTTP server when REALTIME_IN_PROCESS is true. The
  // module boundary exists regardless, so splitting this into its own process
  // (src/realtime.ts) is a config change rather than a refactor — see
  // architecture §3.
  let closeRealtime: (() => Promise<void>) | null = null;
  let stopReaper: (() => void) | null = null;

  if (config.REALTIME_IN_PROCESS) {
    const realtime = createSocketServer(app.server, { config, ports, useCases });

    // The ports bundle is built before the socket server exists, so its
    // `realtime` slot is filled here. This is the one late binding in the graph
    // and it is why `Ports.realtime` is not readonly-assigned at construction.
    container.attachRealtime(realtime.transport);

    // Ghost cleanup. Phones lock and tunnels die without sending `room:leave`;
    // without this, rooms slowly fill with people who are not there.
    stopReaper = startPresenceReaper({
      ports,
      intervalSeconds: config.PRESENCE_REAP_INTERVAL_SECONDS,
    });

    closeRealtime = realtime.close;
    logger.info({ mode: 'in-process' }, 'realtime server attached');
  } else {
    logger.info(
      { mode: 'separate-process', port: config.REALTIME_PORT },
      'realtime server NOT started here; run `tsx src/realtime.ts`',
    );
  }

  // 8. Accept traffic.
  await app.listen({ port: config.PORT, host: config.HOST });
  logger.info({ port: config.PORT, host: config.HOST }, 'API listening');

  // --- graceful shutdown ---------------------------------------------------
  //
  // Order is the reverse of boot: stop accepting new work, then close
  // connections, then release adapters. Draining in the wrong order produces
  // requests that fail mid-flight because their database went away first.
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    const deadline = setTimeout(() => {
      logger.error({}, 'graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, 10_000);
    // Do not let the timer itself hold the process open once we finish cleanly.
    deadline.unref();

    try {
      stopReaper?.();
      if (closeRealtime !== null) await closeRealtime();
      await app.close();
      await container.shutdown();
      logger.info({}, 'shutdown complete');
      clearTimeout(deadline);
      process.exit(0);
    } catch (error) {
      logger.error({ err: String(error) }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // An unhandled rejection means some promise chain is broken. Crashing is
  // correct: a process in an unknown state should be replaced, not trusted.
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason: String(reason) }, 'unhandled promise rejection');
    void shutdown('unhandledRejection');
  });
}

main().catch((error: unknown) => {
  // Config errors land here, before the logger exists. Plain stderr on purpose:
  // this must be readable even when nothing else has been initialised.
  process.stderr.write(
    `\nFailed to start:\n${error instanceof Error ? error.message : String(error)}\n\n`,
  );
  process.exit(1);
});
