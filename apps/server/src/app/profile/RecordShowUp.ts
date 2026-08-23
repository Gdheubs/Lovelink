import type { User } from '../../domain/entities/User.js';
import type { Ports } from '../../domain/ports/index.js';
import type { StreakView } from '../../domain/values/streaks.js';
import { recordShowUp, streakAsOf } from '../../domain/values/streaks.js';
import { NotFoundError, ValidationError } from '../../domain/errors.js';

/**
 * USE CASE: this person turned up today.
 *
 * WHAT COUNTS AS SHOWING UP
 * -------------------------
 * Joining a room. Not opening the app, not signing in, not reading a message —
 * walking into a room where other people are.
 *
 * That is a deliberate and slightly demanding choice. Counting an app open
 * would make the number trivial to keep and therefore worth nothing; counting
 * "spoke for five minutes" would exclude the listeners this product is mostly
 * built for, who are doing exactly the right thing by being there quietly. A
 * room join is the smallest act that is actually the point.
 *
 * WHY IT IS SAFE TO CALL ON EVERY SINGLE JOIN
 * -------------------------------------------
 * `recordShowUp` in the domain is idempotent within a day and returns the SAME
 * OBJECT when nothing changed, so the common case — someone rejoining a room
 * for the fourth time this evening — does no write at all. The caller does not
 * have to know whether today already counted, which means no call site has to
 * remember to ask.
 *
 * WHY A FAILURE HERE MUST NEVER FAIL A JOIN
 * -----------------------------------------
 * A streak is a nicety. Being unable to walk into a room because a counter
 * could not be written would be an absurd trade, so callers on the join path
 * are expected to let this fail quietly — see JoinRoom.
 */
export class RecordShowUp {
  constructor(private readonly ports: Ports) {}

  async execute(user: User): Promise<StreakView> {
    const now = this.ports.clock.now();
    const next = recordShowUp(user.streak, now, user.timeZone);

    // Reference equality, not a deep compare: the domain returns the same
    // object when the day was already counted, and that is the signal.
    if (next !== user.streak) {
      await this.ports.users.saveStreak(user.id, next, now);

      if (next.current > user.streak.current) {
        this.ports.metrics.increment('streak.extended');
      }
    }

    return streakAsOf(next, now, user.timeZone);
  }
}

/**
 * USE CASE: read the streak without changing it.
 *
 * Separate from the write on purpose. The stored `current` goes stale the
 * moment a day passes, so rendering it directly would tell someone they have a
 * twelve-day streak a week after it ended — and the fix is emphatically NOT to
 * write the break when they happen to look. That would make a person's history
 * depend on whether they opened the app, so two users with identical behaviour
 * would end up with different records.
 *
 * The truth is stored; the presentation is computed.
 */
export class GetStreak {
  constructor(private readonly ports: Ports) {}

  async execute(user: User): Promise<StreakView> {
    return streakAsOf(user.streak, this.ports.clock.now(), user.timeZone);
  }
}

/**
 * USE CASE: tell the server which day boundary to use for this person.
 *
 * WHY THE SERVER STORES THIS RATHER THAN READING A HEADER
 * -------------------------------------------------------
 * The decision "did they show up today" must be identical whether it is made by
 * a socket join, a REST call, or a background job with no request in flight at
 * all. Deriving it per-request means a user's phone and laptop can disagree,
 * and a scheduled job has nothing to derive it from.
 *
 * CHANGING IT DOES NOT REWRITE HISTORY. Past show-ups keep the local day they
 * were counted as, because that decision was made at the time and revisiting it
 * would silently merge or split days for anyone who travels — lengthening or
 * killing a streak with nothing having actually happened. The new zone applies
 * from the next show-up onwards.
 */
export class SetTimeZone {
  constructor(private readonly ports: Ports) {}

  async execute(user: User, timeZone: string): Promise<void> {
    if (!isKnownTimeZone(timeZone)) {
      throw new ValidationError('That is not a timezone we recognise.');
    }

    if (timeZone === user.timeZone) return;

    const existing = await this.ports.users.findById(user.id);
    if (existing === null) throw new NotFoundError('Your account');

    await this.ports.users.updateTimeZone(user.id, timeZone);
    this.ports.logger.debug({ userId: user.id, timeZone }, 'timezone updated');
  }
}

/**
 * Whether the runtime recognises this IANA zone.
 *
 * Validated on the way IN rather than tolerated on the way out. `localDayOf`
 * does fall back to UTC for an unknown zone — it has to, since it must never
 * throw on the join path — but a value that silently costs someone a day is
 * exactly the kind of thing to reject at the edge, where there is still a
 * person to tell.
 */
function isKnownTimeZone(value: string): boolean {
  // Bounded before it reaches Intl: a zone name is short, and an unbounded
  // string here is a cheap way to make the server do expensive validation.
  if (value.length === 0 || value.length > 64) return false;

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
