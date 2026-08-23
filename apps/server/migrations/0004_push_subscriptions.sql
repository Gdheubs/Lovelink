-- ============================================================================
-- 0004_push_subscriptions
--
-- Where a device's Web Push registration lives.
--
-- WHY THE ENDPOINT IS THE PRIMARY KEY
-- -----------------------------------
-- The browser hands out no other stable identifier for a device, and the
-- endpoint genuinely IS the address — it is the URL a push is sent to. Using a
-- surrogate id would mean maintaining a unique index on the endpoint anyway,
-- plus a second key that means nothing to anyone.
--
-- It also gets the shared-device case right for free. When one person signs out
-- of a family laptop and another signs in, the browser returns the SAME
-- endpoint under a new account. An upsert on this key MOVES the row, so the
-- previous user's notifications stop arriving on a screen that is no longer
-- theirs. A table keyed on (user_id, endpoint) would keep both, and the first
-- person would keep being notified on a device they have signed out of — which
-- is a privacy failure, not a bug in delivery.
--
-- WHY THE KEYS ARE STORED AT ALL
-- ------------------------------
-- Web Push encrypts each payload to the DEVICE, using the two values the
-- browser generated at subscribe time. Without them the server can address the
-- endpoint but cannot say anything to it. They are per-device public material,
-- not credentials for the account, and they are useless to anyone who cannot
-- also reach the push service.
--
-- Note what is NOT here: no payload, no history, no delivery log. A push is a
-- nudge to open the app, and keeping a record of every nudge would be a record
-- of who contacted whom and when — exactly the data this product goes out of
-- its way not to accumulate.
-- ============================================================================

CREATE TABLE push_subscriptions (
  endpoint    TEXT        PRIMARY KEY,
  user_id     UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  p256dh      TEXT        NOT NULL,
  auth        TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ
);

-- The only query on the send path: every device belonging to one person.
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions (user_id);

COMMENT ON TABLE push_subscriptions IS
  'Web Push registrations, one row per DEVICE. Keyed on the endpoint because '
  'that is the only stable device identifier a browser provides — and because '
  'an upsert then moves a shared device to its new owner rather than notifying '
  'both.';
COMMENT ON COLUMN push_subscriptions.endpoint IS
  'The push service URL for this device. Chosen by the browser, not by us: it '
  'may point at Google, Mozilla or Apple.';
COMMENT ON COLUMN push_subscriptions.p256dh IS
  'Device public key (base64url). Payloads are encrypted to this; without it '
  'the endpoint can be addressed but not spoken to.';
COMMENT ON COLUMN push_subscriptions.auth IS
  'Device auth secret (base64url), part of the same per-device encryption.';
COMMENT ON COLUMN push_subscriptions.last_seen_at IS
  'Last accepted push. A stale value is the only hint we ever get that a device '
  'is drifting out of use; a 404/410 is the only proof, and deletes the row.';
