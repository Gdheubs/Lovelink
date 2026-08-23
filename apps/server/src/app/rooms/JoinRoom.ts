import type { User } from '../../domain/entities/User.js';
import type { Ports } from '../../domain/ports/index.js';
import type { RoomStateView } from '../../domain/ports/RealtimeTransport.js';
import type { RoomId } from '../../domain/values/ids.js';
import { recordShowUp } from '../../domain/values/streaks.js';
import { isJoinable } from '../../domain/entities/Room.js';
import {
  initialRole,
  canAct,
  canPublish,
  DENIAL_MESSAGES,
} from '../../domain/rules/trustLadder.js';
import { LIMITS } from '../../domain/ports/RateLimiter.js';
import { buildMemberView, buildRoomState } from './roomStateView.js';
import {
  AuthorizationError,
  ConflictError,
  NotFoundError,
  RateLimitError,
} from '../../domain/errors.js';

/**
 * USE CASE: join a room.
 *
 * THE DEFINING RULE OF THE PRODUCT LIVES HERE
 * -------------------------------------------
 * Everyone joins as a LISTENER. There is no parameter to request otherwise, and
 * no branch that grants a higher role — the only exception is the room's own
 * host, decided by comparing `room.hostUserId`, never by anything the client
 * sent. Speaking is granted later by `ApproveSpeaker` (Phase 3), which is the
 * only code that will ever issue a publish-enabled media token.
 *
 * Encoding this as "the input type has no role field" is stronger than
 * validating a role away: there is nothing for a modified client to smuggle,
 * and no reviewer has to notice its absence.
 *
 * WHY BOTH PRESENCE AND A DURABLE ROW ARE WRITTEN
 * -----------------------------------------------
 * They answer different questions and have different lifetimes:
 *
 *   PresenceStore (Redis)   "who is here right now" — TTL'd, rewritten on every
 *                            heartbeat, gone when the phone locks.
 *   room_members (Postgres)  "who was here, and when" — permanent, and the
 *                            evidence behind the trust ladder's DM rung.
 *
 * If only presence were written, a Redis flush would silently revoke every
 * existing DM right in the system. If only the durable row were written, the
 * member list would be a write storm on mobile networks.
 *
 * IDEMPOTENT: joining a room you are already in refreshes presence and returns
 * a fresh snapshot. That is exactly what a reconnecting client does, and it
 * must not produce a second `user:joined` broadcast or a second membership row.
 */
export interface JoinRoomResult {
  readonly state: RoomStateView;
  /** False when this was a reconnect rather than a new arrival. */
  readonly isNewArrival: boolean;
}

export class JoinRoom {
  constructor(private readonly ports: Ports) {}

  async execute(user: User, roomId: RoomId): Promise<JoinRoomResult> {
    const standing = canAct(user);
    if (!standing.allowed) {
      throw new AuthorizationError(
        DENIAL_MESSAGES[standing.reason ?? 'account_inactive'],
        standing.reason === 'trust_restricted' ? 'TRUST_LADDER_VIOLATION' : 'FORBIDDEN',
      );
    }

    await this.enforceJoinLimit(user.id);

    const room = await this.ports.rooms.findById(roomId);
    if (room === null) throw new NotFoundError('Room');

    if (!isJoinable(room)) {
      throw new ConflictError('That room has closed.', 'ROOM_CLOSED', { roomId });
    }

    // Their existing standing, if any — role and host-mute must survive a
    // reconnect, or a muted user could clear it by rejoining.
    const existing = await this.ports.presence.getMember(roomId, user.id);

    const role = existing?.role ?? initialRole(room.hostUserId === user.id);
    const now = this.ports.clock.now();

    // 1. Live presence — the source of truth for "who is here".
    //
    //    `setOnline` REPORTS whether it made them newly present, and that
    //    answer is what decides whether the room is told. Reading presence
    //    first and comparing would be a check-then-act race: a double-tapped
    //    join fires several times before any has written, and every one of
    //    them would believe it was the first.
    const isNewArrival = await this.ports.presence.setOnline({
      userId: user.id,
      roomId,
      role,
      mutedByHost: existing?.mutedByHost ?? false,
    });

    // 2. Durable history — idempotent for an already-open row, so a reconnect
    //    refreshes rather than opening a second session.
    await this.ports.rooms.recordJoin({
      roomId,
      userId: user.id,
      role,
      joinedAt: existing === null ? now : new Date(existing.lastSeenMs),
      mutedByHost: existing?.mutedByHost ?? false,
    });

    // 3. Subscribe every one of this user's connections to the room channel.
    await this.ports.realtime.joinRoomChannel(user.id, roomId);

    // 4. Tell the room — but only for a genuine arrival. A reconnect that
    //    re-announced someone would make a flaky connection look, to everyone
    //    else, like a person repeatedly walking in and out.
    if (isNewArrival) {
      const entry = await this.ports.presence.getMember(roomId, user.id);
      if (entry !== null) {
        const member = await buildMemberView(this.ports, entry);
        if (member !== null) {
          // Except the joiner: they are receiving the authoritative snapshot
          // below and do not need to be told about themselves.
          await this.ports.realtime.emitToRoomExcept(roomId, user.id, 'user:joined', {
            roomId,
            member,
          });
        }
      }
      this.ports.metrics.increment('room.joined');
    }

    // 4b. Today counted.
    //
    //     Deliberately fire-and-forget. A streak is a nicety, and being unable
    //     to walk into a room because a counter could not be written would be
    //     an absurd trade. The domain call is idempotent within a day, so the
    //     common case (rejoining for the fourth time this evening) writes
    //     nothing at all.
    void this.recordShowUp(user);

    // 5. A media credential, so they can HEAR the room.
    //
    //    `canPublish` comes from the DOMAIN, never from anything the client
    //    sent — and for a listener it is false. This is the join path, and the
    //    join path never grants audio: promotion is the only thing that does.
    const mediaToken = await this.issueMediaToken(user, roomId, room.maxSpeakers);

    // 6. The snapshot. Built AFTER presence is written, so the joiner sees
    //    themselves in the member list.
    const state = await buildRoomState(this.ports, room, {
      viewerId: user.id,
      ...(mediaToken === null ? {} : { mediaToken }),
    });

    this.ports.logger.info(
      { roomId, userId: user.id, role, isNewArrival, members: state.members.length },
      isNewArrival ? 'user joined room' : 'user reconnected to room',
    );

    return { state, isNewArrival };
  }

