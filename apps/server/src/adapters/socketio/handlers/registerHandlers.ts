import type { Socket } from 'socket.io';
import type { z } from 'zod';
import type { User } from '../../../domain/entities/User.js';
import type { Ports } from '../../../domain/ports/index.js';
import type { UseCases } from '../../../app/index.js';
import type { SocketSession } from '../server.js';
import type { SocketEventName } from './schemas.js';
import { socketSchemas } from './schemas.js';
import { asRoomId, asUserId } from '../../../domain/values/ids.js';
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
 * Per-socket serialization.
 *
 * THE BUG THIS FIXES
 * ------------------
 * Socket.io delivers a client's events in the order they were sent, but our
 * handlers are async — so their EFFECTS interleave freely. A client that emits
 * `room:join` and then `room:leave` can have the leave complete first: it finds
 * no presence to remove, does nothing, and then the join writes presence. The
 * user is now in a room they explicitly left, and nothing looks wrong anywhere.
 *
 * That is not one bug, it is a shape of bug — join/leave, raise/lower,
 * request/accept, and every future pair have the same hazard.
 *
 * So each socket gets a queue: events from ONE connection are processed one at
 * a time, in arrival order. Different sockets still run concurrently, so this
 * costs nothing in throughput — a single user's events are user-paced by
 * definition, and a user who fires two in the same millisecond means the second
 * to follow the first.
 *
 * A rejected handler must not poison the chain, hence the `.catch` — the
 * wrapper below already reports errors to the client, and this only keeps the
 * queue moving.
 */
const socketQueues = new WeakMap<Socket, Promise<void>>();

