-- ============================================================================
-- 0001_initial_schema
--
-- The permanent record: accounts, rooms, membership history, relationships,
-- surprises, and the safety tables (reports, bans, trust_events).
--
-- WHAT IS DELIBERATELY NOT HERE
--   * live presence      -> Redis (PresenceStore). Writing a row per reconnect
--                           would be a write storm on mobile networks.
--   * room chat          -> Redis ring buffer. Room chat is ephemeral by
--                           product design; see MessageRepository.
--   * rate limit counters-> Redis. They must expire, and they are worthless
--                           after they do.
--
-- Every table and column carries a COMMENT. They are the documentation an
-- engineer reads at 3am from psql, and they cost nothing to maintain.
-- ============================================================================

-- gen_random_uuid() lives here on PostgreSQL < 13; harmless on newer versions.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id             UUID PRIMARY KEY,
  identifier     TEXT        NOT NULL,
  identifier_kind TEXT       NOT NULL CHECK (identifier_kind IN ('phone', 'email')),
  display_name   TEXT        NOT NULL,
  avatar_seed    TEXT        NOT NULL,
  dob            DATE        NOT NULL,
  trust_score    INTEGER     NOT NULL DEFAULT 0,
  status         TEXT        NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active', 'suspended', 'banned', 'deleted')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One account per contact. Case/format normalization happens in the auth use
-- case BEFORE the insert, so this index is over already-canonical values.
CREATE UNIQUE INDEX users_identifier_key ON users (identifier);

-- The admin dashboard lists recent signups; without this it sequential-scans.
CREATE INDEX users_created_at_idx ON users (created_at DESC);

COMMENT ON TABLE  users IS
  'People on the platform. 18+ enforced server-side at registration from dob.';
COMMENT ON COLUMN users.identifier IS
  'E.164 phone or lowercased email. Canonical form; unique across the platform.';
COMMENT ON COLUMN users.identifier_kind IS
  'Which channel identifier is. Kept so the auth adapter knows how to reach them.';
COMMENT ON COLUMN users.avatar_seed IS
  'Deterministic seed for a generated avatar. No image uploads at MVP, by design.';
COMMENT ON COLUMN users.dob IS
  'Date of birth. Never exposed to other users; age is computed, never stored.';
COMMENT ON COLUMN users.trust_score IS
  'DERIVED: cached projection of sum(trust_events.delta), clamped to [-100,100]. '
  'Never incremented in place — see trust_events.';
COMMENT ON COLUMN users.status IS
  'Cached projection of the active ban, for the hot path. If this and bans '
  'disagree, bans win (see rules/moderation.ts statusFromBans).';

