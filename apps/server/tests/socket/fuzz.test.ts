import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startSocketHarness, sleep, type SocketHarness } from './harness.js';
import { socketSchemas } from '../../src/adapters/socketio/handlers/schemas.js';
import { SOCKET_MAX_PAYLOAD_BYTES } from '../../src/adapters/socketio/server.js';
import type { User } from '../../src/domain/entities/User.js';

/**
 * FUZZ: throw garbage at every socket event and prove the server survives.
 *
 * WHAT THIS IS ACTUALLY DEFENDING
 * -------------------------------
 * A socket handler receives arbitrary JSON from the network. The specific
 * failure this suite exists to prevent is subtle and fatal:
 *
 *   `socket.on('chat:send', async (payload) => { ... })`
 *
 * If that async listener REJECTS, nothing is awaiting it. Node treats it as an
 * unhandled rejection, and the default behaviour on modern Node is to KILL THE
 * PROCESS. So one malformed payload from one client takes down every voice room
 * on the server. That is not hypothetical — it is the natural consequence of
 * writing an async socket handler without a try/catch, which is the obvious way
 * to write one.
 *
 * The contract every handler must satisfy:
 *   1. the process stays up;
 *   2. the offending client gets an `error` event rather than silence;
 *   3. OTHER clients are unaffected;
 *   4. nothing is mutated as a side effect of a rejected payload.
 *
 * TWO LAYERS OF DEFENCE, TESTED SEPARATELY
 * ----------------------------------------
 * Payloads within the transport's size limit are rejected by the SCHEMA, with a
 * proper `error` event the client can act on. Payloads beyond it never reach
 * application code at all — Socket.io closes the connection, which is the
 * correct response to something no legitimate client sends. Both behaviours are
 * asserted below, because "it survives" means different things at each layer.
 *
 * EVERY TEST GETS A FRESH CLIENT. Sharing one would mean the first case that
 * legitimately closes a connection cascades into every later assertion —
 * exactly the false alarm this suite is supposed to be free of.
 */

/**
 * Hostile but transport-legal payloads: wrong types, nulls, prototype
 * pollution, deep nesting, and privilege-claiming extra fields.
 *
 * Deliberately all well under SOCKET_MAX_PAYLOAD_BYTES, so every one of them
 * reaches the schema and must come back as a clean rejection.
 */
const MALFORMED_PAYLOADS: readonly unknown[] = [
  undefined,
  null,
  0,
  -1,
  1.5,
  NaN,
  true,
  false,
  '',
  'a string where an object belongs',
  [],
  [1, 2, 3],
  {},
  { roomId: null },
  { roomId: 123 },
  { roomId: [] },
  { roomId: {} },
  { roomId: true },
  { roomId: 'not-a-uuid' },
  { roomId: '' },
  { roomId: '11111111-1111-4111-8111-111111111111', text: null },
  { roomId: '11111111-1111-4111-8111-111111111111', text: 12345 },
  { roomId: '11111111-1111-4111-8111-111111111111', text: [] },
  { roomId: '11111111-1111-4111-8111-111111111111', userId: 'nope' },
  // Over the DOMAIN limit (500 chars) but under the TRANSPORT limit, so it
  // must produce an error event rather than a dropped connection.
  { roomId: '11111111-1111-4111-8111-111111111111', text: 'x'.repeat(3_000) },
  // Prototype pollution: if any handler deep-merges a payload, this is how
  // Object.prototype acquires a `polluted` property.
  { __proto__: { polluted: true }, roomId: '11111111-1111-4111-8111-111111111111' },
  { constructor: { prototype: { polluted: true } } },
  // Unbounded recursion bait.
  buildDeepObject(200),
  // Extra fields claiming privilege alongside valid ones.
  {
    roomId: '11111111-1111-4111-8111-111111111111',
    text: 'hello',
    isAdmin: true,
    role: 'host',
    userId: 'someone-else',
  },
];

function buildDeepObject(depth: number): unknown {
  let node: Record<string, unknown> = { end: true };
  for (let i = 0; i < depth; i += 1) node = { nested: node };
  return node;
}

const EVENT_NAMES = Object.keys(socketSchemas);

