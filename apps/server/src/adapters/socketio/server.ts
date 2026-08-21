import type { Server as HttpServer } from 'node:http';
import { Server as SocketIOServer, type Socket } from 'socket.io';
import type { Config } from '../../config.js';
import type { Ports } from '../../domain/ports/index.js';
import type { UserId } from '../../domain/values/ids.js';
import type { UseCases } from '../../app/index.js';
import { SocketIoTransport } from './SocketIoTransport.js';

/**
 * ADAPTER: the realtime edge.
 *
 * THIS IS THE ONLY FILE IN THE CODEBASE THAT MAY TOUCH `io`.
 *
 * Everything else that needs to tell a client something goes through the
 * RealtimeTransport port. That rule is what keeps "the server can say X" a
 * finite, greppable list (domain/ports/RealtimeTransport.ts) instead of a
 * property you discover by reading every handler.
 *
 * Handler responsibilities, in order, per architecture §4:
 *   (a) validate the payload shape at the edge,
 *   (b) re-check authorization by calling a use case — never trust a
 *       client-claimed role, room, or identity,
 *   (c) rate-limit through the RateLimiter port,
 *   (d) emit results through RealtimeTransport.
 *
 * Handlers themselves contain NO business logic. If a handler grows an `if`
 * about permissions, that `if` is in the wrong ring.
 */

export interface SocketServerDeps {
  readonly config: Config;
  readonly ports: Ports;
  readonly useCases: UseCases;
}

/** What we attach to an authenticated socket. */
export interface SocketSession {
  /** Branded so a handler cannot pass a roomId where the actor belongs. */
  readonly userId: UserId;
  readonly sessionId: string;
}

declare module 'socket.io' {
  interface Socket {
    session?: SocketSession;
  }
}

export interface RealtimeServer {
  readonly io: SocketIOServer;
  readonly transport: SocketIoTransport;
  close(): Promise<void>;
}

export function createSocketServer(httpServer: HttpServer, deps: SocketServerDeps): RealtimeServer {
  const { config, ports } = deps;

  const io = new SocketIOServer(httpServer, {
    cors: { origin: config.corsOrigins as string[], credentials: true },
    // Mobile clients drop constantly. A generous disconnect grace means a
    // subway tunnel does not eject someone from a conversation, while the
    // PresenceStore TTL is the real backstop for genuine departures.
    pingInterval: 20_000,
    pingTimeout: 25_000,
    // Bodies here are chat messages. Same reasoning as the HTTP body limit.
    maxHttpBufferSize: 32 * 1024,
  });

  const transport = new SocketIoTransport(io, ports.logger);

  /**
   * Authenticate ONCE, at connect, per architecture §3.
   *
   * WHY NOT PER EVENT: re-verifying a JWT on every keystroke of a typing
   * indicator is wasteful, and more importantly it invites the pattern of
   * trusting a userId sent in the payload. The identity is established here and
   * read from `socket.session` thereafter — a client cannot claim to be someone
   * else because it never gets to say who it is again.
   *
   * The trade-off is that a ban must actively sever the socket rather than
   * waiting for the next request to fail; that is exactly what
   * RealtimeTransport.disconnectUser and the EventBus moderation channel are for.
   */
  io.use(async (socket: Socket, next) => {
    try {
      const token =
        (socket.handshake.auth as { token?: unknown } | undefined)?.token ??
        socket.handshake.query.token;

      if (typeof token !== 'string' || token.length === 0) {
        next(new Error('UNAUTHENTICATED'));
        return;
      }

      const claims = await ports.tokens.verifyAccessToken(token);
      if (claims === null) {
        next(new Error('UNAUTHENTICATED'));
        return;
      }

      // A banned user may hold a still-valid access token. Checking status at
      // connect closes that window; the bus event closes the already-open one.
      const user = await ports.users.findById(claims.userId);
      if (user === null || user.status !== 'active') {
        next(new Error('BANNED'));
        return;
      }

      socket.session = { userId: claims.userId, sessionId: claims.sessionId };
      transport.register(claims.userId, socket);
      next();
    } catch (error) {
      ports.logger.error({ err: String(error) }, 'socket auth failed');
      next(new Error('UNAUTHENTICATED'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const session = socket.session;
    if (session === undefined) {
      socket.disconnect(true);
      return;
    }

    const log = ports.logger.child({ socketId: socket.id, userId: session.userId });
    log.debug({}, 'socket connected');

    // Phase 2 registers the room/chat handlers here.
    // Phase 3 adds the hand-raise and speaker handlers.
    // Phase 5 adds DM and call handlers.

    socket.on('disconnect', (reason) => {
      transport.unregister(session.userId, socket);
      log.debug({ reason }, 'socket disconnected');
    });
  });

  return {
    io,
    transport,
    async close() {
      await new Promise<void>((resolve) => {
        io.close(() => resolve());
      });
    },
  };
}
