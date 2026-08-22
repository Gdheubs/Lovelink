import { io, type Socket } from 'socket.io-client';

/**
 * PHASE 5 EXIT CRITERION, against a running server with real Postgres, Redis
 * and LiveKit:
 *
 *   "meet in a room -> send a surprise -> open a DM -> make a 1:1 call,
 *    all on the trust ladder."
 *
 * WHY THIS EXISTS ALONGSIDE tests/app AND tests/socket
 * ----------------------------------------------------
 * Those suites prove the rules and the edge, against the in-memory fakes. What
 * neither can prove is that the WIRING reaches them with real infrastructure
 * behind it — that surprises survive in Postgres rather than a Map, that the
 * per-user Redis rate limits are the ones being consumed, that LiveKit issues a
 * token our client can actually parse, and that the HTTP and socket edges agree
 * about a relationship they are both reading from the same database.
 *
 * Those are wiring failures, and wiring is what breaks a deploy.
 *
 * Run:  npm run ladder-check
 */

const BASE_URL = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:4000';
const RUN = Date.now().toString(36);

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

interface ApiResult<T> {
  status: number;
  body: T;
}

async function api<T>(
  method: string,
  path: string,
  options: { body?: unknown; token?: string } = {},
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

  const text = await response.text();
  const body = text.length > 0 ? (JSON.parse(text) as T) : ({} as T);
  return { status: response.status, body };
}

interface Actor {
  userId: string;
  token: string;
  displayName: string;
}

async function register(label: string): Promise<Actor> {
  const identifier = `ladder-${label}-${RUN}@loverlink.test`;
  const displayName = `Ladder ${label}`;

  const requested = await api<{ devCode: string | null }>('POST', '/auth/request-code', {
    body: { identifier },
  });

  if (requested.status === 429) {
    throw new Error(
      'Rate limited requesting a login code — that is the per-IP auth limit working.\n' +
        '  Clear it: docker exec loverlink-redis sh -c "redis-cli --scan --pattern \'loverlink:rl:auth:*\' | xargs -r redis-cli del"',
    );
  }
  if (requested.body.devCode === null) {
    throw new Error('Server did not return a login code. Set AUTH_ECHO_CODE=true.');
  }

  const verified = await api<{ accessToken: string; profile: { id: string } }>(
    'POST',
    '/auth/verify',
    { body: { identifier, code: requested.body.devCode, displayName, dob: '1993-05-05' } },
  );

  if (verified.status >= 400) {
    throw new Error(`Could not register ${label}: ${JSON.stringify(verified.body)}`);
  }

  return { userId: verified.body.profile.id, token: verified.body.accessToken, displayName };
}

interface Client {
  socket: Socket;
  events: { event: string; payload: unknown }[];
}

const WATCHED = [
  'room:state',
  'dm:requested',
  'dm:opened',
  'dm:message',
  'call:incoming',
  'call:accepted',
  'call:declined',
  'surprise:received',
  'error',
] as const;

async function connect(actor: Actor): Promise<Client> {
  const events: { event: string; payload: unknown }[] = [];
  const socket = io(BASE_URL, {
    auth: { token: actor.token },
    transports: ['websocket'],
    reconnection: false,
  });

  for (const event of WATCHED) {
    socket.on(event, (payload: unknown) => events.push({ event, payload }));
  }

  const connected = await waitUntil(() => socket.connected, 5_000);
  if (!connected) throw new Error(`${actor.displayName} could not connect a socket.`);

  return { socket, events };
}

function received<T = Record<string, unknown>>(client: Client, event: string): T[] {
  return client.events.filter((e) => e.event === event).map((e) => e.payload as T);
}

