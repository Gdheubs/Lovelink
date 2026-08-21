import { io, type Socket } from 'socket.io-client';

/**
 * PHASE 2 EXIT CRITERION, as an executable check.
 *
 *   "10 users can sit in a room and chat with correct presence."
 *
 * WHY THIS EXISTS SEPARATELY FROM THE UNIT TESTS
 * ----------------------------------------------
 * `tests/app/rooms.test.ts` proves the same thing against the in-memory fakes,
 * in milliseconds, and that is where the rules are verified. What it CANNOT
 * verify is the wiring: that ten real websockets authenticate, that broadcast
 * actually reaches every one of them, that presence in Redis agrees with what
 * each client believes, and that a disconnect propagates.
 *
 * Those are integration failures, and they are most of what breaks a deploy.
 *
 * WHAT IT CHECKS, IN ORDER
 *   1. ten accounts register over real HTTP
 *   2. ten sockets connect and authenticate
 *   3. all ten join one room; each receives a snapshot listing all ten
 *   4. each sends one message; every client receives all ten
 *   5. heartbeats keep presence alive past the TTL
 *   6. five disconnect; the remaining five are told, and the count is right
 *
 * USAGE
 *   npm run dev                     # or dev:memory
 *   npm run room-check
 *   SMOKE_BASE_URL=http://127.0.0.1:4020 npm run room-check
 */

const BASE_URL = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:4000';
const USER_COUNT = 10;
const RUN = Date.now().toString(36);

/** Generous: this must not fail merely because a laptop is busy. */
const EVENT_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(description: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    process.stdout.write(`  ok   ${description}\n`);
  } else {
    failed += 1;
    failures.push(description);
    process.stdout.write(`  FAIL ${description}\n`);
    if (detail !== undefined) process.stdout.write(`       ${JSON.stringify(detail)}\n`);
  }
}

function step(title: string): void {
  process.stdout.write(`\n${title}\n`);
}

async function api<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const text = await response.text();
  const payload: unknown = text.length > 0 ? JSON.parse(text) : {};

  if (!response.ok) {
    const envelope = payload as { error?: { code?: string; message?: string } };
    throw new Error(
      `${method} ${path} -> ${response.status} ${envelope.error?.code ?? ''} ${envelope.error?.message ?? ''}`,
    );
  }
  return payload as T;
}

/** Poll until a condition holds, rather than sleeping a guessed interval. */
async function waitUntil(
  description: string,
  predicate: () => boolean,
  timeoutMs = EVENT_TIMEOUT_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  process.stdout.write(`       (timed out waiting for: ${description})\n`);
  return false;
}

// ---------------------------------------------------------------------------

interface Participant {
  label: string;
  userId: string;
  displayName: string;
  token: string;
  socket: Socket;
  /** Everything this client has been told. */
  received: {
    state: { members: { user: { id: string } }[] }[];
    messages: { text: string; from: { id: string } }[];
    joined: string[];
    left: string[];
    errors: { code: string; message: string }[];
  };
}

async function registerUser(index: number): Promise<Omit<Participant, 'socket' | 'received'>> {
  const label = `load${String(index).padStart(2, '0')}`;
  const identifier = `${label}-${RUN}@loverlink.test`;
  const displayName = `Load ${index}`;

  const requested = await api<{ devCode: string | null }>('POST', '/auth/request-code', {
    identifier,
  });

  if (requested.devCode === null) {
    throw new Error('Server did not return a login code. Set AUTH_ECHO_CODE=true.');
  }

  const verified = await api<{ accessToken: string; profile: { id: string } }>(
    'POST',
    '/auth/verify',
    { identifier, code: requested.devCode, displayName, dob: '1994-03-15' },
  );

  return { label, userId: verified.profile.id, displayName, token: verified.accessToken };
}

function connect(base: Omit<Participant, 'socket' | 'received'>): Participant {
  const received: Participant['received'] = {
    state: [],
    messages: [],
    joined: [],
    left: [],
    errors: [],
  };

  const socket = io(BASE_URL, {
    auth: { token: base.token },
    transports: ['websocket'],
    reconnection: false,
  });

  socket.on('room:state', (payload) => received.state.push(payload));
  socket.on('chat:message', (payload) => received.messages.push(payload));
  socket.on('user:joined', (payload: { member: { user: { id: string } } }) =>
    received.joined.push(payload.member.user.id),
  );
  socket.on('user:left', (payload: { userId: string }) => received.left.push(payload.userId));
  socket.on('error', (payload) => received.errors.push(payload));

  return { ...base, socket, received };
}

