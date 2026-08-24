import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { HttpServerDeps } from '../server.js';
import { actorOf, requireAuth } from '../authGuard.js';

/**
 * The home screen, and tonight's intent.
 *
 * ONE REQUEST FOR THE WHOLE SCREEN, deliberately. The alternative — a call for
 * rooms, another for occupancy, another for the intent — means a screen that
 * assembles itself in stages on a slow connection, which is exactly the phone
 * this product is for. The server does the assembling because it is closer to
 * the data than the phone is.
 */

const intentBody = z.object({
  // The domain owns which values are real; this only bounds the string.
  intent: z.string().min(1).max(32),
});

export async function registerHomeRoutes(
  app: FastifyInstance,
  deps: HttpServerDeps,
): Promise<void> {
  const { useCases } = deps;

  app.get('/home', { preHandler: requireAuth(useCases) }, async (request, reply) => {
    const actor = actorOf(request);
    return reply.send(await useCases.getHome.execute(actor.user));
  });

  /**
   * PUT /me/intent — what you are here for tonight.
   *
   * PUT rather than POST: it replaces whatever was there, and saying it twice
   * is the same as saying it once. It also expires on its own, which is why
   * there is no "clear at end of session" for a client to forget.
   */
  app.put('/me/intent', { preHandler: requireAuth(useCases) }, async (request, reply) => {
    const body = intentBody.parse(request.body);
    const actor = actorOf(request);

    await useCases.setIntent.execute(actor.user, body.intent);
    return reply.status(204).send();
  });

  /** DELETE /me/intent — for someone who would rather not say. */
  app.delete('/me/intent', { preHandler: requireAuth(useCases) }, async (request, reply) => {
    const actor = actorOf(request);
    await useCases.clearIntent.execute(actor.user);
    return reply.status(204).send();
  });
}
