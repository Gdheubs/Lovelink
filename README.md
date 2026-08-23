# Loverlink

A voice-first digital third place. Themed drop-in rooms where you join as a
silent listener, raise a hand to speak, and build trust progressively —
text → voice → DM → 1:1 call. 18+ only, safety-forward.

---

## Quick start (no Docker, no accounts, no services)

```bash
npm install
npm run dev:memory
```

That boots the API and the realtime server with **every** dependency replaced by
an in-process fake — no Postgres, no Redis, no LiveKit, no SMS provider. Login
codes are printed to the terminal.

```bash
curl http://127.0.0.1:4000/healthz
```

> **Note:** the server binds `0.0.0.0`. If something else on your machine is
> already listening on port 4000 over IPv6, `localhost` may reach that instead —
> use `127.0.0.1`, or set `PORT` to something free.

This is not a demo mode. It is the whole product, and it is how the boundaries
described in [`docs/architecture.md`](docs/architecture.md) are proven rather
than merely asserted.

## Running against real services

```bash
cp .env.example .env          # then edit
docker compose up -d          # postgres + redis
npm run migrate               # apply the schema
PERSISTENCE=postgres npm run dev
```

Add voice (Phase 3 onward):

```bash
docker compose --profile media up -d   # + livekit + coturn
```

## Commands

| Command                    | What it does                                          |
| -------------------------- | ----------------------------------------------------- |
| `npm run dev:memory`       | Boot with in-memory adapters. Zero external services. |
| `npm run dev`              | Boot against real adapters (needs Compose up).        |
| `npm run ci`               | format check → lint → typecheck → unit tests.         |
| `npm run test:unit`        | Domain, use cases, memory fakes. Fast, no containers. |
| `npm run test:integration` | One suite per adapter, against real Docker services.  |
| `npm run smoke`            | Full user journey against a running server.           |
| `npm run migrate`          | Apply pending SQL migrations.                         |
| `npm run migrate:status`   | Show applied / pending / drifted migrations.          |
| `npm run lint`             | ESLint, including the architecture boundary rules.    |
| `npm run format`           | Prettier, write.                                      |

## Build status

| Phase | Scope                                                     | State                |
| ----- | --------------------------------------------------------- | -------------------- |
| 0     | Skeleton, ports, memory fakes, migrations, CI             | done                 |
| 1     | Identity: signup with 18+ gate, login, sessions, profiles | done (backend + web) |
| 2     | Rooms with text chat, presence, reconnect                 | next                 |
| 3     | Voice via LiveKit                                         |                      |
| 4     | Safety and moderation                                     |                      |
| 5     | Surprises and the trust ladder                            |                      |
| 6     | Retention and polish                                      |                      |

See [docs/architecture.md](docs/architecture.md#6-build-order) for the exit
criteria of each phase.

## Layout

```
apps/
  server/               API + realtime
    src/
      domain/           ring 1 — pure. entities, values, rules, ports
      app/              ring 2 — use cases, one file each
      adapters/         ring 3 — the ONLY place vendor SDKs appear
        memory/           an in-process fake for every port
        postgres/  redis/  livekit/  socketio/  http/
        push/  storage/  scheduler/  observability/
      config.ts         env validation; fails loudly at boot
      container.ts      adapter selection — the only branch on PERSISTENCE
      main.ts           composition root (API + optional in-process realtime)
      realtime.ts       standalone realtime entry point
    migrations/         numbered, hand-written SQL
    tests/              domain/ · app/ · memory/ · adapters/ · socket/
  web/                  Next.js PWA (deploys to Vercel)
docs/
  architecture.md       the contract — read this first
  adr/                  one record per significant decision
docker-compose.yml      LOCAL DEVELOPMENT ONLY — not the production topology
```

## Where it runs

| Piece | Platform | Why |
| --- | --- | --- |
| Web app | Vercel | Next.js |
| API + realtime | A container — Fly, Railway, Render, VPS | Holds thousands of open WebSockets and runs the scheduler. **Cannot be serverless.** |
| Postgres | Supabase (`:6543` pooler; `:5432` for migrations) | Managed Postgres + pgvector |
| Redis | Managed (Upstash / Redis Cloud) | Presence, rate limits, socket fan-out, chat buffer |
| DNS · WAF · CDN | Cloudflare | Origin locked to Cloudflare ranges |
| Large media | Cloudflare R2 | Presigned uploads; bytes never touch the API |
| Voice | LiveKit Cloud or self-hosted | |

Supabase supplies **Postgres, not the identity model** — this app keeps its own
auth and its own realtime, and RLS is a backstop with no permissive policies.
The reasoning is in [ADR 0008](docs/adr/0008-managed-platform-topology.md).

## The one rule

**No third-party SDK may be imported outside an adapter.**

`apps/server/src/domain` and `apps/server/src/app` may not import `pg`,
`ioredis`, `socket.io`, `fastify`, `livekit-server-sdk`, `pino`, or any
I/O-capable Node built-in. If you need one, define a port in
`domain/ports/` and implement it in `adapters/`.

This is enforced by ESLint (`npm run lint`), not by convention.

## Where to start reading

1. [`docs/architecture.md`](docs/architecture.md) — the whole design.
2. `apps/server/src/domain/ports/` — what the system needs from the world, and
   why. Every port explains the invariant it protects.
3. `apps/server/src/domain/rules/trustLadder.ts` — the safety model, in one
   file, as pure functions.
4. `apps/server/src/main.ts` — how it is all wired together.
