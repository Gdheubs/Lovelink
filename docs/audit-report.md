# Loverlink Audit Report

**Date:** 2026-08-21 · **Baseline commit:** `b332b40` (Phase 2 complete)

This report records the systematic audit required before resuming feature work:
ground truth, architecture-violation sweep, correctness sweep, and per-phase
exit-criteria status. Every finding is listed with its root cause and
resolution, whether or not it turned out to be a defect.

---

## A1. Ground truth (before any fix)

Recorded verbatim from a clean tree at `b332b40`.

| Check                      | Result at baseline                                       |
| -------------------------- | -------------------------------------------------------- |
| `npm run typecheck`        | **PASS** — 0 errors                                      |
| `npm run lint`             | **PASS** — 0 errors                                      |
| `npm run test:unit`        | **PASS** — 246 tests, 7 files                            |
| `npm run test:integration` | **PASS** — 137 passed, 4 skipped                         |
| `npm run dev:memory` boot  | **PASS** — `/healthz` ok, `/readyz` ready, 0 boot errors |
| `npm run smoke` (memory)   | **PASS** — 37/37                                         |
| `npm run smoke` (postgres) | **PASS** — 37/37                                         |
| `npm run room-check`       | **PASS** — 13/13                                         |

**No failures at baseline.** The defects found in this audit were all invisible
to the suite as it stood — which is itself the most important finding, and is
addressed by finding **F1**.

### Smoke test status

The spec's journey is _register two users → create room → join → raise hand →
approve → chat → report_. The existing script covered registration, sessions,
profiles and room CRUD; the remaining steps depend on Phases 3–4, which are not
built. The script lists them explicitly as pending rather than silently omitting
them, and each phase gate extends it. Two gaps in it were repaired during this
audit (**F7**, **F8**).

---

## A2. Architecture-violation sweep

Every check was run by grep over the tree, not by inspection.

| Check                                                                                | Result                                                                                                                                                    |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vendor imports (`livekit`/`ioredis`/`pg`/`socket.io`/`redis`) in `/domain` or `/app` | **0**                                                                                                                                                     |
| I/O-capable Node builtins in `/domain` or `/app`                                     | **0**                                                                                                                                                     |
| Raw `io.emit` / socket access outside `/adapters/socketio`                           | **0** (2 matches, both doc comments)                                                                                                                      |
| SQL outside `/adapters/postgres`                                                     | **0** (2 matches in port doc comments; `CompositeMessageRepository` is expected — it spans Redis and Postgres by design, per ADR 0006)                    |
| Ports without a working in-memory fake                                               | **0** — all 14 have one                                                                                                                                   |
| Use cases constructing their own dependencies                                        | **0** — the 15 `new X(ports)` calls are in `app/index.ts`, the factory the composition root calls, and every one receives ports rather than building them |
| `new Date()` / `Math.random()` in `/domain` or `/app`                                | **0** — only in `Clock.ts`'s own `systemClock` reference implementation                                                                                   |
| `process.env` outside `config.ts`                                                    | **0**                                                                                                                                                     |
| Hardcoded URLs/secrets                                                               | **0** in production paths (one placeholder default in the memory _fake_ media provider)                                                                   |
| `fetch` / socket calls outside the three web client modules                          | **0**                                                                                                                                                     |

**No architecture violations.** The boundary is enforced mechanically by
`eslint.config.js`, which is why it held.

---

## A3. Correctness sweep — findings

### F1 — No socket-level test suite existed _(gap; root cause of F2–F5)_

**Severity:** high · **Status:** resolved

Every rule was tested against the in-memory fakes, and every adapter against its
real service. Nothing tested the **socket edge**. That is precisely where a
distinct family of bugs lives, and none of it was reachable from a use-case
test:

- an async socket listener that rejects is an **unhandled rejection**, which on
  modern Node **kills the process** — one malformed payload from one client
  would take down every room on the server;
- handler ordering, identity spoofing via payload fields, and per-socket vs
  per-user state are all invisible without a real connection.

**Resolution:** added `tests/socket/` with an in-process Socket.io server over
the memory fakes (`harness.ts`) — real TCP, real handshake, no Docker, ~1s.
48 tests across three suites: `fuzz.test.ts`, `connection.test.ts`,
`authorization.test.ts`. Registered in the fast gate.

F2–F5 were all found by this suite within minutes of it existing.

---

### F2 — Double-tapping `room:join` announced the arrival five times

**Severity:** high · **Status:** fixed

**Reproduction:** `tests/socket/connection.test.ts` → _"double-tapping
room:join settles at exactly one membership"_. Five joins emitted without
awaiting; the room received five `user:joined` events for one person.

