import { defineConfig } from 'vitest/config';

/**
 * UNIT tests: domain rules + use cases, run against the in-memory fakes.
 *
 * These must stay fast and dependency-free — no Docker, no network, no sleeps.
 * That is the whole point of the memory adapters: if this suite ever needs a
 * container to pass, a vendor concept has leaked into the inner rings.
 *
 * Adapter tests live in vitest.integration.config.ts and are run separately, so
 * `npm run ci` never needs services.
 */
export default defineConfig({
  test: {
    name: 'unit',
    include: ['tests/domain/**/*.test.ts', 'tests/app/**/*.test.ts', 'tests/memory/**/*.test.ts'],
    environment: 'node',
    testTimeout: 10_000,
  },
});
