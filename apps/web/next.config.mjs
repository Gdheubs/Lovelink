/** @type {import('next').NextConfig} */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// This machine has stray lockfiles above the repo, and Next infers the
// workspace root from the nearest one it finds. Pinning it stops the build
// from tracing files outside the project into the deployment bundle.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const nextConfig = {
  outputFileTracingRoot: repoRoot,
  reactStrictMode: true,
  // The API is a separate origin, so nothing is proxied here. Keeping the
  // boundary explicit means the browser's CORS behaviour in development matches
  // production, rather than being hidden by a dev-only rewrite that then fails
  // on deploy.
  poweredByHeader: false,
  eslint: {
    // Linting is the monorepo's job (npm run lint), not the build's.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
