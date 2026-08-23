# Loverlink Architecture

> This document is the contract. It is kept current as the code changes — if a
> statement here is false, that is a bug in one of the two.

## 1. What we are building

A voice-first "digital third place": themed drop-in rooms (study/focus,
late-night talk) where users join as **silent listeners by default**, raise a
hand to speak, and build trust progressively (text → voice → DM → 1:1 call).
Includes an async "surprise gifting" icebreaker — send a coded surprise message
to someone you met. **18+ only, safety-forward.**

**Out of scope for now:** video, payments/gifting monetization, native mobile
apps, multi-language, recommendation algorithms.

---

## 2. The prime directive: dependency-free core

**No third-party service or SDK may be imported anywhere except inside an
adapter.**

```
┌────────────────────────────────────────────┐
│  ADAPTERS (outer ring)                     │
│  livekit, redis, postgres, socketio,       │
│  http (fastify), observability, memory     │
│  ┌──────────────────────────────────────┐  │
│  │  APPLICATION SERVICES (middle ring)  │  │
│  │  use cases: JoinRoom, RaiseHand,     │  │
│  │  SendSurprise, SubmitReport, ...     │  │
│  │  ┌────────────────────────────────┐  │  │
│  │  │  DOMAIN (inner ring)           │  │  │
│  │  │  entities, rules, ports        │  │  │
│  │  │  ZERO imports from outside     │  │  │
│  │  └────────────────────────────────┘  │  │
│  └──────────────────────────────────────┘  │
└────────────────────────────────────────────┘
```

Dependencies point **inward only**. This is enforced three ways:

1. **eslint** — `eslint.config.js` declares `no-restricted-imports` for
   `apps/server/src/domain/**` and `apps/server/src/app/**`, listing every
   vendor package and every I/O-capable Node built-in. Violating it fails
   `npm run lint`, which is part of `npm run ci`.
2. **The memory adapters** — every port has an in-process fake, and the whole
   product runs on them. A vendor concept that leaked into a use case would
   break `npm run dev:memory` immediately.
3. **Code review** — the doc comment on every port states the invariant it
   protects, so a reviewer can tell whether a change respects it.

### Ring 1 — Domain (`apps/server/src/domain`)

Pure TypeScript. No npm packages, no I/O, no clock, no randomness.

| Directory   | Contents                                                                             |
| ----------- | ------------------------------------------------------------------------------------ |
| `entities/` | User, Room, RoomMember, Relationship, Surprise, Report, Ban, TrustEvent, ChatMessage |
| `values/`   | branded ids, trust scoring, text-safety primitives                                   |
| `rules/`    | `ageGate.ts`, `trustLadder.ts`, `moderation.ts`                                      |
| `ports/`    | the interfaces the domain needs from the outside world                               |
| `errors.ts` | the failure taxonomy and its HTTP mapping                                            |

### Ring 2 — Application (`apps/server/src/app`)

One file per use case. Each is a class taking ports by constructor injection,
with a single `execute` method. Knows nothing about HTTP, sockets, or SQL.

**Every use case checks authorization itself.** It never assumes the edge did.

### Ring 3 — Adapters (`apps/server/src/adapters`)

The only place vendor SDKs appear.

| Directory        | Implements                                              |
| ---------------- | ------------------------------------------------------- |
| `livekit/`       | `MediaRoomProvider`                                     |
| `redis/`         | `PresenceStore`, `EventBus`, `RateLimiter`, `Metrics`   |
| `postgres/`      | the repositories + the migration runner                 |
| `socketio/`      | `RealtimeTransport` + socket handlers + presence reaper |
| `http/`          | Fastify routes + error mapping                          |
| `observability/` | `Logger` (pino)                                         |
| `memory/`        | **every port**, in-process                              |

### Composition root (`apps/server/src/main.ts` + `container.ts`)

The single place adapters are constructed and injected. Swapping LiveKit for
mediasoup, or Redis for Valkey, must require changes **only** in
`src/adapters/` and these two files.

`container.ts` is the only module that branches on `PERSISTENCE`.

