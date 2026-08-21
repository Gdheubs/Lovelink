import type { Socket } from 'socket.io';
import type { z } from 'zod';
import type { User } from '../../../domain/entities/User.js';
import type { Ports } from '../../../domain/ports/index.js';
import type { UseCases } from '../../../app/index.js';
import type { SocketSession } from '../server.js';
import type { SocketEventName } from './schemas.js';
import { socketSchemas } from './schemas.js';
import { asRoomId } from '../../../domain/values/ids.js';
import { isDomainError } from '../../../domain/errors.js';

/**
 * The socket edge: validate, look up the actor, call ONE use case, done.
 *
 * THE FOUR RULES EVERY HANDLER FOLLOWS (architecture §4)
 * ------------------------------------------------------
 *   (a) the payload is validated against a schema before anything reads it;
 *   (b) authorization is re-checked by the use case — a client-claimed role,
 *       room or identity is never trusted;
 *   (c) rate limiting happens through the RateLimiter port, inside the use
 *       case, so the HTTP edge inherits the same limits;
 *   (d) results go out through RealtimeTransport, never a raw `io.emit`.
 *
 * WHY THE ACTOR IS RELOADED ON EVERY EVENT
 * ----------------------------------------
 * The socket authenticated once, at connect (see server.ts), and a voice room
 * session can last hours. Caching the `User` on the socket would mean a ban, a
 * suspension, or a trust penalty issued twenty minutes ago has no effect until
 * the socket happens to reconnect.
 *
 * So `withActor` re-reads the user per event. That is one indexed primary-key
 * lookup — cheap next to the presence and rate-limit round trips the handler is
 * about to make anyway — and it is what makes moderation take effect in
 * seconds rather than whenever the client next reconnects.
 */

export interface HandlerContext {
  readonly ports: Ports;
  readonly useCases: UseCases;
  readonly socket: Socket;
  readonly session: SocketSession;
}

/**
 * Wire every Phase 2 event onto a freshly-connected socket.
 *
 * Later phases add their handlers here. Keeping registration in one function
 * means the complete list of things a client may ASK for is readable in one
 * place, just as `RealtimeTransport` is the complete list of what the server
 * may SAY.
 */
export function registerRoomHandlers(context: HandlerContext): void {
  const { socket, session, ports, useCases } = context;

  on(context, 'room:join', async (payload, user) => {
    const roomId = asRoomId(payload.roomId);
    const { state } = await useCases.joinRoom.execute(user, roomId);

    // The snapshot goes ONLY to the joiner — it is built from their
    // perspective (their role, their blocks) and is not a broadcast.
    socket.emit('room:state', state);
  });

  on(context, 'room:leave', async (payload, user) => {
    await useCases.leaveRoom.execute({
      userId: user.id,
      roomId: asRoomId(payload.roomId),
      reason: 'left',
    });
  });

  on(context, 'presence:heartbeat', async (payload, user) => {
    const result = await useCases.heartbeat.execute({
      userId: user.id,
      claimedRooms: (payload?.rooms ?? []).map(asRoomId),
    });

    // Presence lapsed while they were away. Telling the client to re-join is
    // the honest response: the rest of the room already watched them leave, and
    // silently reviving the entry would leave this client's member list
    // permanently out of step with everyone else's.
    for (const roomId of result.staleRooms) {
      socket.emit('error', {
        code: 'NOT_FOUND',
        message: `Your place in the room expired. Re-join to continue.`,
      });
      socket.emit('user:left', { roomId, userId: user.id });
    }
  });

  on(context, 'chat:send', async (payload, user) => {
    await useCases.sendChatMessage.execute(user, {
      roomId: asRoomId(payload.roomId),
      text: payload.text,
    });
  });

  on(context, 'chat:typing', async (payload, user) => {
    await useCases.sendTypingIndicator.execute(user, asRoomId(payload.roomId));
  });

  on(context, 'reaction:send', async (payload, user) => {
    await useCases.sendReaction.execute(user, {
      roomId: asRoomId(payload.roomId),
      reaction: payload.reaction,
    });
  });

  /**
   * Disconnect cleanup.
   *
   * A closing tab does NOT reliably send `room:leave` — the browser may kill
   * the page first — so this is the path that actually runs most of the time.
   * The presence reaper is the third line of defence, for when even this does
   * not fire (a process killed, a network vanishing mid-flight).
   *
   * Marked `disconnected` rather than `left` only to distinguish them in logs;
   * both are voluntary departures and both earn session credit.
   */
  socket.on('disconnect', () => {
    void (async () => {
      try {
        const rooms = await ports.presence.getRoomsForUser(session.userId);
        for (const roomId of rooms) {
          await useCases.leaveRoom.execute({
            userId: session.userId,
            roomId,
            reason: 'disconnected',
          });
        }
      } catch (error) {
        // Never throw from a disconnect handler: there is no client left to
        // tell, and an unhandled rejection here would take the process down.
        ports.logger.warn(
          { userId: session.userId, err: String(error) },
          'failed to clean up presence on disconnect',
        );
      }
    })();
  });
}

