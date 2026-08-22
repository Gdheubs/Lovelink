import { defineConfig } from 'vitest/config';

/**
 * INTEGRATION tests: one suite per adapter, run against the real services from
 * docker-compose (Postgres, Redis, LiveKit).
 *
 * Each suite skips itself when its service is unreachable rather than failing,
 * so a contributor without Docker can still run `npm run ci` — but the suites
 * are NOT optional in CI, where the services are started first. The distinction
 * is deliberate: a green local run should never depend on infrastructure a
 * newcomer has not set up, and a green CI run should never skip the tests that
 * prove the adapters actually satisfy their ports.
 */
export default defineConfig({
  test: {
    name: 'integration',
    include: ['tests/adapters/**/*.test.ts'],
    // Loads .env so the reachability probes target the database this project
    // is configured for, rather than whatever happens to be on the default
    // port. See the file for the silent-skip incident that prompted it.
    setupFiles: ['tests/setup.integration.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Adapters share real databases; parallel files would fight over state.
    fileParallelism: false,
  },
});
