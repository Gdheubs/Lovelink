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

/**
 * An IANA zone name. Bounded before it reaches `Intl`, because an unbounded
 * string is a cheap way to make the server do expensive validation; the use
 * case checks the runtime actually recognises it.
 */
const timeZoneBody = z.object({ timeZone: z.string().min(1).max(64) });

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

  /**
   * GET /me/streak — the live view.
   *
   * Separate from `/me` because the client polls this cheaply after a room
   * join to update the number, and re-fetching the whole profile (including the
   * trust ledger) for a two-field answer is wasteful on a phone.
   */
  app.get('/me/streak', { preHandler: requireAuth(useCases) }, async (request, reply) => {
    const actor = actorOf(request);
    return reply.send(await useCases.getStreak.execute(actor.user));
  });

  /**
   * PUT /me/timezone — which day boundary this person's streak uses.
   *
   * The client sends `Intl.DateTimeFormat().resolvedOptions().timeZone` on
   * sign-in and whenever it changes. It is stored on the account rather than
   * read per-request so a socket join, a REST call and a background job all
   * agree about which day it is for this user.
   *
   * Changing it never rewrites history — see SetTimeZone.
   */
  app.put('/me/timezone', { preHandler: requireAuth(useCases) }, async (request, reply) => {
    const body = timeZoneBody.parse(request.body);
    const actor = actorOf(request);

    await useCases.setTimeZone.execute(actor.user, body.timeZone);
    return reply.status(204).send();
  });
}
