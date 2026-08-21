// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Packages that may NEVER be imported from the domain or application rings.
 * This list is the mechanical enforcement of the Prime Directive in
 * /docs/architecture.md §2: vendor SDKs live in adapters, behind ports.
 *
 * Adding an entry here is cheap; removing one requires an ADR.
 */
const VENDOR_PACKAGES = [
  'pg',
  'postgres',
  'ioredis',
  'redis',
  'socket.io',
  'socket.io-client',
  'fastify',
  'livekit-server-sdk',
  'livekit-client',
  'jsonwebtoken',
  'jose',
  'pino',
  'nodemailer',
  'twilio',
  'next',
  'react',
];

/** Node built-ins the inner rings must not reach for either (they smuggle in I/O). */
const NODE_IO_BUILTINS = [
  'fs',
  'node:fs',
  'fs/promises',
  'node:fs/promises',
  'net',
  'node:net',
  'http',
  'node:http',
  'https',
  'node:https',
  'dns',
  'node:dns',
  'child_process',
  'node:child_process',
  'worker_threads',
  'node:worker_threads',
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      'legacy/**',
      'index.html',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      // Inner rings must not print. Adapters and scripts override this below.
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
    },
  },

  // ---------------------------------------------------------------------------
  // RING 1 — DOMAIN. Pure TypeScript. No npm packages, no I/O, no outward imports.
  // ---------------------------------------------------------------------------
  {
    files: ['apps/server/src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [...VENDOR_PACKAGES, ...NODE_IO_BUILTINS].map((name) => ({
            name,
            message:
              'Domain layer must not import vendor packages or I/O. Define a port in domain/ports instead.',
          })),
          patterns: [
            {
              group: ['**/adapters/**', '**/app/**', '../app/*', '../adapters/*'],
              message:
                'Domain must not import from outer rings. Dependencies point inward only.',
            },
          ],
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // RING 2 — APPLICATION. May import domain. May NOT import adapters or vendors.
  // ---------------------------------------------------------------------------
  {
    files: ['apps/server/src/app/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [...VENDOR_PACKAGES, ...NODE_IO_BUILTINS].map((name) => ({
            name,
            message:
              'Application layer must not import vendor packages or I/O. Depend on a port from domain/ports instead.',
          })),
          patterns: [
            {
              group: ['**/adapters/**', '../adapters/*'],
              message:
                'Use cases must not import adapters. Receive ports via constructor injection.',
            },
          ],
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // Composition root and adapters: vendor imports are expected here.
  // ---------------------------------------------------------------------------
  {
    files: ['apps/server/src/main.ts', 'apps/server/src/realtime.ts', 'apps/server/src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    files: ['apps/server/src/adapters/**/*.ts', 'apps/server/src/observability/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['apps/server/tests/**/*.ts', 'apps/server/scripts/**/*.ts'],
    rules: { 'no-console': 'off', '@typescript-eslint/no-explicit-any': 'off' },
  },
);