### The ports

| Port                   | Why it exists                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `MediaRoomProvider`    | Voice is the most vendor-entangled part. `issueJoinToken` takes `canPublish` as a parameter so the adapter can never decide who may speak. |
| `PresenceStore`        | "Who is here now" is ephemeral and TTL'd. Separate from durable history.                                                                   |
| `EventBus`             | **server → server.** Cross-process fan-out (a ban must reach the process holding the socket).                                              |
| `RealtimeTransport`    | **server → client.** The complete list of things the server can say.                                                                       |
| `RateLimiter`          | A _safety_ control, not a capacity control — so it is a domain concern.                                                                    |
| `Clock`, `IdGenerator` | Injectable time and randomness. Also the security boundary for surprise codes.                                                             |
| `UserRepository` etc.  | Plain CRUD, returning domain entities, never rows.                                                                                         |
| `TokenService`         | Access and refresh tokens as distinct types, so one cannot be used where the other is expected.                                            |
| `AuthChallengeStore`   | OTP/magic-link secrets, with TTL, single-use consume, and attempt caps.                                                                    |
| `NotificationSender`   | SMS/email providers swap often; the auth use case must not care.                                                                           |
| `Logger`, `Metrics`    | Observability the inner rings can use without a vendor.                                                                                    |

---

## 3. System components

- **Frontend** — Next.js PWA (App Router). Talks to the backend only through
  `apiClient.ts` (REST), `realtimeClient.ts` (sockets) and `mediaClient.ts`
  (LiveKit browser SDK). No fetch calls scattered in components.
- **API server** — Node.js + Fastify. Auth, profiles, room CRUD, surprises,
  reports, admin.
- **Realtime server** — Socket.io. Authenticates the JWT **once** on connect.
  Runs in the API process at MVP (`REALTIME_IN_PROCESS=true`) but has its own
  entry point (`src/realtime.ts`) so the split is a config change, not a
  refactor.
- **Media** — LiveKit, self-hosted, behind `MediaRoomProvider`. Voice only.
  **All clients join with `canPublish=false`**; publishing is granted
  server-side by `ApproveSpeaker`.
- **PostgreSQL** — permanent data. **Redis** — presence, pub/sub, rate limits,
  socket adapter.
- **Cloudflare** in front. **Docker Compose** runs the stack on one VPS.

### What lives where, and why

| Data                                                                   | Store    | Why                                                                                                                       |
| ---------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------- |
| accounts, rooms, relationships, surprises, reports, bans, trust ledger | Postgres | Must survive everything.                                                                                                  |
| membership history (`room_members`)                                    | Postgres | Backs the trust ladder's "did these two actually meet?" — a Redis flush must not revoke everyone's DM rights.             |
| live presence, raised hands                                            | Redis    | Ephemeral, TTL'd, rewritten on every heartbeat. A row per reconnect would be a write storm on mobile.                     |
| room chat                                                              | Redis    | Ephemeral **by product design** — a third place is not a forum. Bounded ring buffer, only to fill the reconnect snapshot. |
| direct messages                                                        | Postgres | A conversation you scroll back through is the point.                                                                      |
| rate-limit counters                                                    | Redis    | They must expire, and are worthless once they do.                                                                         |
| push subscriptions                                                     | Postgres | One row per DEVICE, keyed on the endpoint so a shared machine moves to its new owner rather than notifying both.           |
| large media (planned)                                                  | R2       | Presigned uploads — the bytes never enter the API process. No feature uses it yet.                                         |

### Database schema

See `apps/server/migrations/`, applied in filename order. Every table and column
carries a `COMMENT`.

| # | What it adds |
| - | ------------ |
| 0001 | The initial schema |
| 0002 | Streaks, user timezone, scheduler bookkeeping |
| 0003 | Lets a disabled schedule keep its cron, so a host can see what stopped |
| 0004 | Push subscriptions |
| 0005 | RLS on every personal table (no policies — a backstop, see ADR 0008) and pgvector |
 Notable constraints, each defending an invariant stated in