**Root cause:** `JoinRoom` read presence, decided `isNewArrival` from the read,
then wrote presence. A classic check-then-act race: all five joins read
"absent" before any of them wrote, so every one believed it was the first.

**Fix (minimal, at the right ring):** `PresenceStore.setOnline` now **returns
whether it made the user newly present**, so the write itself reports the
transition. In Redis this falls out of the Lua script comparing the expiry
score before `HSET`; in the memory fake, out of there being no `await` between
the check and the set. `JoinRoom` uses the returned value instead of its own
read.

Contract tests added to `tests/adapters/presenceStore.test.ts` covering both
implementations, including 8 concurrent joins resolving to exactly one winner.

---

### F3 — `room:join` followed immediately by `room:leave` left the user in the room

**Severity:** high · **Status:** fixed

**Reproduction:** `tests/socket/connection.test.ts` → _"join followed
immediately by leave settles as left"_. Presence count was 1 after the leave.

**Root cause:** Socket.io delivers a client's events in order, but the handlers
are `async`, so their **effects** interleave. The leave completed first, found
no presence to remove, did nothing — and then the join wrote presence. The user
was in a room they had explicitly left, with nothing looking wrong anywhere.

This is not one bug but a **shape** of bug: join/leave, raise/lower,
request/accept and every future pair share it.

**Fix:** per-socket serialization in `registerHandlers.ts`. Each connection gets
a promise chain, so one client's events take effect in the order sent. Different
sockets still run concurrently, so there is no throughput cost — a single user's
events are user-paced by definition.

---

### F4 — Closing one of two tabs removed the user from the room

**Severity:** medium · **Status:** fixed

**Reproduction:** `tests/socket/connection.test.ts` → _"two tabs for one user
share presence and survive one closing"_.

**Root cause:** **presence is per user; disconnect is per socket.** The
disconnect handler cleaned up unconditionally, so closing either tab evicted the
user from every room — while their other tab carried on rendering it.

**Fix:** the disconnect handler now checks `realtime.isUserConnected` and skips
cleanup when another connection remains. This required an **ordering change** in
`server.ts`: the transport's `unregister` listener is now registered _before_
the room handlers', because Socket.io invokes disconnect listeners in
registration order and the check is only correct once this socket has left the
registry. That ordering is documented at both sites, since it is load-bearing
and otherwise looks arbitrary.

---

### F5 — Oversized payloads drop the connection silently _(by design; documented)_

**Severity:** low · **Status:** accepted, now explicit and tested

A payload beyond Socket.io's `maxHttpBufferSize` closes the connection before
any application code runs. The client cannot distinguish that from a network
failure.

**Assessment:** correct behaviour for traffic no legitimate client sends, but
the _gap between the two limits_ is what makes it safe, and that gap was
undocumented and unnamed. The schema caps a message at 2000 characters and a
report note at 4000; the transport ceiling is 32KB — so every realistic mistake
(a pasted essay, a runaway string) lands in the schema's territory and gets a
real error message the user can act on.

**Resolution:** extracted `SOCKET_MAX_PAYLOAD_BYTES` with the two-layer
reasoning documented, and added tests for both layers — over-long-but-legal
gets an `error` event and stays connected; genuinely oversized drops **only the
offending socket**, with a bystander proving the server and other rooms survive.

---

### F6 — Every malformed HTTP body returned 500 with a stack trace

**Severity:** medium · **Status:** fixed _(found during Phase 2, recorded here for completeness)_

`ZodError` is not a `DomainError` and carries no `statusCode`, so the shared
error handler treated schema failures as unexpected bugs: a caller typo produced
a 500 and a stack trace in the logs, indistinguishable from an outage.

**Fix:** `errorMapping.ts` now handles `ZodError` first, returning **400** with
the offending field named. Caught by the smoke test on an unknown room category.

---

### F7 — Smoke test sections depended on each other's tokens

**Severity:** low (test-only) · **Status:** fixed

The room section reused a token from the sessions section — which deliberately
performs a refresh-replay test that **revokes the session**. The room checks
therefore failed for a reason entirely unrelated to rooms.

**Fix:** each section registers its own actor. A smoke failure now points at one
thing.

---

### F8 — Smoke/room-check hit the auth rate limit legitimately

**Severity:** medium (product bug, surfaced by tooling) · **Status:** fixed

Running the 10-user room check was impossible: the per-IP auth limit was 5 per
15 minutes, the same as the per-identifier limit.

**Root cause:** the two limits defend different things and had been given the
same value. **IP addresses are shared** — an office, a campus, carrier-grade
NAT. A limit of five signups per IP locks out an entire building after the fifth
person, and it looks exactly like a rate limiter working correctly.

