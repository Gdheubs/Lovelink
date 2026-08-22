import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { HttpServerDeps } from '../server.js';
import { actorOf, requireAuth } from '../authGuard.js';
import {
  SURPRISE_MAX_TASKS,
  SURPRISE_MESSAGE_MAX,
  SURPRISE_MOODS,
  SURPRISE_THEMES,
} from '../../../domain/entities/Surprise.js';
import { asSurpriseId } from '../../../domain/values/ids.js';

/**
 * Surprises over HTTP.
 *
 * WHY THIS IS REST AND NOT A SOCKET EVENT
 * ---------------------------------------
 * A surprise is ASYNCHRONOUS by definition — the whole mechanic is that you
 * leave something for someone who is not there. Neither party is necessarily
 * connected when it is created, and the recipient may open it days later on a
 * different device.
 *
 * There is exactly one realtime moment in the flow — the sender being told
 * their surprise was opened — and that goes out through RealtimeTransport from
 * inside the use case, reaching them if they happen to be online and simply not
 * arriving if they are not. Nothing in the mechanic depends on it.
 *
 * WHAT THE RESPONSES DELIBERATELY OMIT
 * ------------------------------------
 * A surprise the caller did not send and has not opened is never described, at
 * all. Not its theme, not its sender, not whether it exists. Every failure to
 * find one — wrong code, expired, already opened by someone else — returns the
 * same 404, because distinguishing them tells a guesser which codes were ever
 * real and turns brute force from hopeless into merely slow.
 */

const createBody = z.object({
  theme: z.enum(SURPRISE_THEMES as unknown as [string, ...string[]]),
  // The domain enforces the real limit and produces the message a user reads;
  // this cap only stops a megabyte of text being allocated at the edge.
  message: z.string().min(1).max(SURPRISE_MESSAGE_MAX * 2),
  tasks: z.array(z.string().max(500)).max(SURPRISE_MAX_TASKS * 2).optional(),
});

const redeemBody = z.object({
  // Generous, because people paste codes with spaces, dashes and stray
  // punctuation. `normalizeCode` in the domain strips all of it.
  code: z.string().min(1).max(64),
  mood: z.enum(SURPRISE_MOODS as unknown as [string, ...string[]]),
});

const taskBody = z.object({
  taskIndex: z.number().int().min(0).max(SURPRISE_MAX_TASKS),
  done: z.boolean(),
});

const idParam = z.object({ id: z.string().uuid() });

export async function registerSurpriseRoutes(
  app: FastifyInstance,
  deps: HttpServerDeps,
): Promise<void> {
  const { useCases } = deps;

  /**
   * POST /surprises — create one, and get back a code to hand over.
   */
  app.post('/surprises', { preHandler: requireAuth(useCases) }, async (request, reply) => {
    const body = createBody.parse(request.body);
    const actor = actorOf(request);

    const { surprise, displayCode } = await useCases.createSurprise.execute(actor.user, {
      theme: body.theme,
      message: body.message,
      ...(body.tasks === undefined ? {} : { tasks: body.tasks }),
    });

    return reply.status(201).send({
      id: surprise.id,
      code: displayCode,
      theme: surprise.theme,
      expiresAt: surprise.expiresAt.toISOString(),
    });
  });

  /**
   * POST /surprises/redeem — open one.
   *
   * The mood is chosen HERE, by the recipient, at the moment of opening. It is
   * a required field rather than an optional refinement because it is what
   * selects the message: the sender picked what they wanted to say days ago and
   * cannot know how the reader is feeling now.
   */
  app.post('/surprises/redeem', { preHandler: requireAuth(useCases) }, async (request, reply) => {
    const body = redeemBody.parse(request.body);
    const actor = actorOf(request);

    const revealed = await useCases.redeemSurprise.execute(actor.user, {
      code: body.code,
      mood: body.mood,
      ip: clientIp(request),
    });

    return reply.status(200).send(revealed);
  });

  /**
   * PATCH /surprises/:id/tasks — tick off one of the sender's sweet tasks.
   *
   * Recipient only, enforced in the use case. The sender watching a checklist
   * they can edit themselves would be a strange kind of pressure.
   */
  app.patch(
    '/surprises/:id/tasks',
    { preHandler: requireAuth(useCases) },
    async (request, reply) => {
      const params = idParam.parse(request.params);
      const body = taskBody.parse(request.body);
      const actor = actorOf(request);

      const updated = await useCases.toggleSurpriseTask.execute(actor.user, {
        surpriseId: asSurpriseId(params.id),
        taskIndex: body.taskIndex,
        done: body.done,
      });

      return reply.status(200).send({
        id: updated.id,
        tasks: updated.tasks,
      });
    },
  );

  /**
   * GET /me/surprises — what this person has sent and received.
   *
   * The two lists carry deliberately different fields; see ListMySurprises for
   * what each side is and is not allowed to learn.
   */
  app.get('/me/surprises', { preHandler: requireAuth(useCases) }, async (request, reply) => {
    const actor = actorOf(request);
    const view = await useCases.listMySurprises.execute(actor.user);
    return reply.status(200).send(view);
  });
}

/**
 * The caller's IP, for the redemption rate limit only.
 *
 * That limit is not incidental — it is the control that makes a short,
 * speakable code safe at all. See RedeemSurprise.
 */
function clientIp(request: FastifyRequest): string {
  return request.ip;
}
