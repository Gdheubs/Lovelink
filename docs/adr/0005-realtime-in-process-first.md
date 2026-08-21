# ADR 0005 — Realtime in the API process, but as a separate module with its own entry point

**Status:** accepted · **Date:** 2026-08-21

## Context

HTTP and websockets scale on different curves: sockets are bounded by concurrent
connections and memory, HTTP by request throughput. They will eventually want
separate machines. But at MVP, two processes are two things to deploy, monitor
and debug for no user-visible benefit.

## Decision

Run Socket.io on the API HTTP server by default (`REALTIME_IN_PROCESS=true`),
while keeping `src/realtime.ts` as a **maintained, compiling, separate entry
point** from day one.

## Rationale

A boundary you have never crossed is a boundary you do not have. Keeping the
second entry point compiling forces the design decisions that make the split
work — and they are decisions that are painful to retrofit:

- `EventBus` (server → server) is a **different port** from `RealtimeTransport`
  (server → client). Conflating them is what makes a system impossible to scale
  out, because every "notify the user" call site silently assumes a local
  socket.
- Presence lives in a shared store, not in process memory.
- Broadcast goes through the Socket.io Redis adapter, so an emit on one node
  reaches clients on another.

## Consequences

- Splitting is a config change plus a process, not a refactor.
- `PERSISTENCE=memory` is **refused** for a standalone realtime process: two
  processes with two separate in-memory stores share nothing, and the resulting
  confusion is worse than an error message.
- Small ongoing cost: the second entry point must keep compiling. Cheap, and the
  typecheck enforces it.
