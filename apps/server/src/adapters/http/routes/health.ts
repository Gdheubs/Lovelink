import type { FastifyInstance } from 'fastify';
import type { HttpServerDeps } from '../server.js';

/**
 * Health and readiness.
 *
 * THE DISTINCTION MATTERS
 * -----------------------
 *   /healthz  — "is this process alive?" Never touches a dependency. A load
 *               balancer uses it to decide whether to restart the container,
 *               and if it checked Postgres, a database blip would trigger a
 *               restart storm across every instance at once.
 *
 *   /readyz   — "can this process serve traffic?" Checks the dependencies. A
 *               load balancer uses it to decide whether to send requests here.
 *               Failing readiness sheds traffic; it does not kill the process.
 *
 * Conflating the two is one of the most common ways a healthy system takes
 * itself down during a partial outage.
 */
export async function registerHealthRoutes(
  app: FastifyInstance,
  deps: HttpServerDeps,
): Promise<void> {
  const startedAtMs = Date.now();

  app.get('/healthz', async () => ({
    status: 'ok',
    service: 'api',
    persistence: deps.config.PERSISTENCE,
    uptimeSeconds: Math.floor((Date.now() - startedAtMs) / 1000),
  }));

  app.get('/readyz', async (_request, reply) => {
    const checks: Record<string, 'ok' | 'fail'> = {};

    // Each dependency is probed through its PORT, not its client library — so
    // this route works unchanged in memory mode and needs no edit when Redis is
    // swapped for Valkey.
    try {
      await deps.ports.rateLimiter.check('healthcheck:probe', 1_000_000, 60);
      checks.cache = 'ok';
    } catch {
      checks.cache = 'fail';
    }

    try {
      await deps.ports.reports.countByStatus('open');
      checks.database = 'ok';
    } catch {
      checks.database = 'fail';
    }

    const ready = Object.values(checks).every((v) => v === 'ok');
    return reply.status(ready ? 200 : 503).send({ status: ready ? 'ready' : 'degraded', checks });
  });
}
