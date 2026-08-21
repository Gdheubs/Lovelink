import type { Ban } from '../../domain/entities/Ban.js';
import type { Ports } from '../../domain/ports/index.js';
import type { UserId } from '../../domain/values/ids.js';
import type { ModeratorDirectory } from '../../domain/rules/moderation.js';
import { assertCanBan, banExpiry, statusFromBans } from '../../domain/rules/moderation.js';
import type { LeaveRoom } from '../rooms/LeaveRoom.js';
import { TRUST_DELTAS } from '../../domain/values/trust.js';
import { NotFoundError } from '../../domain/errors.js';

/**
 * USE CASE: ban an account.
 *
 * A BAN IS THREE THINGS, AND ALL THREE MUST HAPPEN
 * ------------------------------------------------
 *   1. A DURABLE RECORD  — the `bans` row, which is the source of truth.
 *   2. REVOKED CREDENTIALS — every session killed, so no token outlives it.
 *      A refresh token is valid for thirty days; without this the ban would be
 *      decorative for a month.
 *   3. IMMEDIATE EJECTION — the live socket severed and the media grant pulled,
 *      because the person a moderator is banning is, very often, mid-abuse
 *      right now.
 *
 * The order is deliberate: RECORD first. If the process dies after step 1 the
 * ban still holds — the next connect attempt checks status and refuses. If it
 * died after step 3 but before step 1, the user would be kicked and then walk
 * straight back in, which is worse than useless because it looks like it worked.
 *
 * ENFORCEMENT IS BELT AND BRACES, ON PURPOSE
 * ------------------------------------------
 * Three independent checks stop a banned user acting, and none of them is
 * sufficient alone:
 *
 *   - socket connect     — closes the "reconnects later" window
 *   - token refresh      — closes the "still holds a refresh token" window
 *   - this force-disconnect + EventBus — closes the "connected right now"
 *     window
 *
 * The bus is best-effort (Redis pub/sub is at-most-once), so it makes
 * enforcement IMMEDIATE while the other two make it CERTAIN.
 */
export interface BanUserInput {
  readonly targetId: UserId;
  readonly reason: string;
  /** Null for a permanent ban; a positive number of hours for a suspension. */
  readonly hours: number | null;
  /** Optional report this ban resolves, recorded on the trust ledger. */
  readonly context?: string | null;
}

export class BanUser {
  constructor(
    private readonly ports: Ports,
    private readonly moderators: ModeratorDirectory,
    /**
     * Departure goes through the SAME use case as every other leave.
     *
     * Injected rather than reimplemented here: an earlier version of the
     * presence reaper did its own partial cleanup and silently diverged (see
     * the audit, F-series). A ban is just one more way to leave a room.
     */
    private readonly leaveRoom: LeaveRoom,
  ) {}

  async execute(moderatorId: UserId, input: BanUserInput): Promise<Ban> {
    // Moderator authority comes from the CONFIG allowlist, not a database
    // column — see rules/moderation.ts for why that is deliberate.
    assertCanBan(this.moderators, moderatorId, input.targetId);

    const target = await this.ports.users.findById(input.targetId);
    if (target === null) throw new NotFoundError('That person');

    const now = this.ports.clock.now();
    const expiresAt = banExpiry(now, input.hours);

    // 1. THE DURABLE RECORD. Everything else can be redone from this.
    const ban = await this.ports.reports.createBan({
      userId: input.targetId,
      reason: input.reason,
      expiresAt,
      issuedBy: moderatorId,
      issuedAt: now,
    });

    // Project the ban onto the cached status the hot path reads.
    const bans = await this.ports.reports.listBans(input.targetId);
    await this.ports.users.updateStatus(input.targetId, statusFromBans(target.status, bans, now));

    // 2. REVOKE EVERY CREDENTIAL. Without this the refresh token outlives the
    //    ban by up to thirty days.
    await this.ports.tokens.revokeAllSessions(input.targetId);

    // 3. EJECT THEM NOW — from rooms, from audio, from the socket.
    await this.ejectFromEverywhere(input.targetId);

    await this.ports.bus.publish('moderation', {
      type: 'user.banned',
      userId: input.targetId,
      permanent: expiresAt === null,
      reason: input.reason,
    });

    // The ledger explains the account's standing afterwards.
    await this.ports.users
      .appendTrustEvent({
        userId: input.targetId,
        delta: TRUST_DELTAS.banned,
        reason: 'banned',
        context: input.context ?? null,
        createdAt: now,
      })
      .catch(() => undefined);

    this.ports.metrics.increment('user.banned');
    this.ports.logger.warn(
      { targetId: input.targetId, moderatorId, permanent: expiresAt === null },
      'user banned',
    );

    return ban;
  }

  /**
   * Remove a banned user from every room they are in, then sever the socket.
   *
   * ROOMS FIRST, SOCKET LAST. Disconnecting first would leave presence entries
   * behind until the reaper swept them, so for up to a TTL the room would still
   * list a person who has been banned — and a host trying to understand why
   * they cannot moderate someone would find a ghost.
   */
  private async ejectFromEverywhere(userId: UserId): Promise<void> {
    const rooms = await this.ports.presence.getRoomsForUser(userId);

    for (const roomId of rooms) {
      // Pull the media grant explicitly. Leaving the room does not by itself
      // stop a live audio track — that is the difference between the person
      // disappearing from a list and the room actually going quiet.
      await this.ports.media.revokePublish(userId, roomId).catch(() => undefined);
      await this.ports.media.removeParticipant(userId, roomId).catch(() => undefined);

      await this.ports.realtime.emitToRoom(roomId, 'speaker:demoted', {
        roomId,
        userId,
        reason: 'banned',
      });

      await this.leaveRoom.execute({ userId, roomId, reason: 'banned' });
    }

    await this.ports.realtime.disconnectUser(userId, 'banned');
  }
}

/**
 * USE CASE: lift a ban.
 *
 * Restores the account rather than merely marking the ban inactive: the
 * projection in `statusFromBans` turns "no active bans" back into `active`, so
 * an unbanned user is not left permanently locked out by a stale cached status.
 */
export class LiftBan {
  constructor(
    private readonly ports: Ports,
    private readonly moderators: ModeratorDirectory,
  ) {}

  async execute(moderatorId: UserId, targetId: UserId): Promise<void> {
    assertCanBan(this.moderators, moderatorId, targetId);

    const target = await this.ports.users.findById(targetId);
    if (target === null) throw new NotFoundError('That person');

    const now = this.ports.clock.now();
    await this.ports.reports.liftBan(targetId, now);

    const bans = await this.ports.reports.listBans(targetId);
    await this.ports.users.updateStatus(targetId, statusFromBans(target.status, bans, now));

    this.ports.logger.info({ targetId, moderatorId }, 'ban lifted');
  }
}
