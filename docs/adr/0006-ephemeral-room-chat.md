# ADR 0006 — Room chat is ephemeral; DMs are persistent

**Status:** accepted · **Date:** 2026-08-21

## Context

Both room chat and DMs are text messages between users. The obvious choice is to
store both in Postgres.

## Decision

- **Room chat** — a bounded ring buffer in Redis (50 messages), kept only to
  populate the `room:state` snapshot for someone joining or reconnecting.
- **DMs** — persisted in Postgres, unbounded.

One `MessageRepository` port covers both, so the retention difference is an
explicit policy in one file rather than an accident of which code path a message
took.

## Rationale

1. **Product.** A third place is not a forum. Permanently logging every word
   said in a late-night support room changes what people are willing to say
   there — which would destroy the thing the product exists to create.
2. **Safety.** Reports capture what is needed at report time (including an
   optional short audio clip). That is a targeted retention decision, not a
   blanket one.
3. **Cost.** Chat in a busy room is high-volume and near-worthless an hour
   later.

A DM, by contrast, is a conversation you expect to scroll back through.

## Consequences

- Room chat cannot be retrieved for a moderation case beyond the buffer window.
  Accepted: the report flow captures context at the moment of reporting, and
  voice — the primary medium — was never text anyway.
- A user who reconnects after a long absence sees only the recent tail. This is
  the same behaviour as walking back into a room.
- One entity (`ChatMessage`) with a `scope` discriminator, so a length limit or
  a safety check cannot get fixed in one path and not the other.
