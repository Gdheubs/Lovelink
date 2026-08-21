import { z } from 'zod';

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Load `.env` into `process.env`, if one exists.
 *
 * WHY NO `dotenv` PACKAGE: Node has done this natively since 20.6, and a
 * dependency whose entire job the runtime already performs is a dependency to
 * audit, update and eventually be surprised by.
 *
 * WHY TWO CANDIDATE PATHS: this is a monorepo, and `.env` lives at the ROOT
 * while the server's own scripts run with a cwd of `apps/server`. Looking only
 * at the cwd means `npm run dev` from the repo root works and
 * `npm run dev --workspace @loverlink/server` silently does not — a difference
 * that presents as "my database settings are being ignored" and costs an hour.
 * So we try the cwd first (a deployment may put `.env` beside the process),
 * then the repo root.
 *
 * WHY IT IS BEST-EFFORT: a missing `.env` is the NORMAL case in production and
 * in CI, where variables come from the environment itself. A malformed file is
 * caught by the validation below, which produces a far more useful message
 * than a parse error would.
 *
 * IMPORTANT: real environment variables always win. `loadEnvFile` does not
 * overwrite values already present, so `PORT=5000 npm run dev` beats whatever
 * `.env` says — which is what anyone typing that expects.
 */
function loadDotEnvIfPresent(): void {
  // src/config.ts -> src -> apps/server -> apps -> <repo root>
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

  for (const candidate of [join(process.cwd(), '.env'), join(repoRoot, '.env')]) {
    try {
      process.loadEnvFile(candidate);
      return;
    } catch {
      // Not there, or unreadable. Try the next one; the schema has the last word.
    }
  }
}

loadDotEnvIfPresent();

/**
 * Environment configuration — validated once, at boot, loudly.
 *
 * WHY THIS EXISTS
 * ---------------
 * The failure mode this prevents is the worst kind: a missing environment
 * variable that is `undefined` for hours, silently disabling something, until a
 * user finds it. Validating the whole environment before the server binds a
 * port converts every one of those into a crash on line one of the deploy log,
 * with a message naming the variable.
 *
 * INVARIANTS
 *  - No secret literal appears anywhere in the codebase. Everything sensitive
 *    arrives through here.
 *  - Nothing else in the codebase reads `process.env`. If you need a setting,
 *    add it to this schema so it is documented, typed, and validated.
 *  - Production refuses to start with development defaults (see the
 *    `superRefine` block at the bottom) — a JWT secret of "dev-secret" that
 *    reaches production is a total authentication bypass.
 */

const PERSISTENCE_MODES = ['memory', 'postgres'] as const;
export type PersistenceMode = (typeof PERSISTENCE_MODES)[number];

