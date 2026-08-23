-- ============================================================================
-- 0002_streaks_and_timezone
--
-- Show-up streaks (phase 6), and the timezone they have to be counted in.
--
-- WHY THE TIMEZONE IS A COLUMN AND NOT A REQUEST HEADER
-- -----------------------------------------------------
-- A streak is counted in the user's own days, and the decision "did they show
-- up today" has to be identical whether it is made by a room join over a
-- socket, a REST call, or a background job with no request at all. Deriving it
-- from whatever the current caller happens to send would mean the same user
-- gets different answers from different devices — and a scheduled job would
-- have nothing to derive it from.
--
-- WHY BOTH AN INSTANT AND A RESOLVED DAY ARE STORED
-- -------------------------------------------------
-- `streak_last_at` is the UTC instant: the durable truth of WHEN, and the only
-- value that is meaningful independent of anyone's settings.
--
-- `streak_last_day` is the decision we made about which of the user's local
-- days that instant belonged to. It is stored rather than recomputed because
-- recomputing it means a user who flies from Auckland to Los Angeles has their
-- entire history silently reinterpreted — days merging or splitting, a streak
-- lengthening or dying, with nothing having actually happened. The day a
-- show-up counted for is settled at the moment it counted, and never revisited.
--
-- Keeping both is what makes that safe: the instant survives for auditing and
-- for any future recomputation we choose deliberately, and the day is what the
-- streak arithmetic actually reads.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- users: timezone
-- ---------------------------------------------------------------------------

-- Defaults to UTC rather than being nullable: every existing row needs an
-- answer, and "we do not know" is not one the streak arithmetic can use. The
-- client reports the browser's real zone on first sight, so the default is a
-- starting point rather than a resting place.
ALTER TABLE users
  ADD COLUMN time_zone TEXT NOT NULL DEFAULT 'UTC';

COMMENT ON COLUMN users.time_zone IS
  'IANA timezone name (e.g. Pacific/Auckland). Validated against Intl before '
  'storage; an unrecognised value would silently fall back to UTC and cost the '
  'user a day. Used ONLY for streak day boundaries.';

-- ---------------------------------------------------------------------------
-- users: streak
-- ---------------------------------------------------------------------------

ALTER TABLE users
  ADD COLUMN streak_current           INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN streak_longest           INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN streak_last_day          DATE,
  ADD COLUMN streak_last_at           TIMESTAMPTZ,
  ADD COLUMN streak_freeze_available  BOOLEAN     NOT NULL DEFAULT true;

COMMENT ON COLUMN users.streak_current IS
  'Consecutive show-up days AS LAST RECORDED. This value goes stale the moment '
  'a day passes without a show-up, and that is intended: a broken streak is '
  'never written on read. Render streakAsOf(), never this column directly.';
COMMENT ON COLUMN users.streak_longest IS
  'High-water mark. The number worth keeping when a streak ends.';
COMMENT ON COLUMN users.streak_last_day IS
  'The user-local day the last show-up was counted as. Settled at the time and '
  'never recomputed, so changing timezone cannot rewrite history.';
COMMENT ON COLUMN users.streak_last_at IS
  'The UTC instant of the last show-up. The durable truth of WHEN; '
  'streak_last_day is the decision made about it.';
COMMENT ON COLUMN users.streak_freeze_available IS
  'Whether this streak can still absorb one missed day. One per streak, '
  'restored when a streak breaks. Not earned, bought, or hoarded — see '
  'domain/values/streaks.ts for why it is deliberately not a currency.';

-- Both are set together by RecordShowUp, or neither has ever been set. A row
-- with one and not the other would mean the streak arithmetic has an instant it
-- cannot place, or a day it cannot audit.
ALTER TABLE users ADD CONSTRAINT users_streak_timestamps_together
  CHECK ((streak_last_day IS NULL     AND streak_last_at IS NULL)
      OR (streak_last_day IS NOT NULL AND streak_last_at IS NOT NULL));

-- A streak cannot exceed its own high-water mark.
ALTER TABLE users ADD CONSTRAINT users_streak_within_longest
  CHECK (streak_current <= streak_longest);

-- ---------------------------------------------------------------------------
-- rooms: the scheduler's bookkeeping
-- ---------------------------------------------------------------------------

-- WHY A SCHEDULED ROOM NEEDS A "NEXT" AND A "LAST"
-- ------------------------------------------------
-- A recurring room must survive a restart, which means the schedule cannot live
-- in a timer in one process's memory. `next_occurrence_at` is the durable
-- answer to "when should this open", written to the database, so a server that
-- comes back after an hour down knows exactly what it missed.
--
-- `last_opened_at` is what makes opening IDEMPOTENT. Two servers running the
-- scheduler concurrently, or one server retrying after a crash mid-open, must
-- not produce two live rooms from one schedule — the conditional UPDATE that
-- claims an occurrence keys on this.
ALTER TABLE rooms
  ADD COLUMN next_occurrence_at TIMESTAMPTZ,
  ADD COLUMN last_opened_at     TIMESTAMPTZ,
  ADD COLUMN schedule_time_zone TEXT;

COMMENT ON COLUMN rooms.next_occurrence_at IS
  'When this scheduled room should next open, in UTC. Durable so a recurring '
  'room survives a restart — a timer in process memory would not.';
COMMENT ON COLUMN rooms.last_opened_at IS
  'When the scheduler last opened this room. The compare-and-set key that makes '
  'opening idempotent across retries and concurrent schedulers.';
COMMENT ON COLUMN rooms.schedule_time_zone IS
  'IANA zone the schedule is expressed in. "Every night at 10pm" means 10pm '
  'where the host is, and must not drift by an hour twice a year.';

-- A scheduled room without a next occurrence is a schedule that will never
-- fire; the scheduler would skip it silently forever.
ALTER TABLE rooms ADD CONSTRAINT rooms_scheduled_has_next
  CHECK (NOT is_scheduled OR next_occurrence_at IS NOT NULL);

-- The scheduler's only query: everything due, oldest first. Partial, because
-- ad-hoc rooms are the overwhelming majority and never belong in this index.
CREATE INDEX rooms_due_idx ON rooms (next_occurrence_at)
  WHERE is_scheduled AND next_occurrence_at IS NOT NULL;
