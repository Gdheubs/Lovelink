import { io } from 'socket.io-client';

/**
 * Fill a local server with something worth looking at.
 *
 * WHY THIS EXISTS
 * ---------------
 * The integration suite truncates the database, so any hand-made rooms vanish
 * the moment anyone runs the full tests. Re-creating them by hand each time is
 * both tedious and how a dev environment quietly drifts into a shape nothing
 * else has — this makes the demo state reproducible instead.
 *
 * WHY IT USES THE REAL API RATHER THAN INSERTING ROWS
 * ---------------------------------------------------
 * Every account here signs up properly, every room is created through the
 * endpoint, and every person joins over a real socket. Seeding by SQL would be
 * faster and would happily produce states the application cannot actually
 * reach — a room with no host, presence with no membership row — which is worse
 * than no seed at all, because it makes bugs look like data problems.
 *
 * It is IDEMPOTENT: run it as often as you like. Accounts that exist are
 * reused, rooms that exist are left alone.
 *
 * Usage:  npm run seed:dev            (needs AUTH_ECHO_CODE=true)
 */

const BASE = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:4020';

/** The demo cast. One host, and enough people to make two rooms feel occupied. */
const PEOPLE = [
  ['priya', 'Priya'],
  ['sam', 'Sam'],
  ['jo', 'Jo'],
  ['ravi', 'Ravi'],
  ['mika', 'Mika'],
  ['dee', 'Dee'],
];

/**
 * The rooms, with real temperatures so intent matching has something to do.
 *
 * A mix on purpose: choosing "listen" should surface the quiet one and "think"
 * the deep one, which is only demonstrable if they differ.
 */
const ROOMS = [
  { title: 'Late Night Talk', category: 'late_night', temperature: 'deep' },
  { title: 'Quiet Study Room', category: 'study', temperature: 'quiet' },
  { title: 'Midnight Thoughts', category: 'support', temperature: 'deep' },
  { title: 'Anything Goes', category: 'casual', temperature: 'warm' },
];

async function json(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
  });
  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : {} };
}

async function signIn(handle, name) {
  const identifier = `${handle}@loverlink.local`;

  const requested = await json('/auth/request-code', {
    method: 'POST',
    body: JSON.stringify({ identifier }),
  });

  if (requested.status === 429) {
    throw new Error(
      'Rate limited requesting login codes — that is the per-IP auth limit working.\n' +
        "  Clear it:  docker exec loverlink-redis sh -c \"redis-cli --scan --pattern 'loverlink:rl:*' | xargs -r redis-cli del\"",
    );
  }

  const code = requested.body.devCode;
  if (!code) throw new Error('No dev code returned. Set AUTH_ECHO_CODE=true.');

  // Name and date of birth are sent every time. For an existing account the
  // server ignores them and simply logs in; for a new one they complete the
  // signup — so this one call covers both and the script stays idempotent.
  const verified = await json('/auth/verify', {
    method: 'POST',
    body: JSON.stringify({ identifier, code, displayName: name, dob: '1994-07-02' }),
  });

  if (!verified.body.accessToken) {
    throw new Error(`Could not sign in ${handle}: ${JSON.stringify(verified.body)}`);
  }
  return verified.body.accessToken;
}

const tokens = new Map();
for (const [handle, name] of PEOPLE) {
  tokens.set(handle, await signIn(handle, name));
  process.stdout.write(`  signed in ${name}\n`);
}

const hostToken = tokens.get('priya');
const auth = (token) => ({ authorization: `Bearer ${token}` });

// Create only what is missing, so re-running does not pile up duplicates.
const existing = await json('/rooms', { headers: auth(hostToken) });
const known = new Set((existing.body.rooms ?? []).map((room) => room.title));

for (const room of ROOMS) {
  if (known.has(room.title)) {
    process.stdout.write(`  ${room.title} — already there\n`);
    continue;
  }
  const created = await json('/rooms', {
    method: 'POST',
    headers: auth(hostToken),
    body: JSON.stringify(room),
  });
  process.stdout.write(
    `  ${room.title} — ${created.body.temperature ?? created.body.error?.message}\n`,
  );
}

const rooms = (await json('/rooms', { headers: auth(hostToken) })).body.rooms ?? [];
const find = (title) => rooms.find((room) => room.title === title);

/** Who sits where. Two occupied rooms, two empty, so both states are visible. */
const SEATING = [
  ['priya', 'Late Night Talk'],
  ['sam', 'Late Night Talk'],
  ['jo', 'Late Night Talk'],
  ['ravi', 'Late Night Talk'],
  ['mika', 'Quiet Study Room'],
  ['dee', 'Quiet Study Room'],
];

const sockets = [];

for (const [handle, title] of SEATING) {
  const room = find(title);
  if (room === undefined) continue;

  const socket = io(BASE, {
    auth: { token: tokens.get(handle) },
    transports: ['websocket'],
    reconnection: false,
  });

  socket.on('connect', () => socket.emit('room:join', { roomId: room.id }));
  socket.on('room:state', () => process.stdout.write(`  ${handle} is in ${title}\n`));
  socket.on('error', (payload) => process.stdout.write(`  ${handle}: ${JSON.stringify(payload)}\n`));

  sockets.push({ socket, room });
  await new Promise((resolve) => setTimeout(resolve, 300));
}

// A little conversation, so the room is not silent when you walk in.
await new Promise((resolve) => setTimeout(resolve, 1200));
const talk = sockets.find((s) => s.room.title === 'Late Night Talk');
if (talk !== undefined) {
  sockets[1]?.socket.emit('chat:send', {
    roomId: talk.room.id,
    text: 'is this everyone else’s 2am too',
  });
  await new Promise((resolve) => setTimeout(resolve, 400));
  sockets[2]?.socket.emit('chat:send', { roomId: talk.room.id, text: 'unfortunately yes' });
  await new Promise((resolve) => setTimeout(resolve, 400));
  sockets[3]?.socket.emit('hand:raise', { roomId: talk.room.id });
}

process.stdout.write('\n  Holding the rooms open. Ctrl-C to empty them.\n');

/*
 * The heartbeat is not optional.
 *
 * Presence expires after PRESENCE_TTL_SECONDS without one — that is how the
 * server detects a phone that locked mid-conversation. Stop this script and the
 * rooms empty themselves within a minute, which is the ghost cleanup working
 * rather than a bug.
 */
setInterval(() => {
  for (const { socket } of sockets) socket.emit('presence:heartbeat', {});
}, 15_000);
