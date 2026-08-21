import type { User } from '../../domain/entities/User.js';
import type { Ports } from '../../domain/ports/index.js';
import type { RoomStateView } from '../../domain/ports/RealtimeTransport.js';
import type { RoomId } from '../../domain/values/ids.js';
import { isJoinable } from '../../domain/entities/Room.js';
import { initialRole, canAct, DENIAL_MESSAGES } from '../../domain/rules/trustLadder.js';
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

    // Was this user already present? Determines whether the room hears about
    // it, and it must be read BEFORE we write presence.
    const existing = await this.ports.presence.getMember(roomId, user.id);
    const isNewArrival = existing === null;

    const role = existing?.role ?? initialRole(room.hostUserId === user.id);
    const now = this.ports.clock.now();

    // 1. Live presence — the source of truth for "who is here".
    await this.ports.presence.setOnline({
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

    // 5. The snapshot. Built AFTER presence is written, so the joiner sees
    //    themselves in the member list.
    const state = await buildRoomState(this.ports, room, { viewerId: user.id });

    this.ports.logger.info(
      { roomId, userId: user.id, role, isNewArrival, members: state.members.length },
      isNewArrival ? 'user joined room' : 'user reconnected to room',
    );

    return { state, isNewArrival };
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