async function waitFor(client: Client, event: string, timeoutMs = 5_000): Promise<boolean> {
  return waitUntil(() => received(client, event).length > 0, timeoutMs);
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

async function main(): Promise<void> {
  process.stdout.write(`\nLoverlink trust-ladder check\n  target: ${BASE_URL}\n  run id: ${RUN}\n`);

  const alice = await register('alice');
  const bob = await register('bob');
  const stranger = await register('stranger');

  const aliceSocket = await connect(alice);
  const bobSocket = await connect(bob);
  const strangerSocket = await connect(stranger);

  // -- 0. the ladder refuses to be skipped ----------------------------------
  step('0. the ladder cannot be skipped');

  const earlyDm = await api<{ error?: { code: string } }>(
    'POST',
    `/users/${stranger.userId}/dm-request`,
    { token: alice.token },
  );
  check(
    'a DM request to someone you have never met is refused',
    earlyDm.status === 403,
    earlyDm.body,
  );

  aliceSocket.socket.emit('call:invite', { userId: stranger.userId });
  await waitFor(aliceSocket, 'error', 2_000);
  check(
    'a call with no open DM is refused',
    received<{ code: string }>(aliceSocket, 'error')[0]?.code === 'TRUST_LADDER_VIOLATION',
    received(aliceSocket, 'error')[0],
  );
  check('...and never reached the stranger', received(strangerSocket, 'call:incoming').length === 0);
  aliceSocket.events.length = 0;

  // -- 1. meet --------------------------------------------------------------
  step('1. they meet in a room');

  const room = await api<{ id: string }>('POST', '/rooms', {
    token: alice.token,
    body: { title: `Ladder ${RUN}`, category: 'casual' },
  });
  check('a room is created', room.status === 201, room.body);

  aliceSocket.socket.emit('room:join', { roomId: room.body.id });
  bobSocket.socket.emit('room:join', { roomId: room.body.id });

  check('both are in the room', await waitFor(bobSocket, 'room:state', 5_000));

  // A real overlap, not two sessions that merely touch at the boundary.
  await new Promise((resolve) => setTimeout(resolve, 1_500));

  aliceSocket.socket.emit('room:leave', { roomId: room.body.id });
  bobSocket.socket.emit('room:leave', { roomId: room.body.id });
  await new Promise((resolve) => setTimeout(resolve, 500));

  // -- 2. surprise ----------------------------------------------------------
  step('2. a surprise changes hands');

  const created = await api<{ code: string; id: string }>('POST', '/surprises', {
    token: alice.token,
    body: {
      theme: 'thinking_of_you',
      message: 'good talking to you tonight',
      tasks: ['drink some water'],
    },
  });
  check('a surprise is created', created.status === 201, created.body);
  check('the code is speakable', /^[A-Z]{4}-[A-Z0-9]{6}$/.test(created.body.code), created.body.code);

  const wrongCode = await api('POST', '/surprises/redeem', {
    token: bob.token,
    body: { code: 'LOVE-000000', mood: 'happy' },
  });
  check('an unknown code is a plain 404', wrongCode.status === 404);

  const opened = await api<{ reveal: string; personalMessage: string; from: { displayName: string } }>(
    'POST',
    '/surprises/redeem',
    { token: bob.token, body: { code: created.body.code.toLowerCase(), mood: 'tired' } },
  );
  check('the code works however it was transcribed', opened.status === 200, opened.body);
  check('the reveal names the sender', opened.body.reveal?.includes('Ladder alice'), opened.body.reveal);
  check('the personal message survived the round trip', opened.body.personalMessage === 'good talking to you tonight');

  check('THE SENDER IS TOLD IT LANDED', await waitFor(aliceSocket, 'surprise:received', 5_000));
  check(
    "...without being told the recipient's mood",
    !JSON.stringify(received(aliceSocket, 'surprise:received')[0] ?? {}).includes('tired'),
    received(aliceSocket, 'surprise:received')[0],
  );

  const reopened = await api<{ error?: { code: string } }>('POST', '/surprises/redeem', {
    token: stranger.token,
    body: { code: created.body.code, mood: 'happy' },
  });
  check('A CODE OPENS EXACTLY ONCE', reopened.status === 409, reopened.body);

  // Durability: the whole point of the Postgres adapter landing this phase.
  const listed = await api<{ received: { id: string; mood: string }[] }>('GET', '/me/surprises', {
    token: bob.token,
  });
  check(
    'the opened surprise is durable, not in a Map',
    listed.body.received?.some((s) => s.id === created.body.id && s.mood === 'tired'),
    listed.body.received,
  );

  // -- 3. the DM ------------------------------------------------------------
  step('3. a DM opens, with consent');

  const request = await api('POST', `/users/${bob.userId}/dm-request`, { token: alice.token });
  check('the request is accepted now they have met', request.status === 202, request.body);
  check('bob is told', await waitFor(bobSocket, 'dm:requested', 5_000));

  const earlyMessage = await api<{ error?: { code: string } }>(
    'POST',
    `/users/${bob.userId}/messages`,
    { token: alice.token, body: { text: 'hello?' } },
  );
  check('A PENDING REQUEST GRANTS NO MESSAGING RIGHTS', earlyMessage.status === 403, earlyMessage.body);

  const selfAccept = await api<{ error?: { code: string } }>(
    'POST',
    `/users/${bob.userId}/dm-accept`,
    { token: alice.token },
  );
  check('the requester cannot accept their own request', selfAccept.status === 404, selfAccept.body);

  const accepted = await api('POST', `/users/${alice.userId}/dm-accept`, { token: bob.token });
  check('bob accepts', accepted.status === 200, accepted.body);
  check('both are told the conversation is open', await waitFor(aliceSocket, 'dm:opened', 5_000));

  aliceSocket.socket.emit('dm:message', { userId: bob.userId, text: 'hey!' });
  check('the message arrives over the socket', await waitFor(bobSocket, 'dm:message', 5_000));
  check(
    '...and is echoed to the sender for their other devices',
    received(aliceSocket, 'dm:message').length > 0,
  );
  check('it never reached a third party', received(strangerSocket, 'dm:message').length === 0);

  const thread = await api<{ messages: { text: string }[] }>(
    'GET',
    `/users/${alice.userId}/messages`,
    { token: bob.token },
  );
  check('the thread persisted', thread.body.messages?.[0]?.text === 'hey!', thread.body);

  // -- 4. the call ----------------------------------------------------------
  step('4. the 1:1 call');

  bobSocket.events.length = 0;
  aliceSocket.events.length = 0;

  aliceSocket.socket.emit('call:invite', { userId: bob.userId });
  check("BOB'S PHONE RINGS", await waitFor(bobSocket, 'call:incoming', 5_000));

  const incoming = received(bobSocket, 'call:incoming')[0];
  check('the ring carries NO media token', !JSON.stringify(incoming ?? {}).includes('token'), incoming);
  check(
    'the caller is not told the call connected merely for dialling',
    received(aliceSocket, 'call:accepted').length === 0,
  );

  // Self-accept is the attack this rung exists to stop.
  aliceSocket.socket.emit('call:accept', { userId: bob.userId });
  await waitFor(aliceSocket, 'error', 3_000);
  check(
    'THE CALLER CANNOT ACCEPT THEIR OWN CALL',
    received<{ code: string }>(aliceSocket, 'error')[0]?.code === 'NO_PENDING_CALL',
    received(aliceSocket, 'error')[0],
  );
  check(
    "...so bob's client was never told to join audio he did not answer",
    received(bobSocket, 'call:accepted').length === 0,
  );

  bobSocket.socket.emit('call:accept', { userId: alice.userId });
  check('bob answers', await waitFor(bobSocket, 'call:accepted', 5_000));
  check('and the caller is connected', await waitFor(aliceSocket, 'call:accepted', 5_000));

  const bobToken = received<{ callRoomId: string; mediaToken: { token: string; url: string } }>(
    bobSocket,
    'call:accepted',
  )[0];
  const aliceToken = received<{ callRoomId: string; mediaToken: { token: string; url: string } }>(
    aliceSocket,
    'call:accepted',
  )[0];

  check('both are sent to the same room', bobToken?.callRoomId === aliceToken?.callRoomId, {
    bob: bobToken?.callRoomId,
    alice: aliceToken?.callRoomId,
  });
  check(
    'with DIFFERENT credentials',
    typeof bobToken?.mediaToken.token === 'string' &&
      bobToken.mediaToken.token !== aliceToken?.mediaToken.token,
  );
  check(
    'the token is a real signed LiveKit JWT',
    (bobToken?.mediaToken.token.split('.').length ?? 0) === 3,
    bobToken?.mediaToken.token?.slice(0, 24),
  );
  check('no third party received a media token', received(strangerSocket, 'call:accepted').length === 0);

  const busy = await api<{ error?: { code: string } }>('POST', `/users/${bob.userId}/dm-request`, {
    token: alice.token,
  });
  check('a second DM request on an open conversation is refused', busy.status === 403, busy.body);

  // -- 5. hanging up --------------------------------------------------------
  step('5. hanging up frees the line');

  const ended = await api('POST', `/users/${alice.userId}/call-end`, { token: bob.token });
  check('the call can be ended over REST, when the socket is what broke', ended.status === 200);
  check('the other party is told', await waitFor(aliceSocket, 'call:declined', 5_000));

  const endedTwice = await api('POST', `/users/${alice.userId}/call-end`, { token: bob.token });
  check('hanging up twice is not an error', endedTwice.status === 200);

  bobSocket.events.length = 0;
  aliceSocket.socket.emit('call:invite', { userId: bob.userId });
  check('and they can call again immediately', await waitFor(bobSocket, 'call:incoming', 5_000));
  await api('POST', `/users/${alice.userId}/call-end`, { token: bob.token });

  // -- 6. blocking still wins ----------------------------------------------
  step('6. a block outranks every rung earned');

  await api('PUT', `/users/${alice.userId}/block`, { token: bob.token });

  const afterBlock = await api<{ error?: { code: string } }>(
    'POST',
    `/users/${bob.userId}/messages`,
    { token: alice.token, body: { text: 'still here' } },
  );
  check('a blocked user cannot message', afterBlock.status === 403, afterBlock.body);

  const historyAfterBlock = await api('GET', `/users/${bob.userId}/messages`, {
    token: alice.token,
  });
  check('nor re-read the history', historyAfterBlock.status === 403);

  for (const client of [aliceSocket, bobSocket, strangerSocket]) client.socket.disconnect();

  process.stdout.write(`\n${'-'.repeat(52)}\n  passed: ${passed}\n  failed: ${failed}\n`);
  if (failures.length > 0) {
    process.stdout.write(`\n  failures:\n${failures.map((f) => `    - ${f}`).join('\n')}\n`);
  }
  process.stdout.write(`${'-'.repeat(52)}\n\n`);

  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  process.stderr.write(
    `\nLadder check could not run:\n  ${error instanceof Error ? error.message : String(error)}\n\n`,
  );
  process.exitCode = 1;
});
