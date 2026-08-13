-- backend/migrations/040_notifications_heatmap.sql
--
-- REAL PHONE NOTIFICATIONS + INTELLIGENT DEMAND HEATMAP — data foundations.
-- ---------------------------------------------------------------------------
-- Two features share this migration:
--
-- 1. Notifications (rider + driver):
--    - device_tokens: multi-device FCM registry (a user can legitimately run
--      the app on several phones). Supersedes the single users.fcm_token /
--      drivers.fcm_token legacy columns, which are kept for compatibility.
--    - notifications: persisted, user-scoped history of every real event
--      notification (ride accepted / driver arrived / trip started / ride
--      completed / ride cancelled / credits earned / referral rewards).
--      event_id is the idempotency key — a UNIQUE partial index guarantees
--      that exactly ONE notification is ever recorded/sent per event, even
--      when several backend instances process the same event concurrently.
--
-- 2. Demand heatmap (driver app):
--    - rider_activity: anonymized "what riders are actually doing" signal.
--      Every row is a real activity event (app open on map, request flow
--      opened, active trip location, ride requested) bucketed into an H3
--      cell at write time. Raw location data is NEVER exposed to drivers —
--      only aggregated, time-decayed, radius-capped zone blobs.
--
-- Idempotency strategy (same pattern as all prior migrations): guarded
-- CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS, so re-running
-- the file is always safe.

-- ===========================================================================
-- 1. DEVICE TOKENS — multi-device FCM registry
-- ===========================================================================

CREATE TABLE IF NOT EXISTS device_tokens (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT        NOT NULL CHECK (role IN ('rider', 'driver')),
  token       TEXT        NOT NULL UNIQUE,
  platform    TEXT,
  app_version TEXT,
  created_at  TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

-- Push fan-out looks up tokens by (user, role) — keep it fast.
CREATE INDEX IF NOT EXISTS device_tokens_user_role_idx
  ON device_tokens (user_id, role);

-- ===========================================================================
-- 2. NOTIFICATIONS — persisted, deduplicated history
-- ===========================================================================

CREATE TABLE IF NOT EXISTS notifications (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT        NOT NULL CHECK (role IN ('rider', 'driver')),
  type        TEXT        NOT NULL,
  title       TEXT        NOT NULL,
  body        TEXT        NOT NULL,
  data        JSONB,
  event_id    TEXT,
  read_at     TIMESTAMPTZ(6),
  created_at  TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

-- One notification per real-world event, ever. NULL event_ids (anonymous /
-- routine rows) are exempt from the uniqueness rule.
CREATE UNIQUE INDEX IF NOT EXISTS notifications_event_id_key
  ON notifications (event_id)
  WHERE event_id IS NOT NULL;

-- In-app history feed + unread badges.
CREATE INDEX IF NOT EXISTS notifications_user_created_idx
  ON notifications (user_id, created_at DESC);

-- ===========================================================================
-- 3. RIDER ACTIVITY — privacy-preserving demand signal source
-- ===========================================================================
-- cell_h3 is the H3 resolution-7 hexagon of (lat, lng) computed server-side.
-- driver_activity is intentionally rider-only: driver app never writes here,
-- drivers only ever READ aggregated blends via the heatmap endpoint.

CREATE TABLE IF NOT EXISTS rider_activity (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  rider_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trip_id       UUID        REFERENCES rides(id) ON DELETE SET NULL,
  activity_type TEXT        NOT NULL
    CHECK (activity_type IN ('APP_OPEN', 'REQUEST_FLOW', 'APP_ACTIVE', 'RIDE_REQUESTED')),
  lat           DOUBLE PRECISION NOT NULL,
  lng           DOUBLE PRECISION NOT NULL,
  cell_h3       TEXT        NOT NULL,
  created_at    TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

-- Heatmap queries filter by time window, then group by cell.
CREATE INDEX IF NOT EXISTS rider_activity_created_idx
  ON rider_activity (created_at);
CREATE INDEX IF NOT EXISTS rider_activity_cell_idx
  ON rider_activity (cell_h3, created_at);