**Fix:** split into `authRequest` (per identifier, 5 — protects a victim from
being SMS-bombed) and `authRequestPerIp` (40 — caps cost), plus the same split
for verification. Tests assert the per-IP limit is at least 5× the
per-identifier one, and that ten colleagues behind one IP can all sign up.

---

### A3 checklist status

| #   | Check                                                                                                                  | Status                                                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | JWT verified on socket **connect**, not per event; expired → clean disconnect                                          | ✅ 7 tests in `connection.test.ts` (no token, empty, garbage, refresh-token-as-access, revoked session, banned, valid)                                                                       |
| 2   | Host-only events re-check role from server state                                                                       | ⏳ **deferred** — `speaker:approve`, `room:kick`, `room:mute-user` are Phase 3–4 and have no handlers yet. Their schemas exist and are fuzzed. Tests to be written at those gates.           |
| 3   | Every socket event and HTTP route validates shape; malformed → `error`, never an exception                             | ✅ fuzz suite covers **all 19** events × 29 hostile payloads; F5, F6 fixed                                                                                                                   |
| 4   | Presence integrity: kill client → `user:left` broadcast; reconnect → snapshot restores; no ghosts after 2× heartbeat   | ✅ verified with a live reaper and a 5s wait at a 2s TTL, with a heartbeating bystander proving the reaper is selective                                                                      |
| 5   | Races: double-join, join-then-leave, two hosts approving, ban mid-speech                                               | ✅ first two fixed (F2, F3) and tested; the latter two are Phase 3–4                                                                                                                         |
| 6   | Media token safety: listener `canPublish=false`, promotion issues a NEW token, revoke is server-side                   | ⏳ **deferred to Phase 3** — the `MediaRoomProvider` port takes `canPublish` as a parameter so the adapter cannot decide it, and the memory fake records every grant for assertion           |
| 7   | Rate limits per-user in Redis, not per-socket in memory                                                                | ✅ 3 tests: a second tab gets no second allowance; a reconnect does not reset it; one user's limit does not affect another                                                                   |
| 8   | Ban propagation: HTTP → EventBus → force-disconnect; cannot re-login or rejoin                                         | 🟡 **partial** — handshake refusal and mid-session severing are tested; the admin route and EventBus path are Phase 4                                                                        |
| 9   | Trust ladder enforced in domain functions, not hidden buttons                                                          | ✅ 36 unit tests in `trustLadder.test.ts`; `haveSharedRoomSession` interval-overlap verified against both adapters                                                                           |
| 10  | Migrations clean on a fresh DB; `trust_score` = sum of `trust_events`; surprise codes unique/single-redeem/unguessable | ✅ fresh-DB drill performed (10 tables, idempotent re-run); invariant query returns **0** disagreements. Surprise codes are Phase 5 (CSPRNG + unambiguous alphabet already in `IdGenerator`) |
| 11  | Frontend: no fetch/socket outside the three client modules; UI never trusts its own state for permissions              | ✅ 0 violations; the single `role ===` in a component is a display badge                                                                                                                     |

---

## A4. Post-fix verification

| Check                           | Result                                 |
| ------------------------------- | -------------------------------------- |
| `npm run typecheck`             | **PASS**                               |
| `npm run lint`                  | **PASS**                               |
| `npm run test:unit`             | **PASS** — 294 tests, 10 files (+48)   |
| `npm run test:integration`      | **PASS** — 147 passed, 4 skipped (+10) |
| `npm run smoke` (memory)        | **PASS** — 37/37                       |
| `npm run smoke` (postgres)      | **PASS** — 37/37                       |
| `npm run room-check` (memory)   | **PASS** — 13/13                       |
| `npm run room-check` (postgres) | **PASS** — 13/13                       |

**Part A exit criteria met.**

---

## B1. Phase status against exit criteria

A phase counts as done because its exit criteria **pass**, not because code
exists.

| Phase                     | Exit criterion                                                      | Status             | Evidence                                                                                                                                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0 — Skeleton**          | `npm run dev:memory` boots both servers with zero external services | ✅ **PASS**        | Boots; `/healthz` + `/readyz` green; 0 boot errors                                                                                                                                                                                                         |
| **1 — Identity**          | Two real users can register and log in **on the deployed VPS**      | 🟡 **PARTIAL**     | Verified end-to-end against real Postgres/Redis locally (37/37 smoke, including the 18+ gate refusing a 15-year-old with `UNDERAGE` and 0 underage rows reaching the database). **VPS deployment not performed** — no VPS is available in this environment |
| **2 — Text rooms**        | 10 users sit in a room and chat with correct presence               | ✅ **PASS**        | `room-check` 13/13 with 10 real websockets, against both backends                                                                                                                                                                                          |
| **3 — Voice**             | Host + 3 speakers + N listeners on real phones over mobile data     | 🟡 **PARTIAL**     | `room-check` 20/20 including voice against real LiveKit; listen-only tokens, raise-hand → approve → publish, revoke-on-demote all verified. **Real phones on mobile data not performed** — no handsets available |
| **4 — Safety**            | Reported user reviewed and banned; socket drops within seconds      | ✅ **PASS**        | `safety-check` 18/18 against real services; ban severs the socket, tokens die, reconnect refused, ban liftable                                                                                                  |
| **5 — Surprise + ladder** | Meet → surprise → DM → 1:1 call                                     | ✅ **PASS**        | `ladder-check` 43/43 against real Postgres/Redis/LiveKit; full journey plus every rung proven unskippable                                                                                                       |
| **6 — Retention**         | New user's first five minutes smooth on a mid-range Android         | ❌ **NOT STARTED** | —                                                                                                                                                                                                              |

