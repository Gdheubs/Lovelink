import { io } from 'socket.io-client';

/**
 * PHASE 2 CHECK: the room pulse, and the one rule in it that could hurt
 * somebody.
 *
 * WHAT THIS IS ACTUALLY TESTING
 * -----------------------------
 * Not that voting works — a unit test covers that. It tests the ANONYMITY
 * THRESHOLD over real HTTP, with real presence, because that rule is a promise
 * to a person and a promise enforced only in a unit test is a promise that
 * holds until someone writes a second endpoint.
 *
 * Specifically: with four voters the server must reveal NOTHING, including the
 * count — "3 people have voted" in a room of four is most of the way to knowing
 * who. With five it may speak, and it must speak in prose.
 *
 * Usage:  npm run pulse-check    (needs AUTH_ECHO_CODE=true and a live server)
 */

const BASE = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:4020';

let passed = 0;
let failed = 0;

function check(description, condition, detail) {
  if (condition) {
    passed += 1;
    process.stdout.write(`  ok   ${description}\n`);
  } else {
    failed += 1;
    process.stdout.write(`  FAIL ${description}\n`);
    if (detail !== undefined) process.stdout.write(`       ${JSON.stringify(detail)}\n`);
  }
}

async function json(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
  });
  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : {} };
}

async function signIn(handle) {
  const identifier = `${handle}@pulse.local`;
  const requested = await json('/auth/request-code', {
    method: 'POST',
    body: JSON.stringify({ identifier }),
  });

  if (requested.status === 429) {
    throw new Error(
      'Rate limited — the per-IP auth limit working. Clear it:\n' +
        "  docker exec loverlink-redis sh -c \"redis-cli --scan --pattern 'loverlink:rl:*' | xargs -r redis-cli del\"",
    );
  }
  if (!requested.body.devCode) throw new Error('No dev code. Set AUTH_ECHO_CODE=true.');

  const verified = await json('/auth/verify', {
    method: 'POST',
    body: JSON.stringify({
      identifier,
      code: requested.body.devCode,
      displayName: handle,
      dob: '1994-01-01',
    }),
  });
  return verified.body.accessToken;
}

const auth = (token) => ({ authorization: `Bearer ${token}` });

// -- set up: one room, six people in it ------------------------------------
process.stdout.write('\nRoom pulse check\n');

const host = await signIn('pulsehost');
const room = await json('/rooms', {
  method: 'POST',
  headers: auth(host),
  body: JSON.stringify({ title: `Pulse ${Date.now()}`, category: 'casual', temperature: 'warm' }),
});
const roomId = room.body.id;

const people = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
const tokens = { pulsehost: host };
for (const handle of people) tokens[handle] = await signIn(handle);

const sockets = [];
for (const handle of ['pulsehost', ...people]) {
  const socket = io(BASE, {
    auth: { token: tokens[handle] },
    transports: ['websocket'],
    reconnection: false,
  });
  socket.on('connect', () => socket.emit('room:join', { roomId }));
  sockets.push(socket);
  await new Promise((r) => setTimeout(r, 250));
}
await new Promise((r) => setTimeout(r, 1500));

// -- someone outside the room ----------------------------------------------
const outsider = await signIn('outsider');

const denied = await json(`/rooms/${roomId}/pulse`, { headers: auth(outsider) });
check('someone not in the room cannot read the pulse', denied.status === 403, denied.body);

const deniedVote = await json(`/rooms/${roomId}/pulse`, {
  method: 'PUT',
  headers: auth(outsider),
  body: JSON.stringify({ feeling: 'playful' }),
});
check('nor set it from outside', deniedVote.status === 403, deniedVote.body);

// -- below the threshold ----------------------------------------------------
const vote = (handle, feeling) =>
  json(`/rooms/${roomId}/pulse`, {
    method: 'PUT',
    headers: auth(tokens[handle]),
    body: JSON.stringify({ feeling }),
  });

for (const handle of ['p1', 'p2', 'p3', 'p4']) await vote(handle, 'heavy');

const four = await json(`/rooms/${roomId}/pulse`, { headers: auth(tokens.p1) });
check('four voters: SAYS NOTHING', four.body.description === null, four.body);
check('four voters: no breakdown', (four.body.slices ?? []).length === 0, four.body.slices);
check('four voters: admits there are votes', four.body.tooFewToShow === true, four.body);
check(
  'four voters: WITHHOLDS THE COUNT — it is as identifying as the result',
  !JSON.stringify(four.body).includes('"voters"') || four.body.voters === 0,
  four.body,
);
check('but tells you your OWN answer', four.body.yours === 'heavy', four.body);

// -- at the threshold -------------------------------------------------------
await vote('p5', 'heavy');

const five = await json(`/rooms/${roomId}/pulse`, { headers: auth(tokens.p1) });
check('five voters: speaks', typeof five.body.description === 'string', five.body);
check(
  'and speaks in prose, not percentages',
  typeof five.body.description === 'string' && !/\d/.test(five.body.description),
  five.body.description,
);
check('describes the ROOM, not a person', !/\byou\b/i.test(five.body.description ?? ''), five.body.description);

// -- changing your mind -----------------------------------------------------
await vote('p1', 'calm');
const changed = await json(`/rooms/${roomId}/pulse`, { headers: auth(tokens.p1) });
check('a second vote replaces the first', changed.body.yours === 'calm', changed.body);
check(
  'and does not add a voter',
  (changed.body.slices ?? []).reduce((sum, s) => sum + s.share, 0) <= 101,
  changed.body.slices,
);

// -- nonsense ---------------------------------------------------------------
const bad = await vote('p1', 'spicy');
check('an invented feeling is refused', bad.status === 400, bad.body);

for (const socket of sockets) socket.disconnect();

process.stdout.write(`\n  passed: ${passed}\n  failed: ${failed}\n\n`);
process.exitCode = failed === 0 ? 0 : 1;
