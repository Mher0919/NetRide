-- 019_navigation_safety.sql
--
-- Persists the cached per-leg route metadata the driver app's
-- RouteProgressCalculator uses locally, and adds the speeding-violations
-- ledger that powers the dangerous-driver flag in fare.service +
-- dispatch.service + the admin SpeedingViolations page.
--
-- Safe / idempotent. Run alongside the existing 001..018 migrations; the
-- bootstrap code in src/app.ts reads information_schema before applying.

ALTER TABLE rides
  ADD COLUMN IF NOT EXISTS route_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

-- route_metadata shape (per leg, written by NavigationService):
-- {
--   pickup:    { distance, duration, eta, polyline, steps, speed_limits_by_road, is_dangerous_road_set },
--   destination: { ... same shape ... }
-- }
--
-- steps[] is the OSRM step list with the enriched lane / speed-limit
-- metadata produced by GeospatialService.getRoute.

CREATE TABLE IF NOT EXISTS speeding_violations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  driver_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trip_id   UUID NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at   TIMESTAMPTZ NOT NULL,
  duration_seconds INT NOT NULL,
  max_over_mph INT NOT NULL,
  avg_speed_mph INT NOT NULL,
  road_name TEXT,
  is_freeway BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS speeding_violations_driver_recent_idx
  ON speeding_violations (driver_id, created_at DESC);

CREATE INDEX IF NOT EXISTS speeding_violations_trip_idx
  ON speeding_violations (trip_id);