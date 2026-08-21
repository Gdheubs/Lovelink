import cors from '@fastify/cors';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Config } from '../../config.js';
import type { Ports } from '../../domain/ports/index.js';
import type { UseCases } from '../../app/index.js';
import { buildErrorHandler } from './errorMapping.js';
import { registerHealthRoutes } from './routes/health.js';

/**
 * ADAPTER: the HTTP edge.
 *
 * WHAT LIVES HERE AND WHAT DOES NOT
 * ---------------------------------
 * Here: Fastify setup, CORS, request ids, error mapping, and route modules that
 * parse a request, call ONE use case, and serialize the result.
 *
 * Not here: any business rule. If a route contains an `if` about permissions,
 * trust, or state, that `if` belongs in a use case where it can be unit-tested
 * and where the socket edge gets it too. The routes are intentionally boring.
 *
 * `ports` and `useCases` are handed in by the composition root rather than
 * imported, which is what lets the whole HTTP surface be tested against memory
 * fakes with no server running.
 */
export interface HttpServerDeps {
  readonly config: Config;
  readonly ports: Ports;
  readonly useCases: UseCases;
}

export async function createHttpServer(deps: HttpServerDeps): Promise<FastifyInstance> {
  const { config, ports } = deps;

  // Fastify has its own pino instance; we hand it ours so that API logs and
  // use-case logs land in the same stream, with the same shape and the same
  // redaction rules. The `raw()` escape hatch is why PinoLogger exposes one —
  // it is the single place the Logger port's implementation detail is needed.
  const fastifyLogger = (ports.logger as { raw?: () => FastifyBaseLogger }).raw?.();

  const app = Fastify({
    loggerInstance: fastifyLogger,
    // Correlation id on every request, echoed in 500 responses so a user can
    // quote it and we can find the exact line.
    genReqId: () => ports.ids.uuid(),
    trustProxy: true,
    // Bodies are small (a chat message, a report note). A low cap is a cheap
    // defence against memory-exhaustion attempts.
    bodyLimit: 64 * 1024,
  });

  await app.register(cors, {
    origin: config.corsOrigins as string[],
    // Credentials are required for the refresh-token cookie. Combined with an
    // explicit origin allowlist (config refuses a wildcard in production).
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  app.setErrorHandler(buildErrorHandler(ports.logger, ports.metrics));

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: { code: 'NOT_FOUND', message: `No route for ${request.method} ${request.url}` },
    });
  });

  await registerHealthRoutes(app, deps);

  return app;
}
