# ADR 0007 — Call signalling lives in the relationship state machine

**Status:** accepted · **Date:** 2026-08-22

## Context

A 1:1 call needs three things the trust ladder does not already provide:

1. **Mutual exclusion.** Two people who dial each other in the same second must
   end up in one call, not two.
2. **Direction.** The person who dialled must not be able to "answer" — if they
   could, the server would emit `call:accepted` to the other party and their
   client would join audio they never agreed to.
3. **Recovery.** A caller whose browser dies mid-ring sends no hang-up. Whatever
   holds "a call is in progress" must not hold it forever.

The obvious answer is a place to keep ringing state: a `call_sessions` table, a
Redis key with a TTL, or a new `CallSignalStore` port. All three were considered.

The spec fixes the event catalog (`call:invite` / `call:accept` /
`call:decline`; `call:incoming` / `call:accepted` / `call:declined`) but says
nothing about where the state behind it lives.

## Decision

**No new store.** The existing `relationships` row carries it.

- `dm_open → call_open` is written when someone dials. The compare-and-set in
  `RelationshipRepository.transition` **is** the mutex.
- `requestedBy` records **who dialled**, which is what `canAcceptCall` checks to
  refuse a self-accept. Its meaning is widened from "who asked for the DM" to
  "who initiated the pending interaction in the current state" — one concept,
  since a pair cannot have a pending DM request and a live call at once.
- Answering is `call_open → call_open`, the only self-transition in the machine.
  It clears `requestedBy`, which is what distinguishes **ringing** from
  **connected**.
- `dm_open` is restored by `EndCall`, which serves both hanging up and declining
  — server-side they are the same operation.

**Locks expire by being ignored, not by being cleaned up.** Two pure predicates
in the domain:

- `isRingStale` — `call_open`, `requestedBy` set, older than
  `CALL_RING_TIMEOUT_MS` (60s). An unanswered call.
- `isCallAbandoned` — `call_open`, `requestedBy` null, older than
  `CALL_MAX_DURATION_MS` (2h). A call nobody ended.

`canStartRinging` treats either as a free line and `InviteToCall` reclaims the
row before dialling.

**The call's media room is derived, not allocated**: `callRoomId(a, b)` from the
ordered pair. It has no `rooms` row at all.

## Rationale

**Why not a separate store.** Ringing state and relationship state are not
independent — every legal ringing state is a fact about a pair who already have
an open DM. Splitting them across two systems creates a consistency problem that
does not otherwise exist: a `call_sessions` row for a pair who have since blocked
each other, or a Redis key surviving a relationship that was torn down. Keeping
one row means the block, the DM and the call cannot disagree, because there is
nothing to disagree with.

**Why expiry-by-being-ignored rather than a reaper.** A cleanup job is another
process that can be down, and the failure mode when it is down is invisible:
pairs quietly lose the ability to call each other and nobody reports it, because
"the call button did nothing" is indistinguishable from a network problem. A
staleness predicate needs nothing to be running. The next call simply overwrites
the row.

**Why two timeouts rather than one.** They describe different failures. A ring
must give up in about a minute — that is what a phone does, and a longer window
locks the pair out for no reason. A connected call must never have a deadline
that short, or a real conversation passing sixty seconds would start looking
abandoned and become re-dialable mid-sentence. Two hours is far longer than any
call this product is for and short enough that a double-crash is measured in
hours rather than forever.

**Why the room id is derived.** Both clients must agree on it, and the obvious
alternative — generate an id and send it — makes the name exist only inside a
message that can be lost or duplicated. Derivation makes it a fact: the same
before, during and after, on both clients, after any restart, with no lookup.
Having no `rooms` row is what guarantees a private call can never appear in the
room directory — there is nothing to list it from. The name is not a secret and
does not need to be: joining requires a token, and tokens come only from
`AcceptCall`.

**Why no token is minted at dial time.** An earlier draft returned the caller's
media credential from `call:invite`. That both told the caller's UI a ringing
phone had connected and left a live publishing credential in the browser of
every call nobody answered. `AcceptCall` is now the only place in the protocol
that issues one, and it issues both at the single moment consent exists.

## Consequences

- **Good:** no new table, no new port, no new adapter, no cleanup job. The whole
  protocol is four use cases in one file plus two pure predicates.
- **Good:** a block, a ban or a trust penalty automatically ends the pair's
  ability to call, because it is the same row every other rung reads.
- **Good:** `CALL_BUSY` and `NO_PENDING_CALL` are conflicts (409), not
  authorization failures (403). The client can offer a retry for one and must
  not for the other.
- **Cost:** `requestedBy` means two things depending on state. Mitigated by
  documenting it on the field itself and by the fact that the two are mutually
  exclusive by construction.
- **Cost:** one self-transition in a machine that otherwise has none. It is
  called out in the transition table with its reason.
- **Cost:** a pair whose call is abandoned by both browsers cannot call each
  other for up to two hours. Accepted: it requires two simultaneous crashes, and
  the alternative is a reaper whose own failure is silent.
- **Limit:** this design is inherently 1:1. A three-way call would need real
  session rows, because "the pair" stops being the unit. That is out of scope
  and would be a new ADR, not an extension of this one.