-- ---------------------------------------------------------------------------
-- rooms
-- ---------------------------------------------------------------------------
CREATE TABLE rooms (
  id            UUID PRIMARY KEY,
  slug          TEXT        NOT NULL,
  title         TEXT        NOT NULL,
  category      TEXT        NOT NULL
                            CHECK (category IN ('study','late_night','music','support','casual')),
  host_user_id  UUID        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  is_scheduled  BOOLEAN     NOT NULL DEFAULT false,
  schedule_cron TEXT,
  max_speakers  SMALLINT    NOT NULL DEFAULT 4 CHECK (max_speakers BETWEEN 1 AND 8),
  status        TEXT        NOT NULL DEFAULT 'live'
                            CHECK (status IN ('scheduled', 'live', 'closed')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX rooms_slug_key ON rooms (slug);

-- The room list is always filtered by status and usually by category.
CREATE INDEX rooms_status_category_idx ON rooms (status, category, created_at DESC);
CREATE INDEX rooms_host_idx ON rooms (host_user_id);

-- A scheduled room must carry a cron, and an ad-hoc one must not — otherwise
-- the scheduler has to guess, and it will guess wrong.
ALTER TABLE rooms ADD CONSTRAINT rooms_schedule_consistency
  CHECK ((is_scheduled AND schedule_cron IS NOT NULL)
      OR (NOT is_scheduled AND schedule_cron IS NULL));

COMMENT ON TABLE  rooms IS
  'Themed drop-in voice rooms. Lifecycle only — live membership is in Redis.';
COMMENT ON COLUMN rooms.host_user_id IS
  'ON DELETE RESTRICT: a hostless room is unmoderatable, so accounts with rooms '
  'are soft-deleted (status=deleted) rather than removed.';
COMMENT ON COLUMN rooms.max_speakers IS
  'Cap on the stage. Enforced by ApproveSpeaker, not by the media server, so it '
  'is testable without LiveKit. Host is not counted against this cap.';
COMMENT ON COLUMN rooms.schedule_cron IS
  'Cron expression for recurring rooms; NULL for ad-hoc. See the CHECK above.';

-- ---------------------------------------------------------------------------
-- room_members  — the DURABLE membership mirror
-- ---------------------------------------------------------------------------
CREATE TABLE room_members (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  room_id       UUID        NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  user_id       UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role          TEXT        NOT NULL DEFAULT 'listener'
                            CHECK (role IN ('listener', 'speaker', 'host')),
  joined_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at       TIMESTAMPTZ,
  muted_by_host BOOLEAN     NOT NULL DEFAULT false
);

-- At most ONE open row per (room, user). A reconnect refreshes it rather than
-- opening a second, or session counting and the shared-session query break.
CREATE UNIQUE INDEX room_members_one_open_session
  ON room_members (room_id, user_id) WHERE left_at IS NULL;

-- Backs haveSharedRoomSession(a, b): find every room a user has been in, then
-- overlap the intervals. Without this it is a full scan on every DM request.
CREATE INDEX room_members_user_room_idx ON room_members (user_id, room_id, joined_at);
CREATE INDEX room_members_room_idx      ON room_members (room_id, joined_at DESC);

COMMENT ON TABLE  room_members IS
  'Durable history of who was in which room and when. NOT live presence — that '
  'is Redis. This survives a Redis flush, which is why the trust ladder reads '
  'it: losing it would revoke every existing DM right in the system.';
COMMENT ON COLUMN room_members.left_at IS
  'NULL means still present. The interval [joined_at, left_at) is what '
  'haveSharedRoomSession overlaps to prove two people actually met.';
COMMENT ON COLUMN room_members.muted_by_host IS
  'Host-applied mute. Silences text as well as audio — a muted user typing the '
  'same abuse into chat is the obvious next move.';

-- ---------------------------------------------------------------------------
-- relationships  — the trust ladder between two users
-- ---------------------------------------------------------------------------
CREATE TABLE relationships (
  user_a       UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  user_b       UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  state        TEXT        NOT NULL DEFAULT 'none'
                           CHECK (state IN ('none','dm_requested','dm_open','call_open','blocked')),
  requested_by UUID        REFERENCES users (id) ON DELETE SET NULL,
  blocked_by   UUID        REFERENCES users (id) ON DELETE SET NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_a, user_b)
);

-- ONE row per unordered pair. user_a is always the smaller uuid; the
-- application normalizes via orderedPair() and this CHECK proves it did.
-- Without it, A can block B while B still sees an open DM.
ALTER TABLE relationships ADD CONSTRAINT relationships_ordered_pair
  CHECK (user_a < user_b);

CREATE INDEX relationships_user_b_idx ON relationships (user_b, state);
CREATE INDEX relationships_state_idx  ON relationships (state, updated_at DESC);

COMMENT ON TABLE  relationships IS
  'The rung of the trust ladder two users have reached. A state machine, not '
  'three booleans, so invalid combinations are unrepresentable.';
COMMENT ON COLUMN relationships.user_a IS
  'Always the lexicographically smaller uuid — enforced by relationships_ordered_pair.';
COMMENT ON COLUMN relationships.requested_by IS
  'Direction of a pending DM request, which the pair ordering would otherwise lose.';
COMMENT ON COLUMN relationships.blocked_by IS
  'Who applied the block. Unblocking returns the pair to none, never to the '
  'previous rung — regaining call access must require fresh consent.';

-- ---------------------------------------------------------------------------
-- surprises  — the async icebreaker
-- ---------------------------------------------------------------------------
CREATE TABLE surprises (
  id            UUID PRIMARY KEY,
  code          TEXT        NOT NULL,
  sender_id     UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  recipient_id  UUID        REFERENCES users (id) ON DELETE SET NULL,
  theme         TEXT        NOT NULL
                            CHECK (theme IN ('love','sorry','miss','thinking_of_you','congrats')),
  message       TEXT        NOT NULL,
  tasks         JSONB       NOT NULL DEFAULT '[]'::jsonb,
  mood_selected TEXT        CHECK (mood_selected IN ('angry','sad','meh','happy','soft','tired')),
  opened_at     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX surprises_code_key ON surprises (code);
CREATE INDEX surprises_sender_idx    ON surprises (sender_id, created_at DESC);
CREATE INDEX surprises_recipient_idx ON surprises (recipient_id, opened_at DESC)
  WHERE recipient_id IS NOT NULL;

-- Redemption sets recipient, mood and opened_at together or not at all.
-- Any two-of-three state is a bug, and this refuses to store one.
ALTER TABLE surprises ADD CONSTRAINT surprises_redemption_atomic
  CHECK ((opened_at IS NULL     AND recipient_id IS NULL     AND mood_selected IS NULL)
      OR (opened_at IS NOT NULL AND recipient_id IS NOT NULL AND mood_selected IS NOT NULL));

COMMENT ON TABLE  surprises IS
  'Coded surprise messages. Claimed by CODE, not addressed to an account, so '
  'neither party exposes contact details to hand one over.';
COMMENT ON COLUMN surprises.code IS
  'Normalized claim code (uppercase alphanumeric, no separators). Generated '
  'from a CSPRNG over an unambiguous alphabet; brute force is bounded by the '
  'surpriseRedeem rate limit.';
COMMENT ON COLUMN surprises.recipient_id IS
  'NULL until redeemed. Records who ACTUALLY opened it, which is what the '
  'trust ladder and the abuse team care about.';
COMMENT ON COLUMN surprises.tasks IS
  'JSONB array of {text, done}. Ordered; setTaskDone addresses by index.';
COMMENT ON COLUMN surprises.expires_at IS
  'Unclaimed codes expire so the guessing surface does not grow without bound.';

-- ---------------------------------------------------------------------------
-- direct_messages  — DMs are persistent (room chat is not)
-- ---------------------------------------------------------------------------
CREATE TABLE direct_messages (
  id           UUID PRIMARY KEY,
  sender_id    UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  recipient_id UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  pair_key     TEXT        NOT NULL,
  text         TEXT        NOT NULL,
  sent_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Threads are read newest-first by pair; this index is the whole query plan.
CREATE INDEX direct_messages_thread_idx ON direct_messages (pair_key, sent_at DESC, id DESC);

COMMENT ON TABLE  direct_messages IS
  'Persistent 1:1 messages. Room chat is deliberately NOT stored here — a third '
  'place is not a forum, and logging every word changes what people will say.';
COMMENT ON COLUMN direct_messages.pair_key IS
  'Denormalized "smallerUuid:largerUuid" so a thread is one index lookup rather '
  'than an OR across both directions.';

-- ---------------------------------------------------------------------------
-- reports  — the safety backbone
-- ---------------------------------------------------------------------------
CREATE TABLE reports (
  id          UUID PRIMARY KEY,
  reporter_id UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  target_id   UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  room_id     UUID        REFERENCES rooms (id) ON DELETE SET NULL,
  category    TEXT        NOT NULL
                          CHECK (category IN ('harassment','hate_speech','sexual_content',
                                              'minor_safety','spam','self_harm','other')),
  note        TEXT        NOT NULL DEFAULT '',
  audio_ref   TEXT,
  status      TEXT        NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open','reviewing','upheld','dismissed')),
  reviewed_by UUID        REFERENCES users (id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  resolution  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (reporter_id <> target_id)
);

-- The moderation queue: urgent categories first, then oldest first. The
-- expression mirrors isUrgent() in domain/entities/Report.ts — the adapter
-- integration test asserts the two orderings agree, because a queue that sorts
-- differently in dev than in production is how urgent reports get missed.
CREATE INDEX reports_queue_idx ON reports (
  status,
  (CASE WHEN category IN ('minor_safety', 'self_harm') THEN 0 ELSE 1 END),
  created_at
);

-- Backs the one-open-report-per-target rule.
CREATE INDEX reports_reporter_target_idx ON reports (reporter_id, target_id, status);
CREATE INDEX reports_target_idx ON reports (target_id, created_at DESC);

COMMENT ON TABLE  reports IS
  'User-submitted safety reports. Rows are NEVER deleted — patterns across '
  'dismissed reports are themselves a signal.';
COMMENT ON COLUMN reports.audio_ref IS
  'Optional pointer to a short retained audio clip. Nullable by design: '
  'recording everything always is both a privacy hazard and a storage bill.';
COMMENT ON COLUMN reports.resolution IS
  'Moderator note explaining the decision. What makes a report reconstructable '
  'weeks later.';

-- ---------------------------------------------------------------------------
-- bans
-- ---------------------------------------------------------------------------
CREATE TABLE bans (
  id         UUID PRIMARY KEY,
  user_id    UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  reason     TEXT        NOT NULL,
  expires_at TIMESTAMPTZ,
  issued_by  UUID        REFERENCES users (id) ON DELETE SET NULL,
  issued_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  lifted_at  TIMESTAMPTZ
);

-- Hot path: checked on every socket connect. Partial index keeps it tiny.
CREATE INDEX bans_active_idx ON bans (user_id, expires_at) WHERE lifted_at IS NULL;

COMMENT ON TABLE  bans IS
  'Enforcement actions. Facts, not flags: never deleted, only expired or lifted.';
COMMENT ON COLUMN bans.expires_at IS
  'NULL means permanent. A suspension and a ban are one concept with different '
  'clocks, so every enforcement check is a single query.';
COMMENT ON COLUMN bans.lifted_at IS
  'Set when a moderator reverses a ban early. The row remains for the audit trail.';

-- ---------------------------------------------------------------------------
-- trust_events  — append-only ledger behind users.trust_score
-- ---------------------------------------------------------------------------
CREATE TABLE trust_events (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  delta      INTEGER     NOT NULL,
  reason     TEXT        NOT NULL,
  context    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX trust_events_user_idx ON trust_events (user_id, created_at DESC);

COMMENT ON TABLE  trust_events IS
  'APPEND-ONLY. The source of truth behind users.trust_score. Nothing updates '
  'or deletes a row here; a mistake is corrected by appending a compensating '
  'manual_adjustment. This is how we answer "why is my account limited?" with '
  'a list of dated events instead of a shrug.';
COMMENT ON COLUMN trust_events.context IS
  'Free-text context, e.g. the report id that caused a penalty.';
