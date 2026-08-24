/**
 * SMOKE TEST — the real user journey against a running server.
 *
 * WHAT THIS IS FOR, AND WHY IT IS NOT A UNIT TEST
 * -----------------------------------------------
 * Everything else in the test suite runs in-process against fakes or exercises
 * one adapter in isolation. This script talks to a real server over real HTTP
 * and a real socket, exactly as a phone would. It is the only check that the
 * WIRING is right — that the composition root injected the adapters it meant
 * to, that the routes are registered, that CORS and cookies work, that config
 * on this machine is sane.
 *
 * Those are the failures that unit tests structurally cannot catch, and they
 * are most of what actually breaks a deploy.
 *
 * USAGE
 *   npm run dev:memory          # or a real server
 *   npm run smoke               # against http://127.0.0.1:4000
 *   SMOKE_BASE_URL=https://api.loverlink.online npm run smoke
 *
 * It is destructive in the sense that it creates real accounts, so point it at
 * a staging environment or a fresh database, never at production.
 *
 * SCOPE: this script covers the journey a single account walks alone — health,
 * registration, the age gate, profile, auth lifecycle. Journeys that need
 * several accounts and live sockets have their own scripts, listed at the
 * bottom, because folding them in here would make one failure impossible to
 * locate among sixty passing lines.
 */

const BASE_URL = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:4000';

// A unique run id keeps repeat runs from colliding on the unique identifier
// index, so the script is re-runnable against the same database.
const RUN = Date.now().toString(36);

interface Tokens {
  accessToken: string;
  refreshToken: string;
}

interface Actor {
  label: string;
  identifier: string;
  displayName: string;
  userId: string;
  tokens: Tokens;
}

// ---------------------------------------------------------------------------
// Tiny test harness. No framework: this script must run anywhere, including a
// deploy box with only the built output.
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
    if (detail !== undefined) {
      process.stdout.write(`       ${JSON.stringify(detail)}\n`);
    }
  }
}

function step(title: string): void {
  process.stdout.write(`\n${title}\n`);
}

interface ApiResponse<T> {
  status: number;
  body: T;
}

async function api<T = Record<string, unknown>>(
  method: string,
  path: string,
  options: { body?: unknown; token?: string } = {},
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

  // 204 has no body; parsing it would throw.
  const text = await response.text();
  const body = text.length > 0 ? (JSON.parse(text) as T) : ({} as T);

  return { status: response.status, body };
}

// ---------------------------------------------------------------------------
// Journey
// ---------------------------------------------------------------------------

/**
 * Ask for a login code, failing with a USEFUL message when the request is
 * refused.
 *
 * The 429 case is worth special handling. Every run of this script consumes
 * several code requests from one IP, and the per-IP limit is deliberately low
 * (it is the control that stops one actor running up an SMS bill). Redis holds
 * those counters across server restarts, so running the smoke test three times
 * in quick succession WILL hit it.
 *
 * That is the rate limiter working. Reporting it as "the age gate is broken",
 * which is what a bare status check produces, would send someone debugging the
 * wrong subsystem entirely.
 */
async function requestCode(identifier: string, label: string): Promise<string> {
  const requested = await api<{
    devCode: string | null;
    identifierKind: string;
    error?: { code: string };
  }>('POST', '/auth/request-code', { body: { identifier } });

  if (requested.status === 429 || requested.body.error?.code === 'RATE_LIMITED') {
    throw new Error(
      `Rate limited while requesting a code for ${label}.\n` +
        `  This is the per-IP auth limit doing its job, not a bug.\n` +
        `  Wait for the window to pass, or clear it:\n` +
        `    docker exec loverlink-redis redis-cli --scan --pattern 'loverlink:rl:auth:*' | xargs -r docker exec -i loverlink-redis redis-cli del`,
    );
  }

  check(`${label}: code requested`, requested.status === 202, requested.body);
  check(`${label}: identified as email`, requested.body.identifierKind === 'email');

  if (requested.body.devCode === null) {
    throw new Error(
      'The server did not return a login code. Set AUTH_ECHO_CODE=true (never in production).',
    );
  }
  return requested.body.devCode;
}

/**
 * Register one account end to end.
 *
 * Relies on AUTH_ECHO_CODE returning the login code in the response. That is
 * why this script cannot run against production — and that is deliberate: a
 * smoke test that could complete a signup against production would mean
 * production hands out login codes.
 */