the domain:

- `room_members_one_open_session` — at most one open membership row per
  (room, user), so a reconnect refreshes rather than duplicating.
- `relationships_ordered_pair` — `user_a < user_b`, so a pair cannot acquire two
  contradictory rows depending on who acted first.
- `surprises_redemption_atomic` — recipient, mood and `opened_at` are set
  together or not at all.
- `reports_queue_idx` — encodes the same urgent-first ordering as
  `compareForQueue` in the domain.

Migrations are plain numbered SQL run by a ~180-line runner
(`src/adapters/postgres/migrate.ts`): one transaction per file, a checksum per
file so an edited-after-apply migration is refused, and an advisory lock so two
booting instances cannot both apply the same file.

---

## 4. Realtime event catalogue

Every handler: **(a)** validates the payload at the edge, **(b)** re-checks
authorization via a use case — never trusting a client-claimed role, **(c)** is
rate-limited through the `RateLimiter` port, **(d)** emits through
`RealtimeTransport`, never a raw `io.emit`.

**Client → Server**
`room:join` · `room:leave` · `presence:heartbeat` · `chat:send` · `chat:typing` ·
`reaction:send` · `hand:raise` · `hand:lower` · `speaker:approve` _(host)_ ·
`speaker:remove` _(host)_ · `room:mute-user` _(host)_ · `room:kick` _(host)_ ·
`dm:request` · `dm:accept` · `dm:decline` · `dm:message` · `call:invite` ·
`call:accept` · `call:decline` · `report:submit`

`dm:decline` was added in phase 5. It is deliberately silent — the requester is
never told — so from their side a decline is indistinguishable from a request
that has simply not been answered yet.

**Server → Client**
`room:state` · `user:joined` · `user:left` · `chat:message` · `chat:typing` ·
`reaction:shown` · `hand:raised` · `speaker:promoted` _(carries a fresh
publish-enabled media token)_ · `speaker:demoted` · `room:muted` · `room:kicked` ·
`dm:requested` · `dm:opened` · `dm:message` · `call:incoming` · `call:accepted` ·
`call:declined` · `surprise:received` · `user:banned` · `error {code, message}`

The authoritative typed list is `domain/ports/RealtimeTransport.ts`.

**`room:state` is a full snapshot**, sent on join _and_ reconnect. Incremental
events are lossy across a mobile network drop; rather than replaying a delta
log, a reconnecting client throws its state away and takes a fresh picture.

---

## 5. Cross-cutting requirements

### The trust ladder (`domain/rules/trustLadder.ts`)

```
be in a room together ──▶ text in the room
          │
          ▼
host approves you ──▶ publish audio
          │
          ▼
shared a room session ──▶ request a DM ──▶ (they accept) ──▶ DM open
          │
          ▼
     DM is open ──▶ invite to a 1:1 call
```

Every rung is a **pure function** taking already-loaded facts. Each comes in two
forms: `canX(...)` returns a structured decision for UI affordances,
`assertCanX(...)` throws for enforcement. **Call sites that enforce must use the
assert form.**

### Safety baseline (non-deferrable)

- Report → queue → admin review → ban, end to end.
- Block/mute per user; host kick/mute/remove-speaker.
- 18+ DOB gate at signup, **checked server-side** in the domain.
- Force-disconnect on ban via the `EventBus`, because the socket may live in
  another process.
- A ban is enforced in two places — at socket connect _and_ via the bus — because
  the bus is best-effort, not a guarantee.

### Config

All secrets and endpoints via environment variables. `config.ts` validates the
whole environment at boot and **fails loudly**. Nothing else in the codebase
reads `process.env`. Production refuses to start with development defaults.

### Testing

| Suite                                  | Command                    | Needs            |
| -------------------------------------- | -------------------------- | ---------------- |
| unit — domain, use cases, memory fakes | `npm run test:unit`        | nothing          |
| integration — one per adapter          | `npm run test:integration` | Docker           |
| smoke — full user journey              | `npm run smoke`            | a running server |

### Observability