async function main(): Promise<void> {
  process.stdout.write(
    `\nLoverlink room load check\n  target: ${BASE_URL}\n  users:  ${USER_COUNT}\n  run id: ${RUN}\n`,
  );

  // -- 1. accounts ---------------------------------------------------------
  step('1. registering accounts');
  const bases: Omit<Participant, 'socket' | 'received'>[] = [];
  for (let i = 0; i < USER_COUNT; i += 1) {
    // Sequential on purpose: the auth endpoint is rate limited per IP, and
    // firing ten at once would trip a control that is working correctly.
    bases.push(await registerUser(i));
  }
  check(`${USER_COUNT} accounts created`, bases.length === USER_COUNT);

  // -- 2. the room ---------------------------------------------------------
  step('2. creating a room');
  const host = bases[0]!;
  const room = await api<{ id: string; title: string }>(
    'POST',
    '/rooms',
    { title: `Load Test ${RUN}`, category: 'casual' },
    host.token,
  );
  check('room created', typeof room.id === 'string', room);

  // -- 3. connect ----------------------------------------------------------
  step('3. connecting sockets');
  const participants = bases.map(connect);

  const allConnected = await waitUntil('all sockets connected', () =>
    participants.every((p) => p.socket.connected),
  );
  check(`${USER_COUNT} sockets connected`, allConnected);

  // -- 4. join -------------------------------------------------------------
  step('4. joining the room');
  for (const p of participants) {
    p.socket.emit('room:join', { roomId: room.id });
  }

  const everyoneGotSnapshot = await waitUntil('every client received room:state', () =>
    participants.every((p) => p.received.state.length > 0),
  );
  check('every client received a room:state snapshot', everyoneGotSnapshot);

  // The last joiner's snapshot is the one that should list everybody.
  const fullMembership = await waitUntil('the last snapshot lists all members', () => {
    const last = participants[participants.length - 1]!.received.state.at(-1);
    return last !== undefined && last.members.length === USER_COUNT;
  });
  const lastSnapshot = participants[participants.length - 1]!.received.state.at(-1);
  check(`the last joiner sees all ${USER_COUNT} members`, fullMembership, {
    saw: lastSnapshot?.members.length,
  });

  // Server-side truth, independent of what any client believes.
  const roomDetail = await api<{ memberCount: number }>(
    'GET',
    `/rooms/${room.id}`,
    undefined,
    host.token,
  );
  check(
    `server presence count is ${USER_COUNT}`,
    roomDetail.memberCount === USER_COUNT,
    roomDetail,
  );

  // The first joiner should have been told about the other nine arriving.
  const firstJoiner = participants[0]!;
  check(
    'the first joiner was told about the other arrivals',
    firstJoiner.received.joined.length === USER_COUNT - 1,
    { heard: firstJoiner.received.joined.length },
  );

  // -- 5. chat -------------------------------------------------------------
  step('5. everyone talks');
  for (const p of participants) {
    p.socket.emit('chat:send', { roomId: room.id, text: `hello from ${p.displayName}` });
  }

  const everyoneHeardEveryone = await waitUntil('all clients received all messages', () =>
    participants.every((p) => p.received.messages.length >= USER_COUNT),
  );
  check(`all ${USER_COUNT} clients received all ${USER_COUNT} messages`, everyoneHeardEveryone, {
    counts: participants.map((p) => p.received.messages.length),
  });

  // Including their own — the echo is deliberate, so the sender renders what
  // the server accepted rather than an optimistic local copy.
  const senderSawOwnMessage = participants.every((p) =>
    p.received.messages.some((m) => m.from.id === p.userId),
  );
  check('each sender received their own message back', senderSawOwnMessage);

  const noErrors = participants.every((p) => p.received.errors.length === 0);
  check(
    'no client received an error',
    noErrors,
    participants.flatMap((p) => p.received.errors).slice(0, 3),
  );

  // -- 6. heartbeat --------------------------------------------------------
  step('6. presence survives on heartbeats');
  for (let round = 0; round < 3; round += 1) {
    for (const p of participants) {
      p.socket.emit('presence:heartbeat', { rooms: [room.id] });
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  const afterHeartbeats = await api<{ memberCount: number }>(
    'GET',
    `/rooms/${room.id}`,
    undefined,
    host.token,
  );
  check(
    'presence still complete after heartbeats',
    afterHeartbeats.memberCount === USER_COUNT,
    afterHeartbeats,
  );

  // -- 7. departure --------------------------------------------------------
  step('7. half of them leave');
  const leaving = participants.slice(USER_COUNT / 2);
  const staying = participants.slice(0, USER_COUNT / 2);

  for (const p of leaving) {
    p.socket.disconnect();
  }

  const departuresSeen = await waitUntil('remaining clients were told about the departures', () =>
    staying.every((p) => p.received.left.length >= leaving.length),
  );
  check('remaining clients received user:left for everyone who went', departuresSeen, {
    counts: staying.map((p) => p.received.left.length),
  });

  const finalDetail = await api<{ memberCount: number }>(
    'GET',
    `/rooms/${room.id}`,
    undefined,
    host.token,
  );
  check(
    `server presence count is now ${staying.length}`,
    finalDetail.memberCount === staying.length,
    finalDetail,
  );

  // -- cleanup -------------------------------------------------------------
  for (const p of staying) p.socket.disconnect();

  // -- summary -------------------------------------------------------------
  process.stdout.write(`\n${'-'.repeat(52)}\n  passed: ${passed}\n  failed: ${failed}\n`);
  if (failures.length > 0) {
    process.stdout.write(`\n  failures:\n${failures.map((f) => `    - ${f}`).join('\n')}\n`);
  }
  process.stdout.write(`${'-'.repeat(52)}\n\n`);

  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  process.stderr.write(
    `\nRoom load check could not run:\n  ${error instanceof Error ? error.message : String(error)}\n\n` +
      `  Is the server running at ${BASE_URL}?\n\n`,
  );
  process.exitCode = 1;
});
