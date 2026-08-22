import { z } from 'zod';

/**
 * Payload schemas for every client -> server socket event.
 *
 * WHY VALIDATION HAPPENS AT THE EDGE AND AGAIN IN THE DOMAIN
 * ----------------------------------------------------------
 * These schemas check SHAPE, not rules. They answer "is this a string of
 * plausible length in a field called roomId" — nothing about whether the room
 * exists, whether the sender may post to it, or whether the text is acceptable.
 * Those are business rules and they live in the domain, where the HTTP edge and
 * the smoke test get them too.
 *
 * The edge check exists because a socket handler receives arbitrary JSON from
 * the network. Without it, `payload.roomId` could be an object, an array, or a
 * 10MB string, and it would reach a use case — and eventually a database
 * driver — as such.
 *
 * WHY UUID-SHAPED IDS ARE ENFORCED HERE
 * -------------------------------------
 * Every id in this system is a UUID. Checking that at the edge means a
 * malformed id fails with a clean validation error instead of reaching Postgres
 * and producing an `invalid input syntax for type uuid` — which is both an
 * uglier failure and a small information leak about the storage layer.
 *
 * Lengths are capped generously but firmly: the domain enforces the REAL limit
 * (500 characters for a message), and these caps exist so that a megabyte of
 * text is rejected before anything allocates it.
 */

const uuid = z.string().uuid();

/** Room ids and user ids are UUIDs; branding happens after validation. */
const roomId = uuid;
const userId = uuid;

export const socketSchemas = {
  'room:join': z.object({ roomId }),
  'room:leave': z.object({ roomId }),

  // The client MAY name the rooms it believes it is in. Safe to accept because
  // naming a room never creates presence — heartbeat only refreshes an entry
  // that already exists, or reports that it does not. See the Heartbeat use
  // case for why this is the only way a lapse can be detected at all.
  'presence:heartbeat': z.object({ rooms: z.array(uuid).max(20).optional() }).optional(),

  'chat:send': z.object({
    roomId,
    // 2000 is well above the domain's 500-character limit. The gap is
    // deliberate: over-long text should be REJECTED BY THE DOMAIN with a
    // message a user understands ("500 characters or fewer"), not silently
    // truncated or refused by the transport with a shape error.
    text: z.string().min(1).max(2000),
  }),

  'chat:typing': z.object({ roomId }),

  'reaction:send': z.object({
    roomId,
    // A NAME from the closed palette, never a glyph. The domain owns the
    // whitelist; this only bounds the length.
    reaction: z.string().min(1).max(32),
  }),

  // -- Phase 3 -------------------------------------------------------------
  'hand:raise': z.object({ roomId }),
  'hand:lower': z.object({ roomId }),
  'speaker:approve': z.object({ roomId, userId }),
  'speaker:remove': z.object({ roomId, userId }),

  // -- Phase 4 -------------------------------------------------------------
  'room:mute-user': z.object({ roomId, userId, muted: z.boolean() }),
  'room:kick': z.object({ roomId, userId }),
  'report:submit': z.object({
    targetId: userId,
    roomId: roomId.optional(),
    category: z.string().min(1).max(32),
    note: z.string().max(4000).optional(),
  }),

  // -- Phase 5 -------------------------------------------------------------
  'dm:request': z.object({ userId }),
  'dm:accept': z.object({ userId }),
  'dm:decline': z.object({ userId }),
  'dm:message': z.object({ userId, text: z.string().min(1).max(2000) }),
  'call:invite': z.object({ userId }),
  'call:accept': z.object({ userId }),
  'call:decline': z.object({ userId }),
} as const;

export type SocketEventName = keyof typeof socketSchemas;

export type SocketPayload<E extends SocketEventName> = z.infer<(typeof socketSchemas)[E]>;
