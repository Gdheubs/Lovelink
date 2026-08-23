# ADR 0008 — Managed platform topology: Supabase, Vercel, Cloudflare, R2

**Status:** accepted · **Date:** 2026-08-22 · **Supersedes the deployment half of** [0005](./0005-realtime-in-process-first.md)

## Context

The original plan was a single VPS running Docker Compose: Postgres, Redis,
LiveKit and the API in containers, behind Cloudflare. That is still what
`docker-compose.yml` describes and what local development uses.

The deployment target has changed to managed services:

| Concern | Platform | Reason given |
| --- | --- | --- |
| Database | Supabase Postgres | Postgres + Auth + RLS + Realtime + pgvector |
| Web app | Vercel | Next.js host |
| CDN / DNS / WAF | Cloudflare | Global network, security, caching |
| Large media | Cloudflare R2 | Object storage for video |
| Video processing | Dedicated workers | FFmpeg + queue |
| Cache, rate limits | Redis | Feed, cache, rate limiting at scale |

## Decision

### The process split

**Vercel hosts the web app only.** The API and realtime server run as a
long-lived container elsewhere (Fly, Railway, Render, or a VPS).

This is not a preference. The realtime server holds thousands of open
WebSockets, keeps a Socket.io adapter subscribed to Redis, and runs the room
scheduler on an interval. Serverless functions are request-scoped and have no
place to keep any of that. Attempting it produces a product where voice rooms
disconnect every few minutes for reasons nobody can reproduce.

### Supabase provides Postgres, not the application's identity model

We use Supabase for **Postgres and pgvector**. We do **not** adopt Supabase Auth
or Supabase Realtime, and RLS is a backstop rather than the authorization model.

- **Auth** already exists here: JWT access tokens, refresh-token rotation with
  replay detection that revokes the session family, an 18+ gate at registration,
  and a single endpoint for login-or-signup so the client cannot ask whether an
  account exists. Replacing it means rebuilding those properties on someone
  else's primitives and re-earning the tests.
- **Realtime** is Socket.io with a typed event catalogue, a per-socket queue
  that preserves event ordering, full-snapshot reconnects, and presence in three
  Redis structures so departures are *announced* rather than silently expiring.
  Supabase Realtime broadcasts database changes; it does not do any of that.
- **RLS** is enabled on every personal table with **no permissive policies**
  (migration 0005). The API connects as the owner and bypasses it, so nothing
  changes at runtime. What it buys is a closed door if anything else ever
  connects with user credentials — the SQL editor, a leaked anon key, a future
  PostgREST client.

### Connection modes are not interchangeable

The running app uses the **transaction pooler** (`:6543`); migrations use the
**direct connection**. `db.ts` detects the pooler from the port and logs it.

### Object storage is presigned, never proxied

`ObjectStore` issues presigned URLs; bytes go straight from client to R2 and
never enter the API process.

### The queue is a port with no adapter yet

`JobQueue` exists so the video pipeline has a boundary to be built against.
Nothing enqueues a job today.

## Rationale

**Why not put authorization in RLS.** The trust ladder is pure domain code
(ADR 0004) so that one rule governs the socket edge, the REST edge and the
tests. Expressing it again in SQL would create two authorities that must agree
forever, and they would not — the ladder involves overlapping room sessions, a
per-streak freeze, ban projections and rate limits, none of which a policy can
see. Worse, the failure is invisible: a policy returning zero rows is
indistinguishable from "there is nothing there".

**Why RLS at all, then.** Because Supabase's default shape is a browser talking
to Postgres. The day someone enables PostgREST or leaks an anon key, "no policy"
means "no access" instead of "everything". It costs nothing and closes a door
that is otherwise open by default.

**Why keep our own auth when Supabase Auth is right there.** The properties that
matter here are not the ones a generic auth service optimises for: the 18+ gate
is a domain rule with its own tests, the ladder needs a `User` with a trust score
on every socket event, and refresh rotation with family revocation is already
built and exercised. Adopting Supabase Auth would mean a session model that does
not know about bans, plus a migration of live accounts, to solve a problem that
is solved.

**Why R2 rather than Supabase Storage.** Egress. R2 charges none, and video is
the one thing here that would generate a lot of it. It is also already behind
the CDN we are using.

**Why Redis stays.** Supabase provides no Redis, and Redis is doing four things
nothing else does: presence with explicit expiry, atomic rate-limit counters, the
Socket.io adapter's cross-process fan-out, and the room chat ring buffer. Managed
Redis (Upstash, Redis Cloud) is a connection-string change.

**Why `pgvector` is enabled with nothing using it.** Enabling an extension on a
database with live traffic is a lock nobody wants to take by surprise. What it is
*for* is a separate decision: the obvious use — embedding what people say in
rooms — would mean storing a representation of conversations this product
deliberately does not keep (ADR 0006), so it needs its own ADR, not a migration.

## Consequences

- **Good:** no Postgres, Redis or backup infrastructure to operate.
- **Good:** the domain and application rings are untouched by all of this. The
  entire change is config, two adapters, and the composition root — which is the
  claim ADR 0001 makes, now tested by a real platform migration.
- **Cost:** three places to deploy instead of one, and the web app and API can
  now be at different versions. The API is versioned by its route contract; a
  breaking change needs both deployed together.
- **Cost:** the transaction pooler forbids session state — `LISTEN/NOTIFY`,
  session `SET`, advisory locks across statements. Nothing uses them today and
  `db.ts` says so, but a future change could break in production only.
- **Cost:** `docker-compose.yml` is now local-development-only. It is no longer
  the production topology and must not be read as one.
- **Unresolved:** LiveKit still needs a host. LiveKit Cloud is the obvious
  answer and is a config change (`LIVEKIT_URL` plus credentials); self-hosting it
  next to the API is the alternative.
