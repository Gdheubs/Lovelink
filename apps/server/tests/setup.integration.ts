import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Load `.env` before any integration suite reads `process.env`.
 *
 * WHY THIS FILE HAD TO EXIST
 * --------------------------
 * It was added after the adapter suites were found to be skipping SILENTLY on a
 * machine where Postgres and Redis were both up and healthy.
 *
 * The cause: `tests/adapters/support.ts` falls back to `localhost:5432` when
 * `DATABASE_URL` is unset, and vitest — unlike the server, which calls
 * `process.loadEnvFile()` in config.ts — never loaded `.env`. This project runs
 * Postgres on 5433 precisely because the developer's machine already had
 * something on 5432. So the probe connected to the wrong database (or to
 * nothing), `postgresAvailable()` returned false, and thirty-six assertions
 * reported as "skipped" in green text.
 *
 * That is the worst possible failure mode for a test harness: it looks like it
 * ran. The skip-if-unreachable rule in support.ts is still right — a newcomer
 * without Docker should not see red — but it is only safe if the probe is
 * pointed at the database the project actually configured.
 *
 * Real environment variables still win, exactly as in config.ts: CI sets them
 * directly and there is no `.env` there at all.
 */
function loadDotEnvIfPresent(): void {
  // tests/ -> apps/server -> apps -> <repo root>
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

  for (const candidate of [join(process.cwd(), '.env'), join(repoRoot, '.env')]) {
    try {
      process.loadEnvFile(candidate);
      return;
    } catch {
      // Not there, or unreadable. Try the next one; the suites probe anyway.
    }
  }
}

loadDotEnvIfPresent();
