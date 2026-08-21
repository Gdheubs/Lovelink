import { createServer, type Server as HttpServer } from 'node:http';
import { io as connectClient, type Socket as ClientSocket } from 'socket.io-client';
import { createSocketServer, type RealtimeServer } from '../../src/adapters/socketio/server.js';
import { createUseCases, type UseCases } from '../../src/app/index.js';
import { createMemoryPorts, type MemoryPorts } from '../../src/adapters/memory/index.js';
import { loadConfig, type Config } from '../../src/config.js';
import type { User } from '../../src/domain/entities/User.js';
import type { RoomId } from '../../src/domain/values/ids.js';
import { asUserId } from '../../src/domain/values/ids.js';
import { TRUST_DELTAS } from '../../src/domain/values/trust.js';

/**
 * A REAL Socket.io server, in-process, over a real TCP port, backed by the
 * in-memory fakes.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every rule in this system is unit-tested against the fakes, and that covers
 * the rules. What it does NOT cover is the socket EDGE — and the edge is where
 * a specific and nasty family of bugs lives:
 *
 *   - an unauthenticated socket that is allowed to connect;
 *   - a malformed payload that reaches a use case and throws, which in an async
 *     socket listener is an UNHANDLED REJECTION that kills the process;
 *   - an event registered under the wrong name, so it silently does nothing;
 *   - a client-supplied userId being trusted somewhere in a handler.
 *
 * None of those are visible from a use-case test, because a use-case test never
 * goes through the edge. Hence a real server on a real port — but with fakes
 * underneath, so the suite still needs no Docker and still runs in a second.
 */

export interface SocketHarness {
  readonly ports: MemoryPorts;
  readonly useCases: UseCases;
  readonly config: Config;
  readonly url: string;

  /** Create an account directly, bypassing the auth flow (tested elsewhere). */
  createUser(displayName: string): Promise<User>;
  /** A valid access token for a user. */
  tokenFor(user: User): Promise<string>;
  /** Connect an authenticated client and wait until it is ready. */
  connect(user: User): Promise<TestClient>;
  /** Connect with an arbitrary token (or none), for auth tests. */
  connectRaw(token?: string): Promise<{ connected: boolean; error: string | null }>;

  close(): Promise<void>;
}

/** A connected client that records everything the server says to it. */
export interface TestClient {
  readonly socket: ClientSocket;
  readonly userId: string;
  readonly events: RecordedEvent[];

  emit(event: string, payload?: unknown): void;
  /** Wait for the next occurrence of an event, or time out. */
  next<T = unknown>(event: string, timeoutMs?: number): Promise<T | null>;
  /** Every payload received for an event so far. */
  all<T = unknown>(event: string): T[];
  /** Wait until a predicate over recorded events holds. */
  until(predicate: () => boolean, timeoutMs?: number): Promise<boolean>;
  clear(): void;
  disconnect(): void;
}

export interface RecordedEvent {
  readonly event: string;
  readonly payload: unknown;
}

/** Events the server can send. Recorded wholesale so tests can assert on any. */
const SERVER_EVENTS = [
  'room:state',
  'user:joined',
  'user:left',
  'chat:message',
  'chat:typing',
  'reaction:shown',
  'hand:raised',
  'speaker:promoted',
  'speaker:demoted',
  'room:muted',
  'room:kicked',
  'dm:requested',
  'dm:opened',
  'dm:message',
  'call:incoming',
  'call:accepted',
  'call:declined',
  'surprise:received',
  'user:banned',
  'error',
] as const;

const DEFAULT_TIMEOUT_MS = 2_000;

