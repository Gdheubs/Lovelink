import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { HttpServerDeps } from '../server.js';
import { actorOf, requireAuth } from '../authGuard.js';
import { ROOM_CATEGORIES } from '../../../domain/entities/Room.js';
import { MAX_SPEAKERS_CEILING } from '../../../domain/entities/Room.js';
import { asRoomId } from '../../../domain/values/ids.js';
import { NotFoundError } from '../../../domain/errors.js';

/**
 * Room CRUD over HTTP.
 *
 * WHY ROOMS ARE REST AND CHAT IS SOCKETS
 * --------------------------------------
 * The split is by LIFETIME, not by preference. Creating and listing rooms are
 * one-shot request/response operations that a client may perform before it has
 * a socket at all — the room list is the first screen after sign-in. Joining,
 * chatting and presence are continuous and bidirectional, and modelling them as
 * REST would mean polling.
 *
 * Note that JOINING is a socket event, not a POST. Joining a room means
 * establishing presence, and presence is meaningless without the connection it
 * belongs to: a REST join would create an entry with no socket behind it, which
 * is a ghost by construction.
 */

const createBody = z.object({
  title: z.string().min(1).max(120),
  category: z.enum(ROOM_CATEGORIES as unknown as [string, ...string[]]),
  maxSpeakers: z.number().int().min(1).max(MAX_SPEAKERS_CEILING).optional(),
});

const listQuery = z.object({
  category: z.string().optional(),
  limit: z.coerce.number().int().positive().optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export async function registerRoomRoutes(
  app: FastifyInstance,
  deps: HttpServerDeps,
): Promise<void> {
  const { useCases, ports } = deps;

  /**
   * GET /rooms — the home screen.
   *
   * Requires auth. An unauthenticated room list would expose what conversations
   * are happening, and how busy they are, to anyone who asks — which for a
   * platform built around late-night intimate conversation is information worth
   * protecting even in aggregate.
   */
  app.get('/rooms', { preHandler: requireAuth(useCases) }, async (request, reply) => {
    const query = listQuery.parse(request.query);

    const rooms = await useCases.listRooms.execute({
      ...(query.category === undefined ? {} : { category: query.category }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.offset === undefined ? {} : { offset: query.offset }),
    });

    return reply.send({ rooms });
  });

  /** POST /rooms — create one. The creator becomes host on their first join. */
  app.post('/rooms', { preHandler: requireAuth(useCases) }, async (request, reply) => {
    const body = createBody.parse(request.body);
    const actor = actorOf(request);

    const room = await useCases.createRoom.execute(actor.user, {
      title: body.title,
      category: body.category,
      ...(body.maxSpeakers === undefined ? {} : { maxSpeakers: body.maxSpeakers }),
    });

    return reply.status(201).send({
      id: room.id,
      slug: room.slug,
      title: room.title,
      category: room.category,
      hostUserId: room.hostUserId,
      maxSpeakers: room.maxSpeakers,
      status: room.status,
      createdAt: room.createdAt.toISOString(),
    });
  });

  /**
   * GET /rooms/:id — details for one room, before joining.
   *
   * Deliberately does NOT return the member list. That comes from `room:state`
   * over the socket once you are actually in the room — being able to see who
   * is in a conversation without entering it would let someone track another
   * user's whereabouts across the platform.
   */
  app.get('/rooms/:id', { preHandler: requireAuth(useCases) }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const room = await ports.rooms.findById(asRoomId(params.id));

    if (room === null) throw new NotFoundError('Room');

    return reply.send({
      id: room.id,
      slug: room.slug,
      title: room.title,
      category: room.category,
      hostUserId: room.hostUserId,
      maxSpeakers: room.maxSpeakers,
      status: room.status,
      memberCount: await ports.presence.countRoomMembers(room.id),
      createdAt: room.createdAt.toISOString(),
    });
  });
}
