# =============================================================================
# Loverlink API + realtime server.
#
# Built from the REPO ROOT, not from this directory:
#
#     docker build -f apps/server/Dockerfile -t loverlink-api .
#
# because this is an npm workspace and the lockfile lives at the root. Building
# from `apps/server` would resolve a different dependency tree than the one that
# was tested.
# =============================================================================

# ---------------------------------------------------------------------------
# Stage 1 — install and compile
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build

WORKDIR /repo

# Manifests first, so a change to source code does not invalidate the dependency
# layer. This is the difference between a 15-second rebuild and a 3-minute one.
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/

# `npm ci` installs exactly the lockfile — the point of committing one.
# `--ignore-scripts` because a postinstall script from a transitive dependency
# is arbitrary code running in the build, and nothing here needs one.
RUN npm ci --ignore-scripts

COPY tsconfig.base.json ./
COPY apps/server apps/server

RUN npm run build --workspace=@loverlink/server

# ---------------------------------------------------------------------------
# Stage 2 — production dependencies ONLY
# ---------------------------------------------------------------------------
#
# A SEPARATE `npm ci --omit=dev` rather than pruning the build stage's tree.
#
# npm workspaces HOIST everything to the root `node_modules`, so
# `npm prune --workspace=@loverlink/server` prunes a directory that is mostly
# empty and leaves TypeScript, vitest, eslint and their transitive trees exactly
# where they were. The first attempt at this image was 854MB for that reason.
#
# Installing fresh from the same lockfile is unambiguous: what lands here is
# precisely what `dependencies` declares.
FROM node:22-bookworm-slim AS prod-deps

WORKDIR /repo

COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/

# `--workspace` is doing real work here, not tidiness.
#
# Without it, `npm ci --omit=dev` installs the PRODUCTION dependencies of every
# workspace — which put Next.js, React, sharp and livekit-client into this
# backend image: 300MB of frontend code that will never be executed. Scoping the
# install to the server is what makes the image the size of what it runs.
RUN npm ci --omit=dev --ignore-scripts --workspace=@loverlink/server --include-workspace-root  && npm cache clean --force  && mkdir -p /repo/apps/server/node_modules

# ---------------------------------------------------------------------------
# Stage 3 — the image that actually runs
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# Signals Node's own production paths, and is read by config.ts — which REFUSES
# to start on a development secret, a wildcard CORS origin, or an unencrypted
# database connection. Setting it here means a misconfigured deploy fails at
# boot rather than serving traffic insecurely.
ENV NODE_ENV=production

# `dumb-init` gives PID 1 correct signal handling. Without it Node is PID 1 and
# does not forward SIGTERM the way an init system would, so a rolling deploy
# kills connections instead of draining them — and this process is holding live
# voice rooms.
RUN apt-get update \
 && apt-get install -y --no-install-recommends dumb-init \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The node image ships an unprivileged `node` user. Running as root in a
# container is a needless escalation from any RCE to full container control.
COPY --from=prod-deps --chown=node:node /repo/node_modules ./node_modules
COPY --from=prod-deps --chown=node:node /repo/apps/server/node_modules ./apps/server/node_modules
COPY --from=build --chown=node:node /repo/apps/server/dist ./apps/server/dist
COPY --from=build --chown=node:node /repo/apps/server/package.json ./apps/server/package.json

# Migrations are plain SQL read at runtime by the migration runner, so they must
# be in the image — `npm run migrate` is expected to run as a release step
# against the DIRECT database URL. See .env.example.
COPY --from=build --chown=node:node /repo/apps/server/migrations ./apps/server/migrations

USER node

EXPOSE 4000

# Distinct from /readyz on purpose: this asks whether the PROCESS is alive, so a
# database blip does not make the orchestrator kill and restart a server that is
# still holding perfectly good WebSocket connections. Readiness is what should
# gate traffic; liveness should only catch a truly wedged process.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/server/dist/main.js"]
