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
  /**
   * A five-field cron expression for a recurring room.
   *
   * Bounded generously; the DOMAIN decides whether it is a schedule that can
   * actually fire, and refuses it with a message naming what is supported. The
   * cap here only stops a megabyte of text reaching the parser.
   */
  scheduleCron: z.string().min(1).max(120).optional(),
  scheduleTimeZone: z.string().min(1).max(64).optional(),
  /** quiet | warm | deep. The domain refuses anything else. */
  temperature: z.string().min(1).max(16).optional(),
});

const listQuery = z.object({
  category: z.string().optional(),
  limit: z.coerce.number().int().positive().optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const roomParam = z.object({ id: z.string().uuid() });

/** One of the ways a ROOM can feel, never how a person feels. */
const pulseBody = z.object({ feeling: z.string().min(1).max(16) });

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
      ...(body.scheduleCron === undefined ? {} : { scheduleCron: body.scheduleCron }),
      ...(body.scheduleTimeZone === undefined ? {} : { scheduleTimeZone: body.scheduleTimeZone }),
      ...(body.temperature === undefined ? {} : { temperature: body.temperature }),
    });

    return reply.status(201).send({
      id: room.id,
      slug: room.slug,
      title: room.title,
      category: room.category,
      hostUserId: room.hostUserId,
      maxSpeakers: room.maxSpeakers,
      status: room.status,
      temperature: room.temperature,
      createdAt: room.createdAt.toISOString(),
      // Echoed back so a host can SEE when their recurring room will first
      // open. A schedule accepted silently is one they cannot check.
      isScheduled: room.isScheduled,
      scheduleCron: room.scheduleCron,
      scheduleTimeZone: room.scheduleTimeZone,
      nextOccurrenceAt: room.nextOccurrenceAt?.toISOString() ?? null,
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
    const params = roomParam.parse(request.params);
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
      // The host's contract. The room screen leads with it, so a room that
      // did not send it would silently claim to be `warm`.
      temperature: room.temperature,
      memberCount: await ports.presence.countRoomMembers(room.id),
      createdAt: room.createdAt.toISOString(),
    });
  });

  /**
   * GET /rooms/:id/pulse — how the room feels.
   *
   * Members only. Someone browsing the list gets occupancy and the room's own
   * stated contract, which is enough to decide whether to walk in; a mood
   * reported by strangers to strangers would be a rating.
   */
  app.get('/rooms/:id/pulse', { preHandler: requireAuth(useCases) }, async (request, reply) => {
    const params = roomParam.parse(request.params);
    const actor = actorOf(request);

    return reply.send(await useCases.getRoomPulse.execute(actor.user, asRoomId(params.id)));
  });

  /**
   * PUT /rooms/:id/pulse — say how it feels.
   *
   * PUT because it replaces this person's previous answer. One vote each is a
   * property of the storage rather than a check, so there is nothing here to
   * flood.
   */
  app.put('/rooms/:id/pulse', { preHandler: requireAuth(useCases) }, async (request, reply) => {
    const params = roomParam.parse(request.params);
    const body = pulseBody.parse(request.body);
    const actor = actorOf(request);

    await useCases.voteOnRoomFeeling.execute(actor.user, {
      roomId: asRoomId(params.id),
      feeling: body.feeling,
    });

    return reply.status(204).send();
  });
}

