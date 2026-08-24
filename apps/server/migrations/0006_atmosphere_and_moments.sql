-- ============================================================================
-- 0006_atmosphere_and_moments
--
-- Conversation temperature, and Moments.
--
-- WHAT IS DELIBERATELY NOT IN THIS MIGRATION
-- ------------------------------------------
-- Three of the new mechanics look like they need tables and do not:
--
--   * ROOM PULSE — how a room feels right now. It decays: a room's mood at 2am
--     is not its mood at 8pm, and a table would accumulate a permanent record
--     of votes that stop being true within the hour. It lives in Redis with a
--     window, alongside room chat, for the same reason room chat does
--     (ADR 0006).
--
--   * TONIGHT'S INTENT — "I am here to listen". It is about tonight, so it
--     carries a TTL and disappears without a cleanup job. Persisted, it would
--     become a profile field, which is a bio with extra steps.
--
--   * OPEN DOOR — "I am open to meeting someone tonight". Same shape, and one
--     property a column cannot give it: if the ephemeral store is ever lost,
--     every door CLOSES. Failing closed is the only acceptable direction for a
--     signal about availability to strangers, and a Postgres column would fail
--     open by surviving.
--
-- The rule this follows is the one already in the architecture: permanent
-- record in Postgres, self-expiring state in Redis. What is left is the two
-- things that genuinely are permanent.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- rooms.temperature — the host's social contract
-- ---------------------------------------------------------------------------
--
-- WHY THIS IS A COLUMN AND THE PULSE IS NOT
-- -----------------------------------------
-- The pulse is what a room FEELS like, reported by whoever is in it, and it
-- changes through the night. The temperature is what the room is FOR, decided
-- by the host, and it must not drift with whoever turned up — that drift is
-- exactly what makes an unmoderated space unusable for the people who needed it
-- to stay one thing.
--
-- It also has to outlive every participant, including the host's connection,
-- because a scheduled room that reopens next week is still the same room with
-- the same promise attached.

ALTER TABLE rooms
  ADD COLUMN temperature TEXT NOT NULL DEFAULT 'warm'
    CHECK (temperature IN ('quiet', 'warm', 'deep'));

COMMENT ON COLUMN rooms.temperature IS
  'The room''s social contract, set by the host: quiet | warm | deep. What the '
  'room is FOR, as opposed to what it currently feels like (the pulse, which '
  'lives in Redis). The wording each one implies is in '
  'domain/values/roomTemperature.ts, deliberately not here — it is product '
  'copy that will be edited, and copy in a CHECK constraint needs a migration '
  'to change.';

-- ---------------------------------------------------------------------------
-- moments — a line worth keeping
-- ---------------------------------------------------------------------------
--
-- WHAT A MOMENT IS
-- ----------------
-- Something somebody said that a listener wanted to keep. Not a recording, not
-- a screenshot, not a shareable card: a few words, saved privately, with enough
-- context to remember where they came from.
--
-- WHY IT IS PRIVATE WITH NO SHARING PATH AT ALL
-- ---------------------------------------------
-- This is the whole design, and it is a constraint rather than a missing
-- feature. The moment anything said in a room can be published elsewhere, the
-- room changes: people start performing for the clip, and the ones who came to
-- say something difficult stop saying it. Room chat is deliberately ephemeral
-- (ADR 0006) for exactly this reason, and a Moment must not become the loophole
-- that undoes it.
--
-- So there is no author_id, no room link a third party can follow, and no
-- endpoint that returns anyone's moments but their own.
--
-- WHY THE ROOM TITLE IS COPIED RATHER THAN JOINED
-- -----------------------------------------------
-- A moment is a memory, and it should still read correctly in a year when the
-- room has been renamed, closed, or deleted. Joining would either break it or
-- silently rewrite where it happened. The copy is the point.

CREATE TABLE moments (
  id          UUID        PRIMARY KEY,
  user_id     UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  text        TEXT        NOT NULL,
  -- Where it happened, captured at the time. Nullable because a room may be
  -- gone by the time anyone reads this back.
  room_id     UUID        REFERENCES rooms (id) ON DELETE SET NULL,
  room_title  TEXT        NOT NULL,
  saved_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The only query: one person's own moments, newest first.
CREATE INDEX moments_user_idx ON moments (user_id, saved_at DESC);

COMMENT ON TABLE moments IS
  'Lines from a room that a listener chose to keep. PRIVATE TO THE SAVER — '
  'there is no sharing path, deliberately: anything sayable in a room that can '
  'be published outside it changes what people are willing to say in rooms.';
COMMENT ON COLUMN moments.text IS
  'The words, as saved. No attribution: who said it is not recorded, because a '
  'record of who said what is exactly what ephemeral room chat exists to avoid.';
COMMENT ON COLUMN moments.room_title IS
  'Copied at save time, not joined. A memory should still read correctly after '
  'the room is renamed or deleted.';

-- ---------------------------------------------------------------------------
-- RLS, matching migration 0005
-- ---------------------------------------------------------------------------
-- Enabled with no policy: nothing outside the API has any business reading a
-- person's private saved moments.
ALTER TABLE moments ENABLE ROW LEVEL SECURITY;