/**
 * `memory` mode swaps EVERY adapter for its in-process fake, which is what
 * makes `npm run dev:memory` boot with no Docker. It is not merely a database
 * switch — see /src/adapters/memory.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /** Which family of adapters the composition root wires up. */
  PERSISTENCE: z.enum(PERSISTENCE_MODES).default('memory'),

  // -- HTTP ----------------------------------------------------------------
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  HOST: z.string().default('0.0.0.0'),
  /**
   * Comma-separated list of allowed browser origins.
   * A wildcard is rejected in production: credentials are sent with these
   * requests, and `*` plus credentials is an account-takeover primitive.
   */
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  /** Public base URL, used to build magic links. */
  PUBLIC_WEB_URL: z.string().url().default('http://localhost:3000'),

  // -- realtime ------------------------------------------------------------
  /**
   * When true the Socket.io server is mounted on the API's HTTP server.
   * Set false to run /src/realtime.ts as its own process — the module boundary
   * exists from day one precisely so this is a config change, not a refactor.
   */
  REALTIME_IN_PROCESS: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
  REALTIME_PORT: z.coerce.number().int().min(1).max(65535).default(4001),
  /** Seconds without a heartbeat before presence is reaped. */
  PRESENCE_TTL_SECONDS: z.coerce.number().int().min(10).default(45),
  /** How often the reaper sweeps for ghosts. */
  PRESENCE_REAP_INTERVAL_SECONDS: z.coerce.number().int().min(5).default(15),

  // -- auth ----------------------------------------------------------------
  /** HMAC key for access tokens. Must be >= 32 chars; production rejects defaults. */
  JWT_SECRET: z.string().min(16).default('dev-only-insecure-secret-change-me'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).default(900),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(3600)
    .default(60 * 60 * 24 * 30),
  /**
   * In development the login code is returned in the API response and logged,
   * so signup works with no SMS/email provider. MUST be false in production —
   * it hands every account to anyone who knows a phone number.
   */
  AUTH_ECHO_CODE: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),

  // -- postgres ------------------------------------------------------------
  DATABASE_URL: z.string().default('postgres://loverlink:loverlink@localhost:5432/loverlink'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).default(10),

  // -- redis ---------------------------------------------------------------
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // -- livekit -------------------------------------------------------------
  /** Browser-facing websocket URL, e.g. wss://media.example.com. */
  LIVEKIT_URL: z.string().default('ws://localhost:7880'),
  LIVEKIT_API_KEY: z.string().default('devkey'),
  LIVEKIT_API_SECRET: z.string().default('devsecretdevsecretdevsecret1234'),
  /** How long a media token stays valid. Short: they are re-issued on promotion. */
  LIVEKIT_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).default(3600),

  // -- moderation ----------------------------------------------------------
  /**
   * Comma-separated user ids with moderator powers.
   * A config allowlist rather than a database role — see rules/moderation.ts
   * for why that is deliberate.
   */
  MODERATOR_USER_IDS: z.string().default(''),
  /** Shared secret for the server-rendered admin pages. */
  ADMIN_TOKEN: z.string().default('dev-admin-token'),

  // -- observability -------------------------------------------------------
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  /** Pretty-print logs. Off in production, where they are shipped as JSON. */
  LOG_PRETTY: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
});

export type RawConfig = z.infer<typeof schema>;

export interface Config extends RawConfig {
  readonly corsOrigins: readonly string[];
  readonly moderatorUserIds: readonly string[];
  readonly isProduction: boolean;
  readonly isTest: boolean;
}

/** Values that must never survive into production. */
const INSECURE_DEFAULTS = {
  JWT_SECRET: 'dev-only-insecure-secret-change-me',
  ADMIN_TOKEN: 'dev-admin-token',
  LIVEKIT_API_SECRET: 'devsecretdevsecretdevsecret1234',
} as const;

class ConfigError extends Error {
  constructor(problems: readonly string[]) {
    super(
      [
        'Invalid environment configuration. The server will not start.',
        ...problems.map((p) => `  - ${p}`),
        '',
        'See .env.example for the full list of supported variables.',
      ].join('\n'),
    );
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);

  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new ConfigError(problems);
  }

  const raw = parsed.data;
  const isProduction = raw.NODE_ENV === 'production';
  const problems: string[] = [];

  if (isProduction) {
    for (const [key, insecure] of Object.entries(INSECURE_DEFAULTS)) {
      if (raw[key as keyof typeof INSECURE_DEFAULTS] === insecure) {
        problems.push(`${key} is still set to its development default. Set a real secret.`);
      }
    }
    if (raw.JWT_SECRET.length < 32) {
      problems.push('JWT_SECRET must be at least 32 characters in production.');
    }
    if (raw.AUTH_ECHO_CODE) {
      problems.push(
        'AUTH_ECHO_CODE must be false in production — it returns login codes to the caller.',
      );
    }
    if (raw.PERSISTENCE === 'memory') {
      problems.push('PERSISTENCE=memory loses all data on restart and cannot run in production.');
    }
    if (raw.CORS_ORIGINS.includes('*')) {
      problems.push('CORS_ORIGINS must not contain a wildcard in production.');
    }
  }

  if (problems.length > 0) {
    throw new ConfigError(problems);
  }

  const splitList = (value: string): readonly string[] =>
    value
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

  return Object.freeze({
    ...raw,
    corsOrigins: splitList(raw.CORS_ORIGINS),
    moderatorUserIds: splitList(raw.MODERATOR_USER_IDS),
    isProduction,
    isTest: raw.NODE_ENV === 'test',
  });
}
