# ADR 0001 — Ports and adapters, with a mandatory in-memory implementation

**Status:** accepted · **Date:** 2026-08-21

## Context

Loverlink depends on an SFU, a database, a cache, a socket layer, an SMS/email
provider and a CDN. Every one of those is a plausible future migration:
self-hosted LiveKit may become managed, Redis may become Valkey, an SMS gateway
may be blocked in a target country.

The default outcome is that vendor concepts spread. A Redis client gets passed
into a service "just for now"; a LiveKit room object becomes the shape a
function expects. By the time migration is needed, the vendor is not a
dependency but a spine.

## Decision

Three rings, dependencies inward only. The domain declares **ports**
(interfaces); adapters implement them; a single composition root wires them.

Crucially: **every port gets an in-memory implementation**, and the entire
application must run on them (`npm run dev:memory`).

## Consequences

**Good**

- Vendor swaps touch `/src/adapters` and `/src/main.ts`, nothing else.
- The unit suite runs in under a second with no Docker.
- New contributors get a working system without provisioning anything.
- The boundary is _proven_, not asserted: if a vendor import leaked inward,
  memory mode would break.

**Costs**

- Two implementations of every port. Accepted because the fakes double as the
  test fixtures we would have written anyway.
- A fake can drift from its adapter. Mitigated by: fakes deliberately model the
  real constraints (unique indexes, TTLs, compare-and-set atomicity, bounded
  buffers), and each adapter has an integration test asserting the same
  behaviours against the real service.
- Indirection when reading a call path. Mitigated by every port carrying a doc
  comment saying why it exists and what invariant it protects.

## Alternatives rejected

- **Direct vendor use with "we will refactor later".** Refactor-later never
  happens under load, which is exactly when the migration becomes necessary.
- **A generic repository/ORM abstraction.** Leaks storage semantics upward and
  hides what the database is actually asked to do — see ADR 0003.