Structured JSON logs (pino) with request/socket ids, redaction of codes and
tokens applied at the adapter as a second line of defence. `/healthz` (liveness,
touches nothing) and `/readyz` (readiness, probes dependencies) per process —
conflating the two is how a partial outage becomes a restart storm.

---

## 6. Build order

Each phase ends runnable. **Do not start phase N+1 while phase N's exit criteria
fail.** Features not listed require an ADR.

| Phase | Scope                                                                                     | Exit criteria                                                          | Status |
| ----- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------ |
| **0** | Skeleton: monorepo, strict TS, lint/format, Compose, config, migrations, memory fakes, CI | `npm run dev:memory` boots both servers with zero external services    | ✅ verified |
| **1** | Identity: register with DOB gate, login, refresh, logout, profiles                        | two real users can register and log in on the VPS                      | ◐ locally |
| **2** | Rooms with **text chat only** — no audio, deliberately                                    | 10 users chat in a room with correct presence                          | ✅ verified · `room-check` 20/20 |
| **3** | Voice: LiveKit, listen-only tokens, raise hand → approve → publish                        | host + 3 speakers + N listeners on real phones over mobile data        | ◐ locally |
| **4** | Safety & moderation, before inviting strangers                                            | a reported user is reviewed, banned, and their socket drops in seconds | ✅ verified · `safety-check` 18/18 |
| **5** | Surprise mechanic + trust ladder end to end                                               | meet → surprise → DM → 1:1 call                                        | ✅ verified · `ladder-check` 43/43 |
| **6** | Retention & polish: streaks, scheduled rooms, PWA push, onboarding                        | a new user's first five minutes are smooth on a mid-range Android      | ⏳ next |

**What the two status markers mean, precisely.**

- **✅ verified** — the exit criterion was executed as written, against real
  Postgres, Redis and LiveKit, by the named script.
- **◐ locally** — every rule and adapter is verified and the journey runs
  end to end against real services on one machine, but the criterion's own
  wording demands something this environment does not have: a deployed VPS
  (phase 1) and two physical handsets on mobile data (phase 3). Those clauses
  are **unmet**, not waived. See `docs/audit-report.md` for the standing
  environment constraints and `docs/final-acceptance.md` (phase 6, B4) for where
  they must finally be discharged.

A phase is not "done" because its code exists. It is done when the criterion
above passes, which is why the middle column names an observable outcome rather
than a feature list.

**Phase 2 has no audio on purpose.** It proves the entire realtime backbone —
presence, heartbeat, ghost cleanup, reconnect snapshots, rate limiting — before
media complexity arrives to obscure which layer a bug is in.

---

## 7. Definition of done (per feature)

- [ ] Domain rules unit-tested
- [ ] Works against memory fakes **and** real adapters
- [ ] Payloads validated at every edge
- [ ] Authorization checked server-side, in a use case
- [ ] Rate-limited
- [ ] Logged (structured, no secrets)
- [ ] Documented — doc comment + README touch
- [ ] Runs in Docker Compose
- [ ] Smoke test updated

---

## Architecture Decision Records

See [`docs/adr/`](./adr/). One short record per significant choice.

| # | Decision |
| - | -------- |
| [0001](./adr/0001-ports-and-adapters.md) | Ports and adapters, enforced by lint |
| [0002](./adr/0002-livekit-sfu.md) | LiveKit as the SFU, behind `MediaRoomProvider` |
| [0003](./adr/0003-no-orm.md) | Raw SQL, no ORM |
| [0004](./adr/0004-trust-ladder-in-domain.md) | The trust ladder is pure domain code |
| [0005](./adr/0005-realtime-in-process-first.md) | Realtime runs in-process first |
| [0006](./adr/0006-ephemeral-room-chat.md) | Room chat is ephemeral; DMs persist |
| [0007](./adr/0007-call-signalling-in-the-relationship.md) | Call signalling lives in the relationship row |
| [0008](./adr/0008-managed-platform-topology.md) | Supabase + Vercel + Cloudflare + R2; the process split |
