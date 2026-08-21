import { createServer } from 'node:http';
import { createUseCases } from './app/index.js';
import { createLogger } from './adapters/observability/PinoLogger.js';
import { createSocketServer } from './adapters/socketio/server.js';
import { startPresenceReaper } from './adapters/socketio/presenceReaper.js';
import { loadConfig } from './config.js';
import { createContainer } from './container.js';

/**
 * The realtime process — its own entry point from day one.
 *
 * WHY THIS FILE EXISTS EVEN THOUGH IT USUALLY DOES NOT RUN
 * --------------------------------------------------------
 * At MVP the socket server is mounted on the API's HTTP server
 * (REALTIME_IN_PROCESS=true) because one process is simpler to operate. But
 * realtime and HTTP scale on completely different curves: sockets are bounded
 * by concurrent connections and memory, HTTP by request throughput. Sooner or
 * later they need separate machines.
 *
 * Architecture §3 requires that split to be a CONFIG CHANGE rather than a
 * refactor, and the only way to guarantee that is for the separate entry point
 * to exist — and to be kept compiling — from the start. A boundary you have
 * never crossed is a boundary you do not have.
 *
 * When run standalone, the two processes share state through the very ports
 * that make the split possible: Redis for presence and pub/sub, Postgres for
 * durable data, and the Socket.io Redis adapter so a broadcast on one node
 * reaches clients on the other.
 */
async function main(): Promise<void> {
  const config = loadConfig();

  const logger = createLogger({
    level: config.LOG_LEVEL,
    pretty: config.LOG_PRETTY && !config.isProduction,
    name: 'loverlink-realtime',
  });

  if (config.REALTIME_IN_PROCESS) {
    logger.warn(
      {},
      'REALTIME_IN_PROCESS is true, so the API already hosts sockets. ' +
        'Set it to false before running this process, or clients will connect to two servers.',
    );
  }

  if (config.PERSISTENCE === 'memory') {
    // Two processes with two separate in-memory stores share nothing, so a user
    // on the API would be invisible to the realtime node. Refusing is kinder
    // than the hours of confusion that combination produces.
    throw new Error(
      'PERSISTENCE=memory cannot be used with a standalone realtime process: ' +
        'the two processes would not share presence or data. Use PERSISTENCE=postgres.',
    );
  }

  const container = await createContainer({ config, logger });
  const { ports } = container;
  const useCases = createUseCases(ports, { echoLoginCode: config.AUTH_ECHO_CODE });

  // A bare HTTP server, existing only to carry the websocket upgrade and to
  // answer /healthz — this process has no REST surface of its own.
  const httpServer = createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'realtime' }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Realtime process only.' } }));
  });

  const realtime = createSocketServer(httpServer, { config, ports, useCases });
  container.attachRealtime(realtime.transport);

  const stopReaper = startPresenceReaper({
    ports,
    useCases,
    intervalSeconds: config.PRESENCE_REAP_INTERVAL_SECONDS,
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(config.REALTIME_PORT, config.HOST, resolve);
  });
  logger.info({ port: config.REALTIME_PORT }, 'realtime process listening');

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down realtime process');
    try {
      stopReaper();
      await realtime.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await container.shutdown();
      process.exit(0);
    } catch (error) {
      logger.error({ err: String(error) }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  process.stderr.write(
    `\nFailed to start realtime process:\n${error instanceof Error ? error.message : String(error)}\n\n`,
  );
  process.exit(1);
});
