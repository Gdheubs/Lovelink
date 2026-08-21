import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { HttpServerDeps } from '../server.js';
import { actorOf, requireAuth } from '../authGuard.js';

/**
 * Profile routes.
 *
 * NOTE what is absent: there is no `GET /users/:id`. Browsing arbitrary
 * profiles is not a feature — you meet people in rooms, and the member list
 * carries the `PublicProfile` you are allowed to see. An endpoint that returns
 * a profile by id would be an enumeration surface over the whole user base, and
 * the product has no screen that needs one.
 */

const updateBody = z.object({
  displayName: z.string().min(1).max(64).optional(),
  regenerateAvatar: z.boolean().optional(),
});

export async function registerProfileRoutes(
  app: FastifyInstance,
  deps: HttpServerDeps,
): Promise<void> {
  const { useCases } = deps;

  /** GET /me — the caller's own profile, including their trust ledger. */
  app.get('/me', { preHandler: requireAuth(useCases) }, async (request, reply) => {
    const actor = actorOf(request);
    const profile = await useCases.getMyProfile.execute(actor.user);
    return reply.send(profile);
  });

  /** PATCH /me — display name and avatar only; see UpdateMyProfile for why. */
  app.patch('/me', { preHandler: requireAuth(useCases) }, async (request, reply) => {
    const body = updateBody.parse(request.body);
    const actor = actorOf(request);

    const profile = await useCases.updateMyProfile.execute(actor.user, {
      ...(body.displayName === undefined ? {} : { displayName: body.displayName }),
      ...(body.regenerateAvatar === undefined ? {} : { regenerateAvatar: body.regenerateAvatar }),
    });

    return reply.send(profile);
  });
}
