import type { Room } from '../../domain/entities/Room.js';
import type { Ports } from '../../domain/ports/index.js';
import { nextOccurrence } from '../../domain/values/schedule.js';

/**
 * USE CASE: open every scheduled room whose time has come.
 *
 * WHY A SWEEP AND NOT A TIMER PER ROOM
 * ------------------------------------
 * The obvious implementation is `setTimeout` for each scheduled room. It is
 * also the one that quietly breaks, because a timer lives in one process's
 * memory: a deploy at 21:55 cancels the 22:00 room, and nobody reports it —
 * the failure is an ABSENCE, and people do not file bugs about a room that was
 * not there. They just stop coming.
 *
 * So the schedule lives in the database, and this sweep asks "what is due?"
 * every minute. A server that has been down for an hour comes back, runs the
 * sweep, and finds exactly what it missed. That is the whole restart-survival
 * property, and it comes from the schedule being a row rather than a timer.
 *
 * WHY OPENING IS A COMPARE-AND-SET
 * --------------------------------
 * During a rolling deploy two servers run this at once, and both will see the
 * same room as due within the same second. `claimOccurrence` moves
 * `next_occurrence_at` as part of the same statement that reads it, so exactly
 * one of them wins and the room is announced once.
 *
 * A MISSED OCCURRENCE IS SKIPPED, NOT REPLAYED
 * --------------------------------------------
 * If the server was down for six hours, a nightly room does NOT open six times
 * to catch up. The next occurrence is computed forward from NOW, so the room
 * opens once — now — and then resumes its normal schedule. Replaying missed
 * slots would mean coming back from an outage into a flood of rooms nobody
 * asked for.
 */

/** Bounded so one sweep cannot run long enough to overlap the next. */
const MAX_PER_SWEEP = 50;

export interface SweepResult {
  readonly opened: number;
  readonly claimedByAnother: number;
  readonly disabled: number;
}

export class OpenScheduledRooms {
  constructor(private readonly ports: Ports) {}

  async execute(): Promise<SweepResult> {
    const now = this.ports.clock.now();
    const due = await this.ports.rooms.listDueSchedules(now, MAX_PER_SWEEP);

    let opened = 0;
    let claimedByAnother = 0;
    let disabled = 0;

    for (const room of due) {
      // Cannot be null — `listDueSchedules` filters on it — but the type says
      // it can, and a crash inside a sweep would strand every room after it.
      if (room.nextOccurrenceAt === null) continue;

      const outcome = await this.openOne(room, now);
      if (outcome === 'opened') opened += 1;
      else if (outcome === 'lost') claimedByAnother += 1;
      else disabled += 1;
    }

    if (opened > 0 || disabled > 0) {
      this.ports.logger.info({ opened, claimedByAnother, disabled }, 'scheduled room sweep');
    }

    return { opened, claimedByAnother, disabled };
  }

  private async openOne(room: Room, now: Date): Promise<'opened' | 'lost' | 'disabled'> {
    const cron = room.scheduleCron;

    if (cron === null) {
      // A scheduled room with no expression can never fire again. Clearing the
      // occurrence stops it being re-read on every sweep forever.
      await this.disable(room, 'a scheduled room has no schedule');
      return 'disabled';
    }

    // Forward from NOW, not from the occurrence: see the note above about not
    // replaying a backlog after an outage.
    const next = nextOccurrence(cron, room.scheduleTimeZone ?? 'UTC', now);

    if (next === null) {
      // An expression that will never match again — "30 February", or one that
      // stopped parsing. Left alone it would be re-read on every sweep, forever,
      // and the host would never learn why their room stopped appearing.
      await this.disable(room, 'schedule has no future occurrence');
      return 'disabled';
    }

    const claimed = await this.ports.rooms.claimOccurrence({
      roomId: room.id,
      now,
      nextOccurrenceAt: next,
      openedAt: now,
    });

    if (!claimed) return 'lost';

    // Announced only after the claim succeeds. Emitting first would mean the
    // loser of the race also announced it.
    await this.ports.bus.publish('rooms', {
      type: 'room.opened',
      roomId: room.id,
      slug: room.slug,
      title: room.title,
      scheduled: true,
    });

    this.ports.metrics.increment('room.scheduled.opened');
    this.ports.logger.info(
      { roomId: room.id, slug: room.slug, nextAt: next.toISOString() },
      'scheduled room opened',
    );

    return 'opened';
  }

  /**
   * Stop a broken schedule from being re-read forever.
   *
   * The room itself is NOT deleted and its cron is NOT cleared — the host's
   * intent is still on the row, and a human looking at it can see both what
   * they asked for and that it is not firing. Only `next_occurrence_at` is
   * dropped, which is precisely what takes it out of the sweep.
   */
  private async disable(room: Room, reason: string): Promise<void> {
    await this.ports.rooms.disableSchedule(room.id);

    this.ports.logger.warn(
      { roomId: room.id, slug: room.slug, cron: room.scheduleCron, reason },
      'disabled a room schedule that cannot fire',
    );
  }
}
