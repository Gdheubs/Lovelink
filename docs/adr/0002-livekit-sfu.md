# ADR 0002 — LiveKit as a self-hosted SFU, behind a port

**Status:** accepted · **Date:** 2026-08-21

## Context

Rooms need one host plus up to eight speakers publishing audio to an unbounded
number of listeners, on mobile networks, cheaply.

## Decision

An **SFU** (selective forwarding unit), specifically self-hosted **LiveKit**,
behind the `MediaRoomProvider` port.

### Why an SFU and not the alternatives

| Topology                | Behaviour with N participants                                                                               | Verdict                |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------- |
| **Mesh (P2P)**          | Each publisher uploads N-1 streams. Four speakers already saturate a phone uplink; battery drain is severe. | Fails at 4 speakers    |
| **MCU** (server mixes)  | One downstream stream, but server-side transcoding costs CPU per room and adds latency.                     | Too expensive on 1 VPS |
| **SFU** (server routes) | Publishers upload once; the server forwards. No transcoding. Listeners are nearly free.                     | ✅                     |

The listener-heavy shape of a drop-in room is exactly what an SFU is best at:
adding the 200th silent listener costs bandwidth, not CPU.

### Why LiveKit specifically

Self-hostable in Docker, has a server SDK for issuing scoped tokens (which is
precisely the grant model the trust ladder needs), handles TURN integration, and
is one container rather than a cluster.

## Consequences

- **We run a media server.** Requires TURN (coturn) for carrier-grade NAT, which
  is why "works on real phones over mobile data" is an explicit Phase 3 exit
  criterion rather than an assumption.
- UDP port range 50000-50100 must be open.
- **The publish grant is server-side.** `issueJoinToken(userId, roomId, canPublish)`
  takes the decision as a parameter; the adapter never decides. This is what
  makes "everyone joins listen-only" structural rather than a convention.
- Swapping to mediasoup or Janus means writing one adapter against an interface
  of seven methods.
