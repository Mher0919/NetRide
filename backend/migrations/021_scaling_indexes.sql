-- Step 8: Performance indexes for 100k concurrent user scaling
-- All use IF NOT EXISTS so they are safe to re-run.

-- 1. Driver active status + class filter (findNearbyDrivers, matching)
CREATE INDEX IF NOT EXISTS idx_drivers_active_class
  ON drivers (is_active, active_class);

-- 2. Ride status + creation time (cleanup, matching queries)
CREATE INDEX IF NOT EXISTS idx_rides_status_created_at
  ON rides (status, created_at DESC);

-- 3. Rides by rider history (rider dashboard)
CREATE INDEX IF NOT EXISTS idx_rides_rider_created_at
  ON rides (rider_id, created_at DESC);

-- 4. Rides by driver history (driver dashboard, earnings)
CREATE INDEX IF NOT EXISTS idx_rides_driver_created_at
  ON rides (driver_id, created_at DESC);

-- 5. Profile change request status (admin review queue)
CREATE INDEX IF NOT EXISTS idx_profile_change_requests_status_created_at
  ON profile_change_requests (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_profile_change_requests_driver_created_at
  ON profile_change_requests (driver_id, created_at DESC);

-- 6. Payout card status (admin approval queue)
CREATE INDEX IF NOT EXISTS idx_payout_cards_driver_status
  ON payout_cards (driver_id, status);

CREATE INDEX IF NOT EXISTS idx_payout_cards_status_created_at
  ON payout_cards (status, created_at DESC);

-- 7. Payout history (driver payouts, admin audit)
CREATE INDEX IF NOT EXISTS idx_payouts_driver_status_requested_at
  ON payouts (driver_id, status, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_payouts_status_requested_at
  ON payouts (status, requested_at DESC);
