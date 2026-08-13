-- backend/migrations/042_ride_reports_and_cancellation_reasons.sql
--
-- POST-CANCELLATION REPORTING + REQUIRED CANCELLATION REASONS
-- ---------------------------------------------------------------------------
-- 1. rides gains an audit trail for who cancelled and why:
--      cancelled_by            — the user (rider or driver) who ended the ride
--      cancellation_reason_code — stable machine-readable code
--      cancellation_reason_text — optional free-text detail from the canceller
--    Rides cancelled by system cleanup (timeouts) keep these NULL, which is
--    the signal that the ride was not cancelled by a human party.
-- 2. ride_reports: BOTH ride parties may independently file a report against
--    the other party after a terminal (CANCELLED or COMPLETED) ride,
--    regardless of who cancelled. Reports are:
--      - party-only: reporter must be a participant of the ride
--      - no self-reporting (reported user is derived from the ride)
--      - one report per (ride_id, reporter_id) — unique constraint
--      - role-scoped reason codes (rider->driver list vs driver->rider list)
--    Admin reviews with warn / suspend / dismiss actions; a suspended user
--    is deactivated via the existing users.is_active + blocked_reason flags.

-- --- 1. Cancellation audit trail on rides ---------------------------
ALTER TABLE rides
  ADD COLUMN IF NOT EXISTS cancelled_by            UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS cancellation_reason_code TEXT,
  ADD COLUMN IF NOT EXISTS cancellation_reason_text TEXT;

CREATE INDEX IF NOT EXISTS idx_rides_cancelled_by ON rides (cancelled_by);

-- --- 2. Ride reports -------------------------------------------------
CREATE TABLE IF NOT EXISTS ride_reports (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ride_id          UUID        NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  reporter_id      UUID        NOT NULL REFERENCES users(id),
  reported_user_id UUID        NOT NULL REFERENCES users(id),
  -- Role of the REPORTED party (RIDER or DRIVER). The reporter is always
  -- the other party, so their role is implied by the ride row.
  reported_role    TEXT        NOT NULL CHECK (reported_role IN ('RIDER', 'DRIVER')),
  reason_code      TEXT        NOT NULL,
  reason_text      TEXT,
  description      TEXT        NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'OPEN'
                     CHECK (status IN ('OPEN', 'IN_REVIEW', 'RESOLVED', 'DISMISSED')),
  resolution_action TEXT CHECK (resolution_action IN ('NO_ACTION', 'WARNING_ISSUED', 'ACCOUNT_SUSPENDED')),
  admin_notes      TEXT,
  resolved_by      UUID REFERENCES users(id),
  resolved_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One report per reporter per ride: the same party cannot file twice
  -- against the same ride, but BOTH parties each get their own report.
  UNIQUE (ride_id, reporter_id)
);

CREATE INDEX IF NOT EXISTS idx_ride_reports_status_created
  ON ride_reports (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ride_reports_reported_user
  ON ride_reports (reported_user_id);
CREATE INDEX IF NOT EXISTS idx_ride_reports_reporter
  ON ride_reports (reporter_id);
