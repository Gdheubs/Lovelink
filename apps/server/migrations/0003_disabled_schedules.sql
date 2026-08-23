-- ============================================================================
-- 0003_disabled_schedules
--
-- Allow a room to KEEP the schedule it was given after that schedule has been
-- switched off.
--
-- WHY THIS LOOSENING IS NEEDED
-- ----------------------------
-- Migration 0001 made `is_scheduled` and `schedule_cron` a biconditional: a
-- scheduled room must carry a cron, and an ad-hoc one must not. That was right
-- when the only two states were "recurring" and "not", and it is what stops the
-- scheduler having to guess.
--
-- Phase 6 introduced a third state the original pair cannot express: a schedule
-- that was accepted, and can no longer fire. It happens when an expression
-- matches no future date, or stops parsing after an edit, and the sweep has to
-- do something about it — a row left due-but-unfireable is re-read on every
-- sweep, forever.
--
-- Switching it off means `is_scheduled = false`. Under the old constraint that
-- also forced `schedule_cron` to NULL, which throws away the one thing a human
-- needs: WHAT THE HOST ASKED FOR. Someone looking at the row would see an
-- ordinary ad-hoc room and no reason their nightly room stopped appearing.
--
-- So the constraint becomes an IMPLICATION rather than a biconditional:
--
--     is_scheduled  =>  schedule_cron IS NOT NULL
--
-- The scheduler still cannot be handed a schedule with no expression, which was
-- the whole point of the original rule. What is now permitted is the reverse:
-- a room that is not scheduled but remembers that it once was.
--
-- READ `is_scheduled` AND NOT `schedule_cron IS NOT NULL` to decide whether a
-- room recurs. They are no longer the same question.
-- ============================================================================

ALTER TABLE rooms DROP CONSTRAINT rooms_schedule_consistency;

ALTER TABLE rooms ADD CONSTRAINT rooms_schedule_consistency
  CHECK (NOT is_scheduled OR schedule_cron IS NOT NULL);

COMMENT ON COLUMN rooms.schedule_cron IS
  'Cron expression for recurring rooms. Retained when a schedule is disabled '
  '(is_scheduled = false) so a human can see what the host asked for and that '
  'it is no longer firing. Use is_scheduled to decide whether a room recurs.';

-- The partial index from 0002 already excludes rooms with no next occurrence,
-- so a disabled schedule drops out of the scheduler's query for free.
