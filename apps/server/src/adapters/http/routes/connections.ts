import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { HttpServerDeps } from '../server.js';
import { actorOf, requireAuth } from '../authGuard.js';
import { asMessageId, asUserId } from '../../../domain/values/ids.js';

/**
 * Connections — the DM ladder over HTTP.
 *
 * WHY BOTH EDGES EXIST FOR THE SAME ACTIONS
 * -----------------------------------------
 * The socket edge carries the LIVE half: a request arriving while you are
 * online, a message appearing as it is typed, a call ringing. This edge carries
 * the half that is not live — opening the app and reading what happened while
 * you were away, scrolling back through a thread, answering a request from
 * yesterday.
 *
 * Neither is a fallback for the other, and both call the same use cases, so the
 * ladder rules cannot differ depending on which one a client happened to use.
 *
 * WHAT IS NOT HERE: `call:invite` and `call:accept`.
 * A call is inherently live — it requires both parties present, and the
 * response is a media credential that belongs to one specific device. Offering
 * them over REST would mean minting a microphone credential for a caller with
 * no open connection to ring, which is a token issued into nothing.
 */

const userParam = z.object({ id: z.string().uuid() });

const messageBody = z.object({
  text: z.string().min(1).max(2000),
});

const threadQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  before: z.string().uuid().optional(),
});

export async function registerConnectionRoutes(
  app: FastifyInstance,
  deps: HttpServerDeps,
): Promise<void> {
  const { useCases } = deps;

  /**
   * GET /me/connections — everyone you have met, and how far each has gone.
   *
   * Incoming requests come back in their own list rather than mixed in: they
   * demand a decision, and burying them among open threads either hides them or
   * turns the whole screen into a nag.
   */
  app.get('/me/connections', { preHandler: requireAuth(useCases) }, async (request, reply) => {
    const actor = actorOf(request);
    const view = await useCases.listConnections.execute(actor.user);
    return reply.status(200).send(view);
  });

  /**
   * POST /users/:id/dm-request
   *
   * 202, not 201: nothing has been created that the caller can see, and
   * nothing has been agreed. The request has been accepted for delivery, and
   * whether it is ever answered is not information the requester is entitled
   * to. See ListConnections for why outgoing requests are invisible.
   */
  app.post(
    '/users/:id/dm-request',
    { preHandler: requireAuth(useCases) },
    async (request, reply) => {
      const params = userParam.parse(request.params);
      const actor = actorOf(request);

      await useCases.requestDm.execute(actor.user, asUserId(params.id));

      return reply.status(202).send({ message: 'Request sent.' });
    },
  );

  /**
   * POST /users/:id/dm-accept — open the conversation.
   *
   * Only the person who was ASKED can do this; `requestedBy` records the
   * direction and the use case refuses anything else. Without that check a
   * requester could accept on the other person's behalf and open their own
   * channel.
   */
  app.post('/users/:id/dm-accept', { preHandler: requireAuth(useCases) }, async (request, reply) => {
    const params = userParam.parse(request.params);
    const actor = actorOf(request);

    await useCases.acceptDm.execute(actor.user, asUserId(params.id));

    return reply.status(200).send({ message: 'You can now message each other.' });
  });

  /**
   * POST /users/:id/dm-decline
   *
   * Always 200, whether or not there was a request to decline. The requester
   * is never told, and neither is a caller probing for whether one is pending —
   * a decline that reported "there was nothing to decline" would leak exactly
   * that.
   */
  app.post(
    '/users/:id/dm-decline',
    { preHandler: requireAuth(useCases) },
    async (request, reply) => {
      const params = userParam.parse(request.params);
      const actor = actorOf(request);

      await useCases.declineDm.execute(actor.user, asUserId(params.id));

      return reply.status(200).send({ message: 'Done.' });
    },
  );

  /**
   * GET /users/:id/messages — the thread, newest first.
   *
   * Cursor-paginated on message id rather than offset: a thread someone is
   * actively adding to would make offsets skip and repeat messages as the page
   * scrolls.
   */
  app.get('/users/:id/messages', { preHandler: requireAuth(useCases) }, async (request, reply) => {
    const params = userParam.parse(request.params);
    const query = threadQuery.parse(request.query);
    const actor = actorOf(request);

    const page = await useCases.readDmThread.execute(actor.user, {
      withUserId: asUserId(params.id),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.before === undefined ? {} : { before: asMessageId(query.before) }),
    });

    return reply.status(200).send(page);
  });

  /**
   * POST /users/:id/messages — send one.
   *
   * Delivery to both parties happens inside the use case through
   * RealtimeTransport, so a message sent over REST still appears instantly in
   * the recipient's open socket — and in the sender's other tabs.
   */
  app.post('/users/:id/messages', { preHandler: requireAuth(useCases) }, async (request, reply) => {
    const params = userParam.parse(request.params);
    const body = messageBody.parse(request.body);
    const actor = actorOf(request);

    const message = await useCases.sendDm.execute(actor.user, {
      toUserId: asUserId(params.id),
      text: body.text,
    });

    return reply.status(201).send(message);
  });

  /**
   * POST /users/:id/call-end — hang up, or decline a ringing call.
   *
   * The one call action that DOES belong over REST, because it must work when
   * the socket is exactly what has gone wrong. A client whose connection
   * dropped mid-call still needs a way to release the line, and the alternative
   * is waiting out the abandonment timeout.
   *
   * Always 200, including when there was no call: hanging up twice is normal
   * (a local timeout and a user tapping the button both send it) and must not
   * look like a failure.
   */
  app.post('/users/:id/call-end', { preHandler: requireAuth(useCases) }, async (request, reply) => {
    const params = userParam.parse(request.params);
    const actor = actorOf(request);

    await useCases.endCall.execute(actor.user, asUserId(params.id));

    return reply.status(200).send({ message: 'Call ended.' });
  });
}