export async function startSocketHarness(
  options: { presenceTtlSeconds?: number } = {},
): Promise<SocketHarness> {
  const ports = createMemoryPorts({
    // Wall-clock, because a real socket server's own timers (ping, timeouts)
    // run on wall time — a frozen clock here would make TTL behaviour
    // inconsistent with the transport underneath it.
    deterministic: false,
    presenceTtlSeconds: options.presenceTtlSeconds ?? 45,
  });

  const config = loadConfig({
    NODE_ENV: 'test',
    PERSISTENCE: 'memory',
    CORS_ORIGINS: 'http://localhost:3000',
    AUTH_ECHO_CODE: 'true',
    LOG_PRETTY: 'false',
    LOG_LEVEL: 'error',
  } as NodeJS.ProcessEnv);

  const useCases = createUseCases(ports, { echoLoginCode: true, moderatorUserIds: [] });

  const httpServer: HttpServer = createServer();
  const realtime: RealtimeServer = createSocketServer(httpServer, { config, ports, useCases });

  // The transport must be injected back into the ports, exactly as the
  // composition root does — otherwise broadcasts would go to the recorder and
  // no client would receive anything.
  (ports as { realtime: unknown }).realtime = realtime.transport;

  // Port 0 = let the OS pick a free one. Hardcoding a port makes the suite
  // fail whenever a dev server happens to be running.
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));

  const address = httpServer.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Could not determine the harness port.');
  }
  const url = `http://127.0.0.1:${address.port}`;

  const clients: ClientSocket[] = [];
  let userCounter = 0;

  // Declared outside the object literal so `connect` can call it without
  // relying on `this`, which TypeScript widens unhelpfully inside a returned
  // literal typed as a union.
  const tokenFor = async (user: User): Promise<string> => {
    const { token } = await ports.tokens.issueAccessToken(user.id, `session-${user.id}`);
    return token;
  };

  return {
    ports,
    useCases,
    config,
    url,

    async createUser(displayName) {
      userCounter += 1;
      const user = await ports.users.create({
        id: asUserId(ports.ids.uuid()),
        identifier: `${displayName.toLowerCase()}-${userCounter}@example.com`,
        identifierKind: 'email',
        displayName,
        avatarSeed: `seed-${userCounter}`,
        dob: new Date('1995-01-01T00:00:00.000Z'),
        createdAt: ports.clock.now(),
      });

      // Mirrors what registration does: VerifyLoginCode opens the ledger with
      // `account_created`, which carries the STARTING BALANCE. A fixture that
      // skips it produces users who are one kick away from being restricted —
      // an account state no real user is ever in.
      await ports.users.appendTrustEvent({
        userId: user.id,
        delta: TRUST_DELTAS.account_created,
        reason: 'account_created',
        context: null,
        createdAt: ports.clock.now(),
      });

      return (await ports.users.findById(user.id)) ?? user;
    },

    tokenFor,

    async connect(user) {
      const token = await tokenFor(user);
      const socket = connectClient(url, {
        auth: { token },
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
      });
      clients.push(socket);

      const events: RecordedEvent[] = [];
      for (const event of SERVER_EVENTS) {
        socket.on(event, (payload: unknown) => events.push({ event, payload }));
      }

      const connected = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), DEFAULT_TIMEOUT_MS);
        socket.on('connect', () => {
          clearTimeout(timer);
          resolve(true);
        });
        socket.on('connect_error', () => {
          clearTimeout(timer);
          resolve(false);
        });
      });

      if (!connected) throw new Error(`Client for ${user.displayName} failed to connect.`);

      return makeTestClient(socket, user.id, events);
    },

    async connectRaw(token) {
      const socket = connectClient(url, {
        ...(token === undefined ? {} : { auth: { token } }),
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
      });
      clients.push(socket);

      return new Promise((resolve) => {
        const timer = setTimeout(
          () => resolve({ connected: false, error: 'timeout' }),
          DEFAULT_TIMEOUT_MS,
        );
        socket.on('connect', () => {
          clearTimeout(timer);
          resolve({ connected: true, error: null });
        });
        socket.on('connect_error', (error: Error) => {
          clearTimeout(timer);
          resolve({ connected: false, error: error.message });
        });
      });
    },

    async close() {
      for (const socket of clients) socket.disconnect();
      await realtime.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await ports.bus.close();
    },
  };
}

function makeTestClient(socket: ClientSocket, userId: string, events: RecordedEvent[]): TestClient {
  return {
    socket,
    userId,
    events,

    emit(event, payload) {
      socket.emit(event, payload);
    },

    async next<T>(event: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T | null> {
      const alreadySeen = events.filter((e) => e.event === event).length;
      const deadline = Date.now() + timeoutMs;

      while (Date.now() < deadline) {
        const matching = events.filter((e) => e.event === event);
        if (matching.length > alreadySeen) {
          return matching[matching.length - 1]!.payload as T;
        }
        await sleep(10);
      }
      return null;
    },

    all<T>(event: string): T[] {
      return events.filter((e) => e.event === event).map((e) => e.payload as T);
    },

    async until(predicate, timeoutMs = DEFAULT_TIMEOUT_MS) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return true;
        await sleep(10);
      }
      return false;
    },

    clear() {
      events.length = 0;
    },

    disconnect() {
      socket.disconnect();
    },
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Create a room owned by `host`, returning its id. */
export async function createRoom(
  harness: SocketHarness,
  host: User,
  title = 'Test Room',
): Promise<RoomId> {
  const room = await harness.useCases.createRoom.execute(host, { title, category: 'casual' });
  return room.id;
}
