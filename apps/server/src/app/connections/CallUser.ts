import type { MediaToken } from '../../domain/ports/MediaRoomProvider.js';
import type { User } from '../../domain/entities/User.js';
import type { Ports } from '../../domain/ports/index.js';
import type { RoomId, UserId } from '../../domain/values/ids.js';
import { callRoomId } from '../../domain/values/ids.js';
import { toPublicProfile } from '../../domain/entities/User.js';
import {
  assertCanAcceptCall,
  assertCanInviteToCall,
  assertCanStartRinging,
} from '../../domain/rules/trustLadder.js';
import { LIMITS } from '../../domain/ports/RateLimiter.js';
import { ConflictError, NotFoundError, RateLimitError } from '../../domain/errors.js';

/**
 * THE TOP RUNG — 1:1 voice, and the only place two people hear each other
 * without a room around them.
 *
 * WHY ALL FOUR STEPS LIVE IN ONE FILE
 * -----------------------------------
 * Dial, answer, decline and hang up are one protocol, and the thing that makes
 * them correct is a property of the SEQUENCE, not of any single step: exactly
 * one call between a pair at a time, answerable only by the person rung, and
 * never wedged open by a browser that died. Splitting them across four files
 * would let someone change the hang-up without seeing what the dial assumed.
 *
 * THE STATE MACHINE IS THE MUTEX
 * ------------------------------
 * `dm_open -> call_open` is a compare-and-set, so two people who dial each
 * other in the same second do not get two calls: one CAS wins, the other is
 * told the line is busy and its client falls into answering instead. There is
 * no separate lock, no "call session" table, and nothing to leak.
 *
 * WHO GETS A PUBLISHING TOKEN, AND WHEN
 * -------------------------------------
 * NOBODY, until the call is answered. `AcceptCall` is the single place in this
 * protocol that mints a credential, and it mints both of them at once — at the
 * one instant both people have agreed to be in the room.
 *
 * Dialling deliberately hands back no token, and `call:incoming` deliberately
 * carries none either. A ringing phone must not come with the credential to
 * open a microphone: the entire distinction between ringing and answering is
 * that the second one is consent. The alternative leaves a live publishing
 * credential in the browser of every call nobody picked up.
 */

/** What a participant needs to actually join the call. */
export interface CallSession {
  readonly withUserId: UserId;
  readonly callRoomId: RoomId;
  readonly mediaToken: MediaToken;
}

/**
 * What the CALLER gets back from dialling: the line is theirs, and that is all.
 *
 * NO TOKEN. A ringing call must not come with a credential to open a
 * microphone — the caller receives theirs in `call:accepted`, at the moment
 * there is someone to talk to. Minting one at dial time would mean every
 * unanswered call left a live publishing credential lying in a browser.
 */
export interface RingingCall {
  readonly withUserId: UserId;
  readonly callRoomId: RoomId;
}

/**
 * USE CASE: dial.
 */
export class InviteToCall {
  constructor(private readonly ports: Ports) {}

  async execute(caller: User, targetId: UserId): Promise<RingingCall> {
    // An unanswered phone ringing over and over IS the harassment, so this is
    // limited before anything else happens.
    const limit = await this.ports.rateLimiter.check(
      `call:invite:${caller.id}`,
      LIMITS.callInvite.limit,
      LIMITS.callInvite.windowSec,
    );
    if (!limit.allowed) {
      this.ports.metrics.increment('ratelimit.blocked');
      throw new RateLimitError('You have tried to call several times. Give it a moment.');
    }

    const target = await this.ports.users.findById(targetId);
    if (target === null) throw new NotFoundError('That person');

    const relationship = await this.ports.relationships.get(caller.id, targetId);
    const now = this.ports.clock.now();

    // Two separate questions, asked in this order because the answers mean
    // different things to the user: "you are not allowed to call this person"
    // comes before "you are allowed, but the line is busy".
    assertCanInviteToCall({ actor: caller, target, relationship });
    assertCanStartRinging(relationship, now);

    // A leftover row — a ring nobody answered or a call nobody ended — has to
    // be released before a fresh call can claim the line. Two legal steps
    // rather than one, so the transition table stays honest about what states
    // follow what.
    if (relationship.state === 'call_open') {
      const released = await this.ports.relationships.transition(
        caller.id,
        targetId,
        'call_open',
        'dm_open',
        { requestedBy: null, blockedBy: null },
        now,
      );
      if (released === null) {
        // Someone else moved it between our read and now. Whatever they did,
        // it was more current than our plan.
        throw new ConflictError('That person is already on a call.', 'CALL_BUSY');
      }
    }

    // THE MUTEX. Fails if anyone else claimed the line first.
    const ringing = await this.ports.relationships.transition(
      caller.id,
      targetId,
      'dm_open',
      'call_open',
      // Records the DIRECTION, which is what stops the caller answering their
      // own call. See Relationship.requestedBy.
      { requestedBy: caller.id, blockedBy: null },
      now,
    );

    if (ringing === null) {
      throw new ConflictError('That person is already on a call.', 'CALL_BUSY');
    }

    const roomId = callRoomId(caller.id, targetId);

    // Created now, while ringing, so that accepting is a token issue and not a
    // room creation — the slow step happens during the ring rather than in the
    // half-second after someone taps answer.
    //
    // Two participants, enforced by the media server as well as by us. Cheap
    // defence in depth against a token that somehow escapes.
    await this.ports.media.createRoom(roomId, { maxParticipants: 2 });

    await this.ports.realtime.emitToUser(targetId, 'call:incoming', {
      fromUserId: caller.id,
      from: toPublicProfile(caller),
      callRoomId: roomId,
    });

    this.ports.metrics.increment('call.invited');
    this.ports.logger.info({ callerId: caller.id, targetId, roomId }, 'call ringing');

    return { withUserId: targetId, callRoomId: roomId };
  }
}

