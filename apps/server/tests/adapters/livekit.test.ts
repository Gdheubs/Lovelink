import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeJwt } from 'jose';
import { LiveKitMediaRoomProvider } from '../../src/adapters/livekit/LiveKitMediaRoomProvider.js';
import { MemoryClock } from '../../src/adapters/memory/MemoryClock.js';
import { nullLogger } from '../../src/domain/ports/Logger.js';
import { asRoomId, asUserId } from '../../src/domain/values/ids.js';

/**
 * INTEGRATION: the LiveKit adapter against a REAL LiveKit server.
 *
 * WHAT THIS CATCHES THAT THE MEMORY FAKE CANNOT
 * ---------------------------------------------
 * The fake records the `canPublish` it was handed and hands it back. That
 * proves our use cases pass the right value; it proves nothing about whether
 * the token we mint actually ENCODES that value in a form LiveKit honours.
 *
 * A token whose grant is subtly wrong — the wrong claim name, a missing room,
 * a `canPublish` that never made it into the JWT — would pass every unit test
 * in the repo and let a listener speak in production. So the assertions below
 * decode the real signed token and inspect the grant.
 *
 * Start the server with:
 *   docker compose --profile media up -d livekit
 */
const LIVEKIT_URL = process.env.LIVEKIT_URL ?? 'ws://localhost:7880';
const API_KEY = process.env.LIVEKIT_API_KEY ?? 'devkey';
const API_SECRET = process.env.LIVEKIT_API_SECRET ?? 'devsecret-devsecret-devsecret-32';

async function livekitAvailable(): Promise<boolean> {
  try {
    const response = await fetch(LIVEKIT_URL.replace(/^ws/, 'http'), {
      signal: AbortSignal.timeout(2000),
    });
    // Any HTTP answer means something is listening and speaking HTTP; LiveKit
    // returns 404 for the bare root, which is a perfectly good liveness signal.
    return response.status > 0;
  } catch {
    return false;
  }
}

const available = await livekitAvailable();

/** Grant claims as LiveKit encodes them inside the signed token. */
interface VideoGrantClaim {
  room?: string;
  roomJoin?: boolean;
  canPublish?: boolean;
  canSubscribe?: boolean;
  canPublishData?: boolean;
}

describe.skipIf(!available)('LiveKitMediaRoomProvider', () => {
  const clock = new MemoryClock();
  const room = asRoomId('11111111-1111-4111-8111-111111111111');
  const alice = asUserId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

  let provider: LiveKitMediaRoomProvider;

  beforeAll(() => {
    provider = new LiveKitMediaRoomProvider(
      { url: LIVEKIT_URL, apiKey: API_KEY, apiSecret: API_SECRET, tokenTtlSeconds: 3600 },
      clock,
      nullLogger,
    );
  });

  afterAll(async () => {
    await provider?.closeRoom(room).catch(() => undefined);
  });

  const grantOf = (token: string): VideoGrantClaim => {
    const claims = decodeJwt(token) as { video?: VideoGrantClaim };
    return claims.video ?? {};
  };

  it('creates a room, idempotently', async () => {
    await provider.createRoom(room, { maxParticipants: 10 });
    // Called twice on purpose: the port's contract is idempotence, and LiveKit
    // rejects a duplicate name — the adapter must swallow exactly that.
    await expect(provider.createRoom(room, { maxParticipants: 10 })).resolves.toBeUndefined();
  });

  it('a LISTENER token encodes canPublish=false in the signed grant', async () => {
    // The invariant the whole product rests on, verified in the actual JWT
    // rather than in our own bookkeeping.
    const token = await provider.issueJoinToken(alice, room, false);

    expect(token.canPublish).toBe(false);
    expect(token.url).toBe(LIVEKIT_URL);

    const grant = grantOf(token.token);
    expect(grant.canPublish).toBe(false);
    expect(grant.roomJoin).toBe(true);
    expect(grant.room).toBe(token.roomName);
    // They must still HEAR the room.
    expect(grant.canSubscribe).toBe(true);
  });

  it('a SPEAKER token encodes canPublish=true', async () => {
    const token = await provider.issueJoinToken(alice, room, true);

    expect(token.canPublish).toBe(true);
    expect(grantOf(token.token).canPublish).toBe(true);
  });

  it('never grants data-channel publishing', async () => {
    // A LiveKit data channel would be a second text channel that bypasses our
    // validation, rate limiting and moderation entirely.
    for (const canPublish of [false, true]) {
      const token = await provider.issueJoinToken(alice, room, canPublish);
      expect(grantOf(token.token).canPublishData).toBe(false);
    }
  });

  it('binds the token to ONE room and ONE identity', async () => {
    // Otherwise a token issued for one room would work in another.
    const token = await provider.issueJoinToken(alice, room, false);
    const claims = decodeJwt(token.token);

    expect(claims.sub).toBe(alice);
    expect(token.identity).toBe(alice);
    expect(grantOf(token.token).room).toBe(token.roomName);
  });

  it('sets an expiry on the token', async () => {
    const token = await provider.issueJoinToken(alice, room, false);
    const claims = decodeJwt(token.token);

    expect(claims.exp).toBeDefined();
    expect(token.expiresAt.getTime()).toBeGreaterThan(clock.nowMs());
  });

  it('lists participants of an empty room without error', async () => {
    await provider.createRoom(room);
    expect(await provider.listParticipants(room)).toEqual([]);
  });

  it('treats moderation of an ABSENT participant as a no-op, not an error', async () => {
    // A host muting someone who just left must not produce an error — the
    // outcome they wanted is already true.
    await provider.createRoom(room);

    await expect(provider.revokePublish(alice, room)).resolves.toBeUndefined();
    await expect(provider.muteParticipant(alice, room, true)).resolves.toBeUndefined();
    await expect(provider.removeParticipant(alice, room)).resolves.toBeUndefined();
  });

  it('closing a room that does not exist is a no-op', async () => {
    const ghost = asRoomId('99999999-9999-4999-8999-999999999999');
    await expect(provider.closeRoom(ghost)).resolves.toBeUndefined();
  });

  it('closes a room', async () => {
    await provider.createRoom(room);
    await expect(provider.closeRoom(room)).resolves.toBeUndefined();
  });
});

describe.skipIf(available)('LiveKitMediaRoomProvider', () => {
  it.skip('skipped: LiveKit is not reachable (docker compose --profile media up -d livekit)', () => {});
});
