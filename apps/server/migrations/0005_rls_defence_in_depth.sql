-- ============================================================================
-- 0005_rls_defence_in_depth
--
-- Row Level Security, as a BACKSTOP — not as the authorization model.
--
-- WHY THIS DISTINCTION IS THE WHOLE POINT OF THIS MIGRATION
-- ---------------------------------------------------------
-- Supabase makes RLS the natural place to put access rules, because its normal
-- shape is a browser talking to Postgres directly with a user's JWT. This
-- product is not that shape: a Fastify API owns every write, and the rules that
-- decide who may do what are PURE FUNCTIONS in the domain (ADR 0004) — the same
-- ones the socket edge, the REST edge and the tests all run.
--
-- Expressing those rules a second time in SQL would not double the safety. It
-- would create two authorities that must agree forever, and they would not: the
-- trust ladder involves overlapping room sessions, a per-streak freeze, ban
-- projections and rate limits, none of which a policy can see. The first time
-- they disagreed, the bug would be invisible — a policy silently returning zero
-- rows looks exactly like "there is nothing there".
--
-- So the API keeps the rules, and RLS answers a narrower, honest question:
-- IF SOMETHING OTHER THAN THE API EVER CONNECTS WITH A USER'S CREDENTIALS,
-- what should it be able to see?
--
-- That is a real scenario on Supabase — the SQL editor, a leaked anon key, a
-- future client that talks to PostgREST — and the answer for this product is
-- "almost nothing", because there is no feature that needs it.
--
-- WHAT THIS ACTUALLY DOES
-- -----------------------
--   * Enables RLS on every table holding personal data.
--   * Adds NO permissive policies. With RLS on and no policy, the `anon` and
--     `authenticated` roles can read nothing — which is correct, because no
--     browser is meant to reach these tables.
--   * The API connects as the table OWNER, which bypasses RLS by default, so
--     nothing about the running application changes.
--
-- The effect is a closed door rather than a lock with a key. If someone later
-- wants PostgREST access for a specific table, they add a policy deliberately —
-- and the absence of one is a decision rather than an oversight.
--
-- A NOTE ON FORCE
-- ---------------
-- `FORCE ROW LEVEL SECURITY` would apply policies to the owner too, which would
-- break every query the API makes. It is deliberately NOT used: the API is the
-- trusted subject here, and the domain is what constrains it.
-- ============================================================================

ALTER TABLE users               ENABLE ROW LEVEL SECURITY;
ALTER TABLE rooms               ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_members        ENABLE ROW LEVEL SECURITY;
ALTER TABLE relationships       ENABLE ROW LEVEL SECURITY;
ALTER TABLE surprises           ENABLE ROW LEVEL SECURITY;
ALTER TABLE direct_messages     ENABLE ROW LEVEL SECURITY;
ALTER TABLE reports             ENABLE ROW LEVEL SECURITY;
ALTER TABLE bans                ENABLE ROW LEVEL SECURITY;
ALTER TABLE trust_events        ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions  ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE reports IS
  'The safety backbone. RLS is ENABLED WITH NO POLICY: reports name a reporter '
  'and a target, and there is no client-side query that should ever reach them. '
  'Moderation goes through the admin surface, which connects as the owner.';

-- ---------------------------------------------------------------------------
-- pgvector
-- ---------------------------------------------------------------------------
--
-- Enabled now because enabling an extension later, on a database with live
-- traffic, is a lock nobody wants to take by surprise — and because Supabase
-- ships it, so this costs nothing until something uses it.
--
-- NOTHING USES IT YET, and that is deliberate rather than an oversight. The
-- spec puts recommendation algorithms explicitly out of scope, and the obvious
-- first use — embedding what people say in rooms to match them — would mean
-- storing a representation of conversations this product goes out of its way
-- not to keep (ADR 0006: room chat is ephemeral).
--
-- A defensible first use would be matching on the things people choose to
-- publish about themselves. That is a product decision and an ADR, not a
-- migration.
CREATE EXTENSION IF NOT EXISTS vector;
