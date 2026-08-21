import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Config } from '../../config.js';
import type { Ports } from '../../domain/ports/index.js';
import type { UseCases } from '../../app/index.js';
import { buildErrorHandler } from './errorMapping.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerProfileRoutes } from './routes/profile.js';
import { registerRoomRoutes } from './routes/rooms.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerSafetyRoutes } from './routes/safety.js';
import formbody from '@fastify/formbody';

/**
 * ADAPTER: the HTTP edge.
 *
 * WHAT LIVES HERE AND WHAT DOES NOT
 * ---------------------------------
 * Here: Fastify setup, CORS, cookies, request ids, error mapping, and route
 * modules that parse a request, call ONE use case, and serialize the result.
 *
 * Not here: any business rule. If a route contains an `if` about permissions,
 * trust, or state, that `if` belongs in a use case where it can be unit-tested
 * and where the socket edge gets it too. The routes are intentionally boring.
 *
 * `ports` and `useCases` are handed in by the composition root rather than
 * imported, which is what lets the whole HTTP surface be exercised against
 * memory fakes with no real services running.
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
    // Correct behind Cloudflare: resolves the real client IP from
    // x-forwarded-for, which the rate limiters key on.
    trustProxy: true,
    // Bodies are small (a chat message, a report note). A low cap is a cheap
    // defence against memory-exhaustion attempts.
    bodyLimit: 64 * 1024,
  });

  /**
   * Treat an empty body on a JSON request as `{}` rather than a 400.
   *
   * Fastify's default parser rejects a zero-length body when the content-type
   * says JSON. That is defensible in the abstract and wrong in practice: a
   * client POSTing to an endpoint with no parameters (logout, or any future
   * action route) will usually still send `content-type: application/json`,
   * because that is what every HTTP library does by default.
   *
   * The result is an error message about content-types for a request that was
   * perfectly well-formed — which is exactly the failure the smoke test caught
   * on /auth/logout. Routes that genuinely require fields still reject `{}`,
   * because their zod schema does.
   */
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_request, body: string, done) => {
      if (body.length === 0) {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(body));
      } catch (error) {
        // Signal a 400 rather than a 500: malformed JSON is the caller's error.
        const failure = error as Error & { statusCode?: number };
        failure.statusCode = 400;
        done(failure, undefined);
      }
    },
  );

  await app.register(cors, {
    origin: config.corsOrigins as string[],
    // Credentials are required for the refresh-token cookie. Safe only because
    // the origin list is explicit — config refuses a wildcard in production.
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  // Signed cookies are not used: the refresh token is itself an unguessable
  // random value validated server-side, so a signature would add a second
  // secret to rotate for no additional guarantee.
  await app.register(cookie);

  // The admin review page is a plain HTML form, which posts urlencoded rather
  // than JSON. Registered narrowly for that one surface.
  await app.register(formbody);

  app.setErrorHandler(buildErrorHandler(ports.logger, ports.metrics));

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: { code: 'NOT_FOUND', message: `No route for ${request.method} ${request.url}` },
    });
  });

  await registerHealthRoutes(app, deps);
  await registerAuthRoutes(app, deps);
  await registerProfileRoutes(app, deps);
  await registerRoomRoutes(app, deps);
  await registerSafetyRoutes(app, deps);
  await registerAdminRoutes(app, deps);

  return app;
}