async function registerActor(label: string, dob: string): Promise<Actor> {
  const identifier = `smoke-${label}-${RUN}@loverlink.test`;
  const displayName = `Smoke ${label}`;

  const code = await requestCode(identifier, label);

  const verified = await api<{
    accessToken: string;
    refreshToken: string;
    profile: { id: string; displayName: string };
    isNewAccount: boolean;
  }>('POST', '/auth/verify', {
    body: { identifier, code, displayName, dob },
  });

  check(`${label}: account created`, verified.status === 201, verified.body);
  check(`${label}: flagged as new`, verified.body.isNewAccount === true);
  check(`${label}: display name kept`, verified.body.profile?.displayName === displayName);

  return {
    label,
    identifier,
    displayName,
    userId: verified.body.profile.id,
    tokens: { accessToken: verified.body.accessToken, refreshToken: verified.body.refreshToken },
  };
}

async function main(): Promise<void> {
  process.stdout.write(`\nLoverlink smoke test\n  target: ${BASE_URL}\n  run id: ${RUN}\n`);

  // -- 0. the server is up ---------------------------------------------------
  step('0. health');
  const health = await api<{ status: string; persistence: string }>('GET', '/healthz');
  check('healthz responds ok', health.body.status === 'ok', health.body);
  process.stdout.write(`       persistence: ${health.body.persistence}\n`);

  const ready = await api<{ status: string }>('GET', '/readyz');
  check('readyz reports ready', ready.body.status === 'ready', ready.body);

  // -- 1. two users register (Phase 1 exit criterion) ------------------------
  step('1. registration');
  const alice = await registerActor('alice', '1995-04-12');
  const bob = await registerActor('bob', '1992-11-30');
  check('two distinct accounts', alice.userId !== bob.userId);

  // -- 2. the 18+ gate holds -------------------------------------------------
  /*
   * The signal that says "this identifier is new".
   *
   * Checked over REAL HTTP because that is the only place the bug could be
   * seen: the use-case test asserted a `details` flag which is true in-process
   * and stripped on the way out, so it passed while the sign-in form dead-ended
   * for every new user. Whatever a client branches on has to be asserted where
   * the client would read it.
   */
  step('1b. a new identifier asks for a name and date of birth');

  const newcomer = `smoke-newcomer-${RUN}@loverlink.test`;
  const newcomerCode = await requestCode(newcomer, 'newcomer');

  const bare = await api<{ error?: { code: string } }>('POST', '/auth/verify', {
    body: { identifier: newcomer, code: newcomerCode },
  });

  check('verifying without a name is refused', bare.status === 400, bare.body);
  check(
    'THE CLIENT CAN TELL IT APART FROM ANY OTHER 400',
    bare.body.error?.code === 'REGISTRATION_REQUIRED',
    bare.body.error,
  );

  const completed = await api<{ isNewAccount: boolean }>('POST', '/auth/verify', {
    body: {
      identifier: newcomer,
      code: newcomerCode,
      displayName: 'Smoke Newcomer',
      dob: '1994-02-02',
    },
  });
  check('and resubmitting with them completes signup', completed.status === 201, completed.body);

  step('2. the age gate');
  const minorIdentifier = `smoke-minor-${RUN}@loverlink.test`;
  const minorCode = await requestCode(minorIdentifier, 'minor');

  const thisYear = new Date().getUTCFullYear();
  const minorAttempt = await api<{ error?: { code: string } }>('POST', '/auth/verify', {
    body: {
      identifier: minorIdentifier,
      code: minorCode,
      displayName: 'Too Young',
      dob: `${thisYear - 15}-01-01`,
    },
  });
  check('a 15-year-old is refused', minorAttempt.status === 400, minorAttempt.body);
  check(
    'refused with UNDERAGE, not a generic error',
    minorAttempt.body.error?.code === 'UNDERAGE',
    minorAttempt.body,
  );

  // -- 3. authenticated access ----------------------------------------------
  step('3. profile');
  const profile = await api<{ displayName: string; identifierMasked: string; tier: string }>(
    'GET',
    '/me',
    { token: alice.tokens.accessToken },
  );
  check('alice can read her profile', profile.status === 200, profile.body);
  check('identifier is masked, even to its owner', !profile.body.identifierMasked?.includes(RUN));

  const unauthorised = await api('GET', '/me');
  check('an unauthenticated /me is refused', unauthorised.status === 401);

  const patched = await api<{ displayName: string }>('PATCH', '/me', {
    token: alice.tokens.accessToken,
    body: { displayName: 'Alice Renamed' },
  });
  check('display name updates', patched.body.displayName === 'Alice Renamed', patched.body);

  // -- 4. sessions -----------------------------------------------------------
  step('4. sessions');
  const refreshed = await api<{ accessToken: string; refreshToken: string }>(
    'POST',
    '/auth/refresh',
    { body: { refreshToken: bob.tokens.refreshToken } },
  );
  check('refresh returns a new pair', refreshed.status === 200, refreshed.body);
  check('the refresh token ROTATED', refreshed.body.refreshToken !== bob.tokens.refreshToken);

  const replay = await api('POST', '/auth/refresh', {
    body: { refreshToken: bob.tokens.refreshToken },
  });
  check('replaying the old refresh token fails', replay.status === 401, replay.body);

  const loggedOut = await api('POST', '/auth/logout', { token: alice.tokens.accessToken });
  check('logout succeeds', loggedOut.status === 204, loggedOut.body);

  const afterLogout = await api('GET', '/me', { token: alice.tokens.accessToken });
  check('the access token is dead after logout', afterLogout.status === 401);

  // -- 5. rooms (Phase 2) ----------------------------------------------------
  step('5. rooms');
  // A FRESH actor, deliberately. Reusing a token from the sessions step above
  // would depend on that step's outcome — and the replay test there revokes the
  // session on purpose, which silently killed these checks the first time.
  // Smoke sections should be independent, so a failure points at one thing.
  const roomHost = await registerActor('host', '1990-08-08');
  const bobToken = roomHost.tokens.accessToken;

  const created = await api<{ id: string; slug: string; title: string }>('POST', '/rooms', {
    token: bobToken,
    body: { title: `Smoke Room ${RUN}`, category: 'casual' },
  });
  check('room created', created.status === 201, created.body);
  check('slug derived from the title', created.body.slug?.startsWith('smoke-room'), created.body);

  const listed = await api<{ rooms: { id: string }[] }>('GET', '/rooms', { token: bobToken });
  check(
    'the new room appears in the list',
    listed.body.rooms?.some((r) => r.id === created.body.id),
  );

  const detail = await api<{ memberCount: number }>('GET', `/rooms/${created.body.id}`, {
    token: bobToken,
  });
  check('a freshly created room has nobody in it', detail.body.memberCount === 0, detail.body);

  const roomsUnauthenticated = await api('GET', '/rooms');
  check('the room list requires auth', roomsUnauthenticated.status === 401);

  const badCategory = await api('POST', '/rooms', {
    token: bobToken,
    body: { title: 'Nope', category: 'not-a-category' },
  });
  check('an unknown category is refused', badCategory.status === 400, badCategory.body);

  // Joining, presence and chat need real sockets, so they live in their own
  // check rather than being half-tested over HTTP here.
  process.stdout.write('       (joining, presence and chat: see npm run room-check)\n');

  // -- journeys with their own scripts ---------------------------------------
  //
  // Each of these needs several accounts, live sockets and real timing, and
  // folding them in here would make one failure impossible to locate. They are
  // separate runs, not missing coverage — and claiming "not yet built", as this
  // block did until Phase 5 landed, is exactly the kind of stale statement that
  // makes a green smoke test worth less than nothing.
  step('covered by dedicated checks');
  for (const [journey, command] of [
    ['rooms, presence and chat', 'npm run room-check'],
    ['reporting, review and ban', 'npm run safety-check'],
    ['surprise, DM and 1:1 call', 'npm run ladder-check'],
  ]) {
    process.stdout.write(`  --   ${journey}: ${command}\n`);
  }

  // -- summary ---------------------------------------------------------------
  process.stdout.write(`\n${'-'.repeat(52)}\n`);
  process.stdout.write(`  passed: ${passed}\n  failed: ${failed}\n`);
  if (failures.length > 0) {
    process.stdout.write(`\n  failures:\n${failures.map((f) => `    - ${f}`).join('\n')}\n`);
  }
  process.stdout.write(`${'-'.repeat(52)}\n\n`);

  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  process.stderr.write(
    `\nSmoke test could not run:\n  ${error instanceof Error ? error.message : String(error)}\n\n` +
      `  Is the server running at ${BASE_URL}?\n\n`,
  );
  process.exitCode = 1;
});