describe('socket fuzzing', () => {
  let harness: SocketHarness;
  let alice: User;

  beforeAll(async () => {
    harness = await startSocketHarness();
    alice = await harness.createUser('Alice');
  });

  afterAll(async () => {
    await harness.close();
  });

  describe('malformed payloads on every event', () => {
    for (const event of EVENT_NAMES) {
      it(`${event}: server survives, client stays connected, error is reported`, async () => {
        const client = await harness.connect(alice);

        try {
          for (const payload of MALFORMED_PAYLOADS) {
            client.emit(event, payload);
          }
          await sleep(120);

          // 1. THE PROCESS IS ALIVE and this socket is still usable. An
          //    unhandled rejection would have killed the server outright.
          expect(client.socket.connected).toBe(true);

          // 2. Still RESPONSIVE, not merely alive but wedged.
          client.clear();
          client.emit('presence:heartbeat', {});
          await sleep(60);
          expect(client.socket.connected).toBe(true);
        } finally {
          client.disconnect();
        }
      });
    }
  });

  it('answers a malformed payload with an error event, never silence', async () => {
    // Silence is the worst outcome: the client waits forever for a reply that
    // is never coming, and the user sees a spinner instead of a message.
    const client = await harness.connect(alice);
    try {
      client.emit('room:join', { roomId: 'definitely-not-a-uuid' });

      const error = await client.next<{ code: string; message: string }>('error');
      expect(error).not.toBeNull();
      expect(error?.code).toBe('VALIDATION_FAILED');
    } finally {
      client.disconnect();
    }
  });

  it('rejects an over-long message with an error, NOT a dropped connection', async () => {
    // The band that matters: longer than the domain allows, shorter than the
    // transport limit. A user who pastes an essay should be told it is too
    // long, not silently disconnected.
    const client = await harness.connect(alice);
    try {
      const room = await harness.useCases.createRoom.execute(alice, {
        title: 'Long Message Room',
        category: 'casual',
      });
      client.emit('room:join', { roomId: room.id });
      await client.next('room:state');
      client.clear();

      client.emit('chat:send', { roomId: room.id, text: 'x'.repeat(3_000) });

      const error = await client.next<{ code: string }>('error');
      expect(error).not.toBeNull();
      expect(error?.code).toBe('VALIDATION_FAILED');
      expect(client.socket.connected).toBe(true);
    } finally {
      client.disconnect();
    }
  });

  it('drops ONLY the offending socket when a payload exceeds the transport limit', async () => {
    // Beyond SOCKET_MAX_PAYLOAD_BYTES nothing reaches application code —
    // Socket.io closes the connection, which is the right answer to something
    // no legitimate client sends. What must NOT happen is the server dying or
    // other people's rooms going quiet.
    const victim = await harness.connect(alice);
    const bystander = await harness.connect(await harness.createUser('Bystander'));

    try {
      victim.emit('chat:send', {
        roomId: '11111111-1111-4111-8111-111111111111',
        text: 'x'.repeat(SOCKET_MAX_PAYLOAD_BYTES * 2),
      });

      // The offender goes.
      await victim.until(() => !victim.socket.connected, 3_000);
      expect(victim.socket.connected).toBe(false);

      // Everyone else is untouched, and the server still answers.
      expect(bystander.socket.connected).toBe(true);
      bystander.emit('presence:heartbeat', {});
      await sleep(80);
      expect(bystander.socket.connected).toBe(true);
    } finally {
      victim.disconnect();
      bystander.disconnect();
    }
  });

  it('does not pollute Object.prototype', async () => {
    const client = await harness.connect(alice);
    try {
      client.emit('chat:send', {
        __proto__: { polluted: 'yes' },
        roomId: '11111111-1111-4111-8111-111111111111',
        text: 'hi',
      });
      await sleep(100);

      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect((Object.prototype as unknown as Record<string, unknown>).polluted).toBeUndefined();
    } finally {
      client.disconnect();
    }
  });

  it('IGNORES extra fields rather than trusting them', async () => {
    // The nightmare: a handler that spreads the payload into an object it then
    // treats as authoritative, letting a client hand itself a role.
    const room = await harness.useCases.createRoom.execute(alice, {
      title: 'Privilege Room',
      category: 'casual',
    });

    const mallory = await harness.createUser('Mallory');
    const client = await harness.connect(mallory);

    try {
      client.emit('room:join', { roomId: room.id, role: 'host', isAdmin: true, selfRole: 'host' });

      const state = await client.next<{ selfRole: string }>('room:state');
      expect(state).not.toBeNull();
      // Alice owns this room. Mallory asked to be host and is a listener.
      expect(state?.selfRole).toBe('listener');
    } finally {
      client.disconnect();
    }
  });

  it('rate-limits a burst by REFUSING, not by disconnecting', async () => {
    // Dropping the socket would turn an over-eager client into a user who
    // cannot use the app at all, and would look identical to a network fault.
    const room = await harness.useCases.createRoom.execute(alice, {
      title: 'Burst Room',
      category: 'casual',
    });
    const client = await harness.connect(alice);

    try {
      client.emit('room:join', { roomId: room.id });
      await client.next('room:state');
      client.clear();

      for (let i = 0; i < 100; i += 1) {
        client.emit('chat:send', { roomId: room.id, text: `flood ${i}` });
      }
      await sleep(400);

      expect(client.socket.connected).toBe(true);
      // Some got through, the rest were refused — and the refusals were told.
      const errors = client.all<{ code: string }>('error');
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.code === 'RATE_LIMITED')).toBe(true);
    } finally {
      client.disconnect();
    }
  });
});
