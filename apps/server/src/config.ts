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
  /**
   * Trust `x-forwarded-for` / `cf-connecting-ip` to name the real client.
   *
   * ONLY SAFE WHEN THE ORIGIN IS LOCKED. Behind Cloudflare with the origin
   * firewalled to Cloudflare's ranges, these headers are authoritative because
   * Cloudflare overwrites them. On a directly reachable origin they are
   * attacker-controlled, and trusting them lets anyone evade every per-IP rate
   * limit by sending a different value each request.
   *
   * Defaults to false so the unsafe configuration is the one you have to ask
   * for.
   */
  TRUST_PROXY: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),

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

  // -- postgres (Supabase in production) ------------------------------------
  /*
   * Supabase offers three connection strings and they are NOT interchangeable.
   *
   *   :5432 direct        one real session per connection. Use for MIGRATIONS.
   *   :5432 pooler        session mode.
   *   :6543 pooler        TRANSACTION mode. Use for the RUNNING APP.
   *
   * Transaction mode is what lets a container hold a small pool while Supabase
   * multiplexes it across far more backends. Nothing in this codebase depends
   * on session state (see db.ts), so it is safe — and the adapter detects the
   * port and says so at boot.
   *
   * Migrations want the DIRECT connection: DDL in transaction mode is fine, but
   * a migration is exactly the kind of long single-session operation pooling is
   * bad at, and a failure halfway through a schema change is not worth saving a
   * connection over.
   */
  DATABASE_URL: z.string().default('postgres://loverlink:loverlink@localhost:5432/loverlink'),
  /** Direct (non-pooled) URL, used only by the migration runner. Falls back to DATABASE_URL. */
  DATABASE_DIRECT_URL: z.string().default(''),
  /*
   * Pool size.
   *
   * Small on purpose behind a transaction pooler: the pooler is what provides
   * concurrency, and a large per-container pool just holds backends idle.
   */
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).default(10),
  /**
   * Require TLS to the database.
   *
   * Defaults to off, because the local container has no certificate. Managed
   * Postgres is reached across the public internet, so production refuses to
   * start without it — see the superRefine block below.
   */
  DATABASE_SSL: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  /**
   * Verify the database's certificate.
   *
   * Should be true. It exists as a setting only because some managed providers
   * present a self-signed certificate on the pooler endpoint, and being unable
   * to connect at all is worse than an unverified-but-encrypted channel. Turning
   * it off is a deliberate, visible choice rather than a silent default.
   */
  DATABASE_SSL_REJECT_UNAUTHORIZED: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),

  // -- object storage (Cloudflare R2) --------------------------------------
  /*
   * R2 is S3-compatible, so this is the ordinary S3 quartet plus an endpoint.
   * All optional: no bucket configured means the object-store port reports
   * itself unavailable and nothing that needs it is offered.
   */
  R2_ACCOUNT_ID: z.string().default(''),
  R2_ACCESS_KEY_ID: z.string().default(''),
  R2_SECRET_ACCESS_KEY: z.string().default(''),
  R2_BUCKET: z.string().default(''),
  /** Public base URL for objects, if the bucket is served through a domain. */
  R2_PUBLIC_BASE_URL: z.string().default(''),

  // -- redis ---------------------------------------------------------------
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // -- livekit -------------------------------------------------------------
  /** Browser-facing websocket URL, e.g. wss://media.example.com. */
  LIVEKIT_URL: z.string().default('ws://localhost:7880'),
  LIVEKIT_API_KEY: z.string().default('devkey'),
  LIVEKIT_API_SECRET: z.string().default('devsecret-devsecret-devsecret-32'),
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

  /*
   * WEB PUSH (VAPID).
   *
   * All three are optional and default to empty, because a deployment with no
   * push is a SUPPORTED state — local development has no keys, and every
   * feature must keep working without them. `pushConfig()` below is what turns
   * "all three present" into a usable configuration and anything else into
   * "push is off".
   *
   * Generate a pair with:  npx web-push generate-vapid-keys
   *
   * VAPID_SUBJECT is not decoration: it is how a push service reaches a human
   * when a deployment misbehaves, instead of simply blocking it.
   */
  VAPID_PUBLIC_KEY: z.string().default(''),
  VAPID_PRIVATE_KEY: z.string().default(''),
  VAPID_SUBJECT: z.string().default(''),

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
  LIVEKIT_API_SECRET: 'devsecret-devsecret-devsecret-32',
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

    /*
     * TLS is required when the database is reached across the PUBLIC INTERNET —
     * which is the case for Supabase, Neon, RDS and anything else managed.
     * Without it every row on the wire is in clear: identifiers, DM text, the
     * trust ledger. The failure is silent, because everything works.
     *
     * It is NOT required when the host is private — a container on the same
     * network, or a VPS running both. Demanding TLS there would be theatre that
     * blocks a legitimate topology, and the original Docker Compose deployment
     * is still one.
     *
     * The test is the HOST, not a flag, so nobody has to remember which case
     * they are in.
     */
    if (!raw.DATABASE_SSL && !isPrivateHost(hostOf(raw.DATABASE_URL))) {
      problems.push(
        'DATABASE_SSL must be true when the database is not on a private network: ' +
          'credentials and every row would cross the public internet in clear.',
      );
    }

    /*
     * Refuse a database URL that is obviously still pointing at a local
     * container. The alternative is a deploy that starts cleanly, fails every
     * request, and looks like a network problem.
     */
    if (/(^|@)(localhost|127\.0\.0\.1)/.test(raw.DATABASE_URL)) {
      problems.push('DATABASE_URL still points at localhost.');
    }
    if (/(^|\/\/)(localhost|127\.0\.0\.1)/.test(raw.REDIS_URL)) {
      problems.push('REDIS_URL still points at localhost.');
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

/**
 * The hostname from a connection string, or empty when it cannot be parsed.
 *
 * `postgres://` is not a scheme `URL` special-cases, but it parses well enough
 * for the hostname, which is all this needs.
 */
function hostOf(connectionString: string): string {
  try {
    return new URL(connectionString).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Whether a host is somewhere traffic never leaves a trusted network.
 *
 * Deliberately conservative: anything this cannot positively identify as
 * private is treated as public, so the failure mode is "asked for TLS you did
 * not strictly need" rather than "shipped credentials in clear".
 *
 * A bare name with no dots — `postgres`, `loverlink-postgres`, `db` — is a
 * container or a service on an internal network, because a public hostname is
 * always qualified.
 */
function isPrivateHost(host: string): boolean {
  if (host.length === 0) return false;

  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  if (host.startsWith('127.') || host.startsWith('10.')) return true;
  if (host.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (host.endsWith('.internal') || host.endsWith('.local')) return true;
  // Fly.io's private network.
  if (host.endsWith('.flycast') || host.endsWith('.internal')) return true;

  // No dot at all: a container or service name, not a public host.
  return !host.includes('.');
}

/** True for errors we deliberately produced, false for genuine bugs. */