-- backend/migrations/20260816_add_ride_driver_rejections.sql
--
-- Driver-specific ride request rejections (dispatch exclusion rule).
--
-- When a driver declines/cancels a REQUESTED ride offer, that pair
-- (ride, driver) is recorded here so the dispatch pipeline NEVER offers
-- that ride to that driver again — while the ride remains offerable to
-- every other eligible driver. This is a driver-scoped exclusion, NOT a
-- ride-wide cancellation:
--
--   - ride rejected by driver A  →  A excluded, B/C still eligible
--   - rider cancels the ride     →  ride-wide CANCELLED (handled by the
--                                   existing lifecycle, not by this table)
--
-- The primary key (ride_id, driver_id) makes recording idempotent:
-- repeated declines (double-tap, network retry, listener replay) collapse
-- into the single logical "driver D rejected ride R" record.
--
-- Rejection rows are children of the ride: they disappear automatically
-- when the cleanup service prunes the ride, and never affect any other
-- ride (a REQUESTED_again state always gets a fresh ride id).

CREATE TABLE IF NOT EXISTS ride_driver_rejections (
  ride_id     UUID NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  driver_id   UUID NOT NULL,
  status      TEXT NOT NULL DEFAULT 'REJECTED' CHECK (status = 'REJECTED'),
  rejected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (ride_id, driver_id)
);

-- Reverse lookups (count / per-driver exclusions) hit this index.
CREATE INDEX IF NOT EXISTS ride_driver_rejections_driver_id_idx
  ON ride_driver_rejections (driver_id, ride_id);