// ---------------------------------------------------------------------------

/**
 * Register one handler with validation, actor loading, and error mapping.
 *
 * WHY EVERY HANDLER GOES THROUGH THIS
 * -----------------------------------
 * Each of the four steps below is easy to forget in exactly one handler, and
 * the failure is silent every time:
 *
 *   - forget validation      -> arbitrary JSON reaches a use case
 *   - forget the actor load  -> a banned user keeps acting
 *   - forget the try/catch   -> one thrown domain error kills the process,
 *                               because an async socket listener that rejects
 *                               is an unhandled rejection
 *   - forget the error emit  -> the client hangs forever waiting for a reply
 *
 * Centralising them means a new handler gets all four by construction.
 */
function on<E extends SocketEventName>(
  context: HandlerContext,
  event: E,
  handler: (payload: z.infer<(typeof socketSchemas)[E]>, user: User) => Promise<void>,
): void {
  const { socket, session, ports } = context;
  const schema = socketSchemas[event];

  // Socket.io's `on` is typed against a fixed event map, which cannot express
  // "any key of our schema table". The cast is confined to this one line —
  // every handler above is fully typed, because `on` derives its payload type
  // from the schema via `z.infer`.
  const listen = socket as unknown as {
    on(event: string, listener: (payload: unknown) => void): void;
  };

  listen.on(event, (rawPayload: unknown) => {
    void (async () => {
      const log = ports.logger.child({ socketId: socket.id, userId: session.userId, event });

      // (a) shape.
      const parsed = schema.safeParse(rawPayload ?? {});
      if (!parsed.success) {
        socket.emit('error', {
          code: 'VALIDATION_FAILED',
          message: 'That request was not in a form we understand.',
        });
        log.debug({ issues: parsed.error.issues }, 'rejected malformed socket payload');
        return;
      }

      try {
        // (b) the actor, re-read so moderation takes effect immediately.
        const user = await ports.users.findById(session.userId);

        if (user === null || user.status !== 'active') {
          socket.emit('error', {
            code: 'BANNED',
            message: 'Your account can no longer do that.',
          });
          // Sever rather than merely refuse: a suspended account should not
          // keep an open socket receiving the room's conversation.
          socket.disconnect(true);
          return;
        }

        await handler(parsed.data as never, user);
      } catch (error) {
        if (isDomainError(error)) {
          // Deliberate failures carry a user-safe message; `details` stays in
          // the log, exactly as at the HTTP edge.
          ports.metrics.increment('error.domain');
          socket.emit('error', { code: error.code, message: error.message });
          log.info({ code: error.code, details: error.details }, 'socket request rejected');
          return;
        }

        // A genuine bug. Log everything, disclose nothing.
        ports.metrics.increment('error.unexpected');
        log.error(
          { err: error instanceof Error ? error.message : String(error) },
          'unhandled error in socket handler',
        );
        socket.emit('error', {
          code: 'INTERNAL',
          message: 'Something went wrong on our side. Please try again.',
        });
      }
    })();
  });
}
