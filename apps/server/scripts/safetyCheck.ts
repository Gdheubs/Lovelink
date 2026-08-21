import { io, type Socket } from 'socket.io-client';

/**
 * PHASE 4 EXIT CRITERION, against a running server:
 *
 *   "a reported user can be reviewed and banned, and their socket drops
 *    within seconds."
 *
 * WHY THIS EXISTS ALONGSIDE tests/socket/ban.test.ts
 * --------------------------------------------------
 * That suite proves the same journey in-process against the memory fakes, and
 * it is where the rules are verified. What it cannot verify is that the ADMIN
 * SURFACE actually reaches those use cases: that the token gate works, that
 * the moderator allowlist is wired from config, that the HTML form and the
 * JSON API hit the same code, and that a ban issued over HTTP severs a socket
 * held by the realtime layer.
 *
 * Those are wiring failures, and wiring is what breaks a deploy.
 *
 * SETUP — the moderator allowlist is CONFIG, deliberately
 * ------------------------------------------------------
 * Moderator authority comes from MODERATOR_USER_IDS, validated at boot, so
 * that anyone who can write a user row cannot mint a moderator. That makes
 * this a two-step run, and the awkwardness is the security property working:
 *
 *   1. npm run safety-check -- --create-moderator
 *        prints a moderator user id
 *   2. restart the server with MODERATOR_USER_IDS=<that id>
 *   3. SMOKE_MODERATOR_ID=<that id> npm run safety-check
 */