/**
 * USE CASE: answer.
 *
 * The consent step. `assertCanAcceptCall` is what guarantees the answerer is
 * the person who was rung, that the ring has not already timed out, and that
 * the call is not already connected.
 */
export class AcceptCall {
  constructor(private readonly ports: Ports) {}

  async execute(acceptor: User, callerId: UserId): Promise<CallSession> {
    const caller = await this.ports.users.findById(callerId);
    if (caller === null) throw new NotFoundError('That person');

    const relationship = await this.ports.relationships.get(acceptor.id, callerId);
    const now = this.ports.clock.now();

    // Re-checked even though the caller was authorized at dial time, because
    // standing can change while a phone rings: an account banned in those
    // sixty seconds must not connect.
    assertCanInviteToCall({ actor: acceptor, target: caller, relationship });
    assertCanAcceptCall(relationship, acceptor.id, now);

    // Answering clears `requestedBy`: nothing is pending any more. That single
    // field is what distinguishes a ringing call from a connected one, and so
    // what stops a long conversation from looking like an abandoned ring and
    // becoming re-dialable mid-sentence.
    const connected = await this.ports.relationships.transition(
      acceptor.id,
      callerId,
      'call_open',
      'call_open',
      { requestedBy: null, blockedBy: null },
      now,
    );

    if (connected === null) {
      throw new ConflictError('That call is no longer available.', 'NO_PENDING_CALL');
    }

    const roomId = callRoomId(acceptor.id, callerId);

    // BOTH tokens are minted here, at the one moment both people have agreed
    // to be in the room. This is the only place in the call protocol that
    // issues a publishing credential.
    const mediaToken = await this.ports.media.issueJoinToken(acceptor.id, roomId, true);
    const callerToken = await this.ports.media.issueJoinToken(callerId, roomId, true);

    await this.ports.realtime.emitToUser(callerId, 'call:accepted', {
      withUserId: acceptor.id,
      callRoomId: roomId,
      mediaToken: {
        token: callerToken.token,
        url: callerToken.url,
        roomName: callerToken.roomName,
        expiresAt: callerToken.expiresAt.toISOString(),
      },
    });

    this.ports.metrics.increment('call.accepted');
    this.ports.logger.info({ acceptorId: acceptor.id, callerId, roomId }, 'call connected');

    return { withUserId: callerId, callRoomId: roomId, mediaToken };
  }
}

/**
 * USE CASE: decline, or hang up.
 *
 * ONE USE CASE FOR BOTH, because they are the same operation: release the line
 * and tell the other person. Whether audio had started is a detail of when it
 * happened, not of what has to be done.
 *
 * IT DOES NOT CHECK WHO IS ALLOWED TO END THE CALL — either party always is,
 * unconditionally, including a restricted or suspended account. Being able to
 * leave a conversation is not a privilege that can be revoked.
 */
export class EndCall {
  constructor(private readonly ports: Ports) {}

  async execute(actor: User, otherId: UserId): Promise<void> {
    const relationship = await this.ports.relationships.get(actor.id, otherId);

    if (relationship.state !== 'call_open') {
      // Already over. Hanging up twice is normal — a client that times out
      // locally and a user who taps the button both send this.
      return;
    }

    const now = this.ports.clock.now();

    const ended = await this.ports.relationships.transition(
      actor.id,
      otherId,
      'call_open',
      'dm_open',
      { requestedBy: null, blockedBy: null },
      now,
    );

    // Someone else ended it first. Nothing left to do, and no error to report.
    if (ended === null) return;

    const roomId = callRoomId(actor.id, otherId);

    // Closing the media room ejects anyone still connected. This matters for
    // the decline case in particular: the caller is already sitting in that
    // room, and without this they would stay there indefinitely, alone, with a
    // live microphone.
    await this.ports.media.closeRoom(roomId).catch((error: unknown) => {
      // The relationship is already released, which is the part that governs
      // whether they can call again. A media room that outlives its call is
      // untidy, not unsafe — it is empty and nobody holds a token for it.
      this.ports.logger.warn({ err: error, roomId }, 'could not close call room');
    });

    await this.ports.realtime.emitToUser(otherId, 'call:declined', { withUserId: actor.id });

    this.ports.logger.info({ actorId: actor.id, otherId, roomId }, 'call ended');
  }
}