**Resume point: Phase 6 (Retention & polish).**

Phases 1 and 3 are marked partial rather than failed because every criterion
that can be tested without the hardware passes; the deployment and the handsets
are environment prerequisites, not code defects. Both are tracked in
`docs/final-acceptance.md` along with the other steps requiring physical
hardware, and neither is waived — phase 6's B4 gate is where they are finally
discharged.

### Findings from phases 3–5

Recorded here because the fix protocol applies to work done after the audit as
well as during it: a failing test first, then the smallest fix that respects the
ring boundaries.

- **F9 — One kick locked a new account out of the entire platform.** `kicked_from_room`
  was −10 against a starting balance of 0, so a single host's unilateral action
  pushed a brand-new user to `restricted` and barred them from *every* room —
  contradicting the room-scoped design of a kick. Found by a test asserting a
  kicked user could still join a *different* room. Fixed by giving registration
  an explicit `account_created: +10` ledger entry and softening
  `kicked_from_room` to −5, so three separate hosts must agree before an account
  is restricted; tier thresholds moved to 25/60 so the starting balance did not
  render every new signup as "Regular".
- **F10 — The integration suite was silently skipping every adapter test.**
  `tests/adapters/support.ts` falls back to `localhost:5432` when `DATABASE_URL`
  is unset, and vitest never loaded `.env`. This project runs Postgres on 5433
  precisely because the machine already had something on 5432, so the probe
  connected to the wrong database and 36 assertions reported as green "skipped".
  A harness that looks like it ran is the worst possible failure. Fixed with
  `tests/setup.integration.ts`, which loads `.env` exactly as `config.ts` does;
  the full adapter suite then ran and passed 193/193, confirming nothing had
  been hiding behind the skip.
- **F11 — `CALL_BUSY` / `NO_PENDING_CALL` never reached the client.** The denial
  reasons were added but not mapped in `denialError`, so both fell through to
  `FORBIDDEN` — defeating the reason for adding them. Caught by an app test
  asserting the code. The follow-on was caught by typecheck: they had been
  modelled as `AuthorizationError`, but "the line is busy" is a state conflict,
  not a permission failure. Both are now `ConflictError` (409), so a client can
  offer a retry for one and must not for the other.
- **F12 — Dialling minted a publishing credential.** The first draft of
  `InviteToCall` returned a media token and the socket edge echoed
  `call:accepted` to the caller. That told the caller's UI a ringing phone had
  connected, and left a live microphone credential in the browser of every call
  nobody answered. `AcceptCall` is now the only place in the protocol that
  issues one, and it issues both at the single moment consent exists. Covered by
  `ladder-check`: *"the ring carries NO media token"*, *"the caller is not told
  the call connected merely for dialling"*.
- **F13 — Smoke test claimed built phases were "not yet built".** The pending
  block still listed phases 3–5. A green smoke test that misreports scope is
  worth less than nothing; replaced with pointers to the dedicated check
  scripts.
- **F14 — `/me/surprises` reached past the application ring.** The route read
  `ports.surprises` directly. Extracted to `ListMySurprises`, because what the
  two views omit (a sender never learns the recipient's mood; a recipient never
  sees the claim code again) is a policy decision, and policy in a route file is
  policy that exists once per edge.

---

## Environment constraints on final acceptance

Two items in the completion checklist cannot be executed from this environment
and are recorded rather than claimed:

- **B3 / PWA push notifications on a real Android device** — requires a
  physical device and a push service registration.
- **B4 / final acceptance run on the deployed VPS with two physical phones on
  mobile data** — requires a VPS and two handsets on cellular.

Everything these gates depend on is built and verified as far as it can be
locally (including TURN configuration, which exists precisely because
carrier-grade NAT is what breaks a naive WebRTC deployment). The steps, and
their unrun status, are enumerated in `docs/final-acceptance.md` so that
whoever has the hardware can execute them without reconstructing the list.