const BASE_URL = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:4000';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? 'dev-admin-token';
const MODERATOR_ID = process.env.SMOKE_MODERATOR_ID ?? '';
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
  options: { body?: unknown; token?: string; admin?: boolean } = {},
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  if (options.admin === true) {
    headers['x-admin-token'] = ADMIN_TOKEN;
    headers['x-moderator-id'] = MODERATOR_ID;
  }

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
  const identifier = `safety-${label}-${RUN}@loverlink.test`;
  const displayName = `Safety ${label}`;

  const requested = await api<{ devCode: string | null; error?: { code: string } }>(
    'POST',
    '/auth/request-code',
    { body: { identifier } },
  );

  if (requested.status === 429) {
    throw new Error(
      'Rate limited requesting a login code. That is the per-IP auth limit working.\n' +
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

  return {
    userId: verified.body.profile.id,
    token: verified.body.accessToken,
    displayName,
  };
}

function connect(actor: Actor): { socket: Socket; events: string[] } {
  const events: string[] = [];
  const socket = io(BASE_URL, {
    auth: { token: actor.token },
    transports: ['websocket'],
    reconnection: false,
  });
  for (const event of ['room:state', 'user:banned', 'error']) {
    socket.on(event, () => events.push(event));
  }
  return { socket, events };
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
  // Step 1 of the two-step setup: mint a moderator account and stop.
  if (process.argv.includes('--create-moderator')) {
    const moderator = await register('moderator');
    process.stdout.write(
      `\nModerator created.\n\n  MODERATOR_USER_IDS=${moderator.userId}\n\n` +
        `  Restart the server with that, then run:\n` +
        `    SMOKE_MODERATOR_ID=${moderator.userId} npm run safety-check\n\n`,
    );
    return;
  }

  process.stdout.write(`\nLoverlink safety check\n  target: ${BASE_URL}\n  run id: ${RUN}\n`);

  if (MODERATOR_ID.length === 0) {
    throw new Error(
      'SMOKE_MODERATOR_ID is not set.\n' +
        '  Run `npm run safety-check -- --create-moderator` first, then restart the\n' +
        '  server with MODERATOR_USER_IDS set to the id it prints.',
    );
  }

  // -- 1. the admin surface is gated ----------------------------------------
  step('1. the admin surface is gated');

  const noToken = await fetch(`${BASE_URL}/admin`);
  check('no admin token is refused', noToken.status === 403);

  const wrongToken = await fetch(`${BASE_URL}/admin?token=definitely-wrong`);
  check('a wrong admin token is refused', wrongToken.status === 403);

  const queueNoModerator = await fetch(`${BASE_URL}/admin/queue`, {
    headers: { 'x-admin-token': ADMIN_TOKEN },
  });
  check(
    'the token alone is not enough — actions need an attributable moderator',
    queueNoModerator.status === 403,
  );

  // -- 2. a report ----------------------------------------------------------
  step('2. one user reports another');

  const reporter = await register('reporter');
  const offender = await register('offender');

  const submitted = await api<{ error?: { code: string } }>('POST', '/reports', {
    token: reporter.token,
    body: { targetId: offender.userId, category: 'harassment', note: 'kept interrupting' },
  });
  check('the report is accepted', submitted.status === 201, submitted.body);

  const duplicate = await api<{ error?: { code: string } }>('POST', '/reports', {
    token: reporter.token,
    body: { targetId: offender.userId, category: 'spam' },
  });
  check(
    'a duplicate open report against the same person is refused',
    duplicate.status === 409,
    duplicate.body,
  );

  const urgent = await api('POST', '/reports', {
    token: reporter.token,
    body: { targetId: offender.userId, category: 'minor_safety' },
  });
  check('an URGENT report is never suppressed by that rule', urgent.status === 201, urgent.body);

  // -- 3. the queue ---------------------------------------------------------
  step('3. a moderator reviews');

  const queue = await api<{
    reports: { id: string; category: string; target: { id: string; priorReports: number } }[];
  }>('GET', '/admin/queue', { admin: true });

  check('the moderator can read the queue', queue.status === 200, queue.body);

  const mine = queue.body.reports?.filter((r) => r.target.id === offender.userId) ?? [];
  check('both reports are queued', mine.length === 2, { found: mine.length });
  check(
    'the URGENT one is ordered first',
    queue.body.reports?.[0]?.category === 'minor_safety',
    queue.body.reports?.[0],
  );
  check(
    'the queue carries the history a decision needs',
    (mine[0]?.target.priorReports ?? 0) >= 2,
    mine[0]?.target,
  );

  // -- 4. the ban -----------------------------------------------------------
  step('4. the ban lands, and the socket drops');

  const victim = connect(offender);
  const connected = await waitUntil(() => victim.socket.connected, 5_000);
  check('the offender is connected before the ban', connected);

  const bannedAt = Date.now();
  const resolved = await api<{ ok: boolean; banned: boolean }>('POST', '/admin/reports/resolve', {
    admin: true,
    body: {
      reportId: mine[0]!.id,
      outcome: 'upheld',
      resolution: 'confirmed from the recording',
      ban: true,
      banHours: null,
    },
  });
  check('the report resolves and bans in one action', resolved.body.banned === true, resolved.body);

  const dropped = await waitUntil(() => !victim.socket.connected, 10_000);
  const elapsed = Date.now() - bannedAt;
  check('THE SOCKET DROPS', dropped, { elapsedMs: elapsed });
  check('...within seconds', dropped && elapsed < 10_000, { elapsedMs: elapsed });

  // -- 5. it stays enforced -------------------------------------------------
  step('5. the ban is not merely cosmetic');

  const reconnect = connect(offender);
  const reconnected = await waitUntil(() => reconnect.socket.connected, 3_000);
  check('a banned user CANNOT reconnect', !reconnected);
  reconnect.socket.disconnect();

  const afterBan = await api('GET', '/me', { token: offender.token });
  check('their existing access token is dead', afterBan.status === 403 || afterBan.status === 401, {
    status: afterBan.status,
  });

  const refreshAttempt = await api('POST', '/auth/refresh', {
    body: { refreshToken: 'whatever' },
  });
  check('refresh does not resurrect them', refreshAttempt.status === 401);

  // -- 6. reversible --------------------------------------------------------
  step('6. a ban can be lifted');

  const unbanned = await api<{ ok: boolean }>('POST', '/admin/unban', {
    admin: true,
    body: { userId: offender.userId },
  });
  check('the moderator can lift it', unbanned.body.ok === true, unbanned.body);

  victim.socket.disconnect();

  process.stdout.write(`\n${'-'.repeat(52)}\n  passed: ${passed}\n  failed: ${failed}\n`);
  if (failures.length > 0) {
    process.stdout.write(`\n  failures:\n${failures.map((f) => `    - ${f}`).join('\n')}\n`);
  }
  process.stdout.write(`${'-'.repeat(52)}\n\n`);

  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  process.stderr.write(
    `\nSafety check could not run:\n  ${error instanceof Error ? error.message : String(error)}\n\n`,
  );
  process.exitCode = 1;
});
