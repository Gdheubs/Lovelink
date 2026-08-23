import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { HttpServerDeps } from '../server.js';
import { actorOf, requireAuth } from '../authGuard.js';

/**
 * Push subscription management.
 *
 * WHY THE PUBLIC KEY IS FETCHED RATHER THAN BAKED INTO THE CLIENT BUNDLE
 * ----------------------------------------------------------------------
 * Two reasons, and the second is the one that matters:
 *
 *   1. Rotating the VAPID key becomes a server deploy instead of a coordinated
 *      server-and-client deploy.
 *   2. A deployment with push switched off returns `null`, and the client
 *      simply never offers to subscribe. Baking the key in would mean a build
 *      that promises notifications a server cannot send — a permission prompt
 *      answered "allow", followed by silence forever.
 */

const subscriptionBody = z.object({
  // Bounded here; the use case checks it is an https URL that does not point
  // anywhere internal, which is the check that actually matters.
  endpoint: z.string().min(1).max(1024),
  keys: z.object({
    p256dh: z.string().min(1).max(256),
    auth: z.string().min(1).max(256),
  }),
});

const removeBody = z.object({
  endpoint: z.string().min(1).max(1024),
});

export async function registerPushRoutes(
  app: FastifyInstance,
  deps: HttpServerDeps,
): Promise<void> {
  const { ports, useCases } = deps;

  /**
   * GET /push/key
   *
   * Unauthenticated on purpose: it is a PUBLIC key whose entire job is to be
   * published, and requiring a session would mean the sign-in page cannot tell
   * whether to mention notifications at all.
   */
  app.get('/push/key', async (_request, reply) => {
    return reply.send({ publicKey: ports.push.publicKey() });
  });

  /**
   * PUT /push/subscriptions — register this device.
   *
   * PUT rather than POST because it is idempotent on the endpoint: a client
   * that re-registers on every load, which is the correct behaviour given that
   * browsers rotate subscriptions, must not accumulate rows.
   */
  app.put('/push/subscriptions', { preHandler: requireAuth(useCases) }, async (request, reply) => {
    const body = subscriptionBody.parse(request.body);
    const actor = actorOf(request);

    await useCases.registerPushSubscription.execute(actor.user, {
      endpoint: body.endpoint,
      p256dh: body.keys.p256dh,
      auth: body.keys.auth,
    });

    return reply.status(204).send();
  });

  /**
   * DELETE /push/subscriptions — stop notifications for this device.
   *
   * Always 204, including when there was nothing to remove. Someone turning
   * notifications off needs it to have worked, and an error here would leave
   * them unsure whether their phone will buzz again.
   */
  app.delete(
    '/push/subscriptions',
    { preHandler: requireAuth(useCases) },
    async (request, reply) => {
      const body = removeBody.parse(request.body);
      const actor = actorOf(request);

      await useCases.removePushSubscription.execute(actor.user, body.endpoint);
      return reply.status(204).send();
    },
  );
}