function enqueue(socket: Socket, task: () => Promise<void>): void {
  const previous = socketQueues.get(socket) ?? Promise.resolve();
  const next = previous.then(task).catch(() => undefined);
  socketQueues.set(socket, next);
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

  // -- speaking -------------------------------------------------------------
  //
  // Every one of these re-checks authorization inside the use case, from LIVE
  // server state. The handler passes through a roomId and a userId and nothing
  // else — in particular it never passes a role, because there is no payload
  // field a client could put one in.

  on(context, 'hand:raise', async (payload, user) => {
    await useCases.raiseHand.execute(user, { roomId: asRoomId(payload.roomId), raised: true });
  });

  on(context, 'hand:lower', async (payload, user) => {
    await useCases.raiseHand.execute(user, { roomId: asRoomId(payload.roomId), raised: false });
  });

  on(context, 'speaker:approve', async (payload, user) => {
    // HOST ONLY — enforced by ApproveSpeaker reading the actor's role from
    // presence, not from anything on this socket.
    await useCases.approveSpeaker.execute(user, {
      roomId: asRoomId(payload.roomId),
      userId: asUserId(payload.userId),
    });
  });

  on(context, 'speaker:remove', async (payload, user) => {
    // Host removing someone else, or a speaker stepping down. The two have
    // completely different authorization, so they are different use cases and
    // the distinction is made HERE by comparing ids — the only place it is
    // safe, because `user` is the authenticated session.
    const roomId = asRoomId(payload.roomId);
    const targetId = asUserId(payload.userId);

    if (targetId === user.id) {
      await useCases.stepDownAsSpeaker.execute(user, roomId);
      return;
    }
    await useCases.removeSpeaker.execute(user, { roomId, userId: targetId });
  });

  on(context, 'room:mute-user', async (payload, user) => {
    await useCases.muteSpeaker.execute(user, {
      roomId: asRoomId(payload.roomId),
      userId: asUserId(payload.userId),
      muted: payload.muted,
    });
  });

  // -- safety ---------------------------------------------------------------

  on(context, 'room:kick', async (payload, user) => {
    // HOST ONLY, and room-scoped: a host runs a room, a moderator runs the
    // platform. Enforced inside the use case from live presence.
    await useCases.kickUser.execute(user, {
      roomId: asRoomId(payload.roomId),
      userId: asUserId(payload.userId),
    });
  });

  on(context, 'report:submit', async (payload, user) => {
    await useCases.submitReport.execute(user, {
      targetId: asUserId(payload.targetId),
      roomId: payload.roomId === undefined ? null : asRoomId(payload.roomId),
      category: payload.category,
      ...(payload.note === undefined ? {} : { note: payload.note }),
    });

    // Acknowledged to the reporter alone, and deliberately vague: it must not
    // reveal whether this person has been reported before, which would be a
    // way to probe someone else's standing.
    socket.emit('error', {
      code: 'CONFLICT',
      message: 'Thank you. Our team will look at this.',
    });
  });

  // -- connections: DM (rung 3) ---------------------------------------------

  /**
   * The whole DM ladder over sockets.
   *
   * NOTHING HERE RETURNS A RESULT TO THE SENDER except `dm:message`, and that
   * is on purpose. `dm:request` succeeding tells the requester only that the
   * request was accepted for delivery — never whether the other person exists,
   * is online, or has already blocked them. Each of those would be a way to
   * probe someone who has deliberately made themselves unreachable.
   *
   * The one visible failure is a domain error, and the ladder's denial
   * messages are written to be uninformative in exactly this way: a block and
   * an inactive account both say "That person is not available."
   */
  on(context, 'dm:request', async (payload, user) => {
    await useCases.requestDm.execute(user, asUserId(payload.userId));
  });

  on(context, 'dm:accept', async (payload, user) => {
    await useCases.acceptDm.execute(user, asUserId(payload.userId));
  });

  on(context, 'dm:decline', async (payload, user) => {
    // Silent by design — see DeclineDm. The requester is never told, so there
    // is nothing to emit to anyone but the decliner's own confirmation, which
    // their client already rendered optimistically.
    await useCases.declineDm.execute(user, asUserId(payload.userId));
  });

  on(context, 'dm:message', async (payload, user) => {
    // Delivery to BOTH parties happens inside the use case, so the sender's
    // other tabs receive it too. Nothing is emitted from here.
    await useCases.sendDm.execute(user, {
      toUserId: asUserId(payload.userId),
      text: payload.text,
    });
  });

  // -- connections: 1:1 call (rung 4) ---------------------------------------

  /**
   * Call signalling.
   *
   * WHY THE TOKEN GOES BACK OVER THE SOCKET AND NOT AS A BROADCAST
   * --------------------------------------------------------------
   * `socket.emit` here targets THIS connection only. A media token is a
   * credential to open a microphone in a two-person room, and it belongs to
   * exactly one device — the one that asked. Sending it via `emitToUser` would
   * hand it to every tab that person has open, including ones sitting on a
   * public machine they walked away from.
   *
   * The corresponding event for the OTHER party (`call:accepted`) is emitted
   * from inside the use case through RealtimeTransport, because that one is
   * genuinely per-user: whichever of their devices is ringing should answer.
   */
  on(context, 'call:invite', async (payload, user) => {
    // Emits NOTHING back. The caller is ringing, not connected: their own
    // token arrives in `call:accepted` if and when the other person answers.
    // Acknowledging with a token here would both leak a credential for a call
    // nobody accepted and make the caller's UI show a connected call.
    await useCases.inviteToCall.execute(user, asUserId(payload.userId));
  });

  on(context, 'call:accept', async (payload, user) => {
    const session = await useCases.acceptCall.execute(user, asUserId(payload.userId));

    socket.emit('call:accepted', {
      withUserId: session.withUserId,
      callRoomId: session.callRoomId,
      mediaToken: {
        token: session.mediaToken.token,
        url: session.mediaToken.url,
        roomName: session.mediaToken.roomName,
        expiresAt: session.mediaToken.expiresAt.toISOString(),
      },
    });
  });

  on(context, 'call:decline', async (payload, user) => {
    // Decline and hang up are the same operation — release the line, tell the
    // other person. See EndCall.
    await useCases.endCall.execute(user, asUserId(payload.userId));
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
        // PRESENCE IS PER USER; DISCONNECT IS PER SOCKET.
        //
        // Someone with two tabs open who closes one is still in the room — the
        // other tab is still rendering it. Cleaning up here unconditionally
        // makes them vanish from everyone else's member list while their own
        // screen still shows them present.
        //
        // The transport has already removed this socket from the registry (see
        // the ordering note in server.ts), so a `true` here means a genuinely
        // separate connection is still open.
        if (await ports.realtime.isUserConnected(session.userId)) {
          ports.logger.debug(
            { userId: session.userId },
            'socket closed but the user has another connection; keeping presence',
          );
          return;
        }

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
    // Queued rather than fired: see `enqueue` for why a client's events must
    // take effect in the order they were sent.
    enqueue(socket, async () => {
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
    });
  });
}
