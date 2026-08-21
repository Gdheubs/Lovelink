import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { HttpServerDeps } from '../server.js';
import { actorOf, requireAuth } from '../authGuard.js';
import { REPORT_CATEGORIES } from '../../../domain/entities/Report.js';
import { asRoomId, asUserId } from '../../../domain/values/ids.js';

/**
 * Reporting and blocking over HTTP.
 *
 * WHY THESE ARE REST AND NOT ONLY SOCKET EVENTS
 * ---------------------------------------------
 * `report:submit` exists as a socket event because the common case is
 * reporting someone in the room you are both in, where a socket is already
 * open. But reporting is NOT only an in-room action — a profile, a DM, or
 * something remembered an hour later all need it, and none of those has a
 * socket to hand.
 *
 * Requiring a socket to report would mean the safety mechanism is unavailable
 * in exactly the situations where someone has already left the room to get
 * away from the person they want to report.
 *
 * Both edges call the SAME use case, so the rules — one open report per
 * target, urgent exemption, rate limits, note validation — cannot diverge
 * between them.
 */

const reportBody = z.object({
  targetId: z.string().uuid(),
  roomId: z.string().uuid().optional(),
  category: z.enum(REPORT_CATEGORIES as unknown as [string, ...string[]]),
  note: z.string().max(4000).optional(),
});

const userParam = z.object({ id: z.string().uuid() });

export async function registerSafetyRoutes(
  app: FastifyInstance,
  deps: HttpServerDeps,
): Promise<void> {
  const { useCases } = deps;

  /**
   * POST /reports
   *
   * The response deliberately carries almost nothing: an id, so the client can
   * say "we got it", and nothing at all about the target. Returning whether
   * this person has been reported before would turn the endpoint into a way to
   * probe someone else's standing.
   */
  app.post('/reports', { preHandler: requireAuth(useCases) }, async (request, reply) => {
    const body = reportBody.parse(request.body);
    const actor = actorOf(request);

    const report = await useCases.submitReport.execute(actor.user, {
      targetId: asUserId(body.targetId),
      roomId: body.roomId === undefined ? null : asRoomId(body.roomId),
      category: body.category,
      ...(body.note === undefined ? {} : { note: body.note }),
    });

    return reply.status(201).send({
      id: report.id,
      // Reassurance, and nothing else.
      message: 'Thank you. Our team will look at this.',
    });
  });

  /**
   * PUT /users/:id/block
   *
   * Idempotent by design — blocking someone already blocked succeeds quietly.
   * A double-tap must not look like a failure at the moment someone wants
   * reassurance that it worked.
   */
  app.put('/users/:id/block', { preHandler: requireAuth(useCases) }, async (request, reply) => {
    const params = userParam.parse(request.params);
    const actor = actorOf(request);

    await useCases.blockUser.execute(actor.user, asUserId(params.id));

    // 204: there is nothing to say. In particular the response is identical
    // whether or not they were already blocked, and the blocked party is
    // never told anything at all.
    return reply.status(204).send();
  });

  app.delete('/users/:id/block', { preHandler: requireAuth(useCases) }, async (request, reply) => {
    const params = userParam.parse(request.params);
    const actor = actorOf(request);

    await useCases.unblockUser.execute(actor.user, asUserId(params.id));
    return reply.status(204).send();
  });

  /** The people this user has blocked, so the client can render a manage list. */
  app.get('/me/blocked', { preHandler: requireAuth(useCases) }, async (request, reply) => {
    const actor = actorOf(request);
    const blockedIds = await deps.ports.relationships.listBlockedIds(actor.user.id);

    const users = await deps.ports.users.findManyByIds(blockedIds);
    return reply.send({
      blocked: users.map((user) => ({
        id: user.id,
        displayName: user.displayName,
        avatarSeed: user.avatarSeed,
      })),
    });
  });

  /**
   * The grievance contact point.
   *
   * Required by the safety baseline and deliberately a plain, unauthenticated
   * page: someone who has been banned cannot log in, and they are precisely
   * the person most likely to need it.
   */
  app.get('/grievance', async (_request, reply) => {
    return reply.type('text/html; charset=utf-8').send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Loverlink — contact us</title>
<style>
  body { background:#100a18; color:#f4eefb; font:16px/1.6 system-ui,sans-serif;
         margin:0; padding:2rem; display:flex; justify-content:center; }
  main { max-width:34rem; }
  h1 { color:#d98cae; font-size:1.2rem; letter-spacing:.1em; text-transform:uppercase; }
  a { color:#d98cae; }
  .muted { color:#a996bd; }
</style>
</head>
<body>
  <main>
    <h1>Contact us</h1>
    <p>If your account has been suspended and you believe that was a mistake, or
       you want to raise a concern about how a report was handled, write to us.</p>
    <p><a href="mailto:safety@loverlink.online">safety@loverlink.online</a></p>
    <p class="muted">Include the phone number or email your account uses. We do
       not need anything else, and please do not send passwords or login codes.</p>
    <p class="muted">We aim to respond within a few days. Reports involving the
       safety of a minor are looked at first, always.</p>
  </main>
</body>
</html>`);
  });
}