  /**
   * Count today, swallowing any failure.
   *
   * Inlined rather than injected as a use case to avoid a construction cycle in
   * the registry, and kept tiny for the same reason the call site is `void`:
   * nothing here is allowed to affect whether the join succeeded.
   */
  private async recordShowUp(user: User): Promise<void> {
    try {
      const now = this.ports.clock.now();
      const next = recordShowUp(user.streak, now, user.timeZone);

      // Reference equality: the domain returns the SAME object when the day was
      // already counted, so this is the "no write needed" signal.
      if (next === user.streak) return;

      await this.ports.users.saveStreak(user.id, next, now);
      if (next.current > user.streak.current) {
        this.ports.metrics.increment('streak.extended');
      }
    } catch (error) {
      this.ports.logger.warn(
        { userId: user.id, err: String(error) },
        'could not record the show-up; the join is unaffected',
      );
    }
  }

  /**
   * Mint a media credential for the joining user.
   *
   * TWO THINGS TO NOTICE:
   *
   * 1. `canPublish` is computed by `rules/trustLadder.ts` from the membership
   *    we just wrote. A joiner is a listener, so it is false. The adapter takes
   *    it as a parameter and never decides for itself — that is what makes
   *    "listening is the default" structural rather than conventional.
   *
   * 2. A FAILURE HERE DOES NOT FAIL THE JOIN. If the media server is down, the
   *    room still works as a text room: people can see each other and chat,
   *    they simply cannot hear anything. Refusing the join instead would let a
   *    media outage take down the entire product, when it should degrade to
   *    the thing Phase 2 shipped.
   */
  private async issueMediaToken(
    user: User,
    roomId: RoomId,
    maxSpeakers: number,
  ): Promise<RoomStateView['mediaToken'] | null> {
    const membership = await this.ports.presence.getMember(roomId, user.id);
    const decision = canPublish(user, membership);

    try {
      // Idempotent, and done at first join rather than at room creation so a
      // scheduled room nobody attends never consumes media-server resources.
      await this.ports.media.createRoom(roomId, { maxParticipants: maxSpeakers + 50 });

      const token = await this.ports.media.issueJoinToken(user.id, roomId, decision.allowed);

      return {
        token: token.token,
        url: token.url,
        roomName: token.roomName,
        canPublish: token.canPublish,
        expiresAt: token.expiresAt.toISOString(),
      };
    } catch (error) {
      this.ports.logger.error(
        { roomId, userId: user.id, err: String(error) },
        'could not issue a media token; the room degrades to text only',
      );
      return null;
    }
  }

  private async enforceJoinLimit(userId: string): Promise<void> {
    const result = await this.ports.rateLimiter.check(
      `room:join:${userId}`,
      LIMITS.roomJoin.limit,
      LIMITS.roomJoin.windowSec,
    );
    if (!result.allowed) {
      this.ports.metrics.increment('ratelimit.blocked');
      throw new RateLimitError('You are joining rooms too quickly. Wait a moment.');
    }
  }
}
