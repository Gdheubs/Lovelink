# ADR 0004 — Contact rules live in the domain as pure functions

**Status:** accepted · **Date:** 2026-08-21

## Context

Loverlink puts strangers into voice contact. The safety model is progressive
disclosure: shared room → text → host-approved audio → DM → 1:1 call. These
rules will be invoked from HTTP routes, socket handlers, an admin tool, and the
smoke test.

## Decision

Every rung is a **pure function** in `domain/rules/trustLadder.ts`, taking
already-loaded facts and returning a decision. Two forms per rule: `canX` for UI
affordances, `assertCanX` for enforcement.

## Rationale

- **One definition.** Four call sites cannot each invent a slightly different
  version, and one of them forget the block check.
- **Testable without infrastructure.** 36 unit tests, no database, no clock.
- **Reviewable.** The complete contact-safety model is one readable file.
- **The `canX` / `assertCanX` split is deliberate.** A `canX` used inside an
  `if` is how authorization bugs are born during refactoring: someone inverts
  the condition, or handles the false branch by falling through. `assertCanX`
  throws, so there is no false branch to mishandle.

## Consequences

- Use cases must load the facts first (relationship, membership, shared-session
  flag). Slightly more code per use case, in exchange for rules that cannot
  reach for a database mid-decision.
- `haveSharedRoomSession` must read **durable** history, not live presence —
  otherwise a Redis restart would silently revoke every DM right in the system.
  This is why `room_members` is in Postgres despite presence being in Redis.
