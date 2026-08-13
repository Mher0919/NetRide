-- backend/migrations/041_revenue_split.sql
--
-- PRODUCTION PRICING + DYNAMIC FLEET REVENUE SPLIT
-- ---------------------------------------------------------------------------
-- 1. Fare profile: flat formula per production spec — base $4.00 + $2.50/mile
--    + $0.40/min, $10.00 minimum. Booking/service/tax are zeroed and all
--    multipliers pinned to 1.00 (the engine pipeline stays intact; with these
--    values it is deterministic-flat). Column renamed per_km_rate ->
--    per_mile_rate to match the spec's mileage-based rate.
-- 2. Revenue split: global 60% driver / 40% platform singleton
--    (revenue_configs). The 40% platform pool is distributed to the
--    ride's fleet partner at the fleet's configured share; the remainder
--    belongs to NetRide. Unassigned drivers => NetRide keeps the whole pool.
-- 3. drivers.fleet_id: nullable assignment of a driver to a fleet partner.
-- 4. ride_price_snapshots gains the per-ride revenue allocation so every
--    completed ride is deterministically reconcilable
--    (finalFare = driverShare + fleetShare + netrideShare, cent-exact).

-- --- 1. Fare profile ------------------------------------------------
ALTER TABLE pricing_profiles RENAME COLUMN per_km_rate TO per_mile_rate;

UPDATE pricing_profiles
SET base_fare              = 4.00,
    per_mile_rate          = 2.50,
    per_minute_rate        = 0.40,
    minimum_fare           = 10.00,
    booking_fee            = 0.00,
    service_fee_rate       = 0.0000,
    tax_rate               = 0.0000,
    max_demand_multiplier  = 1.00,
    peak_time_multiplier   = 1.00,
    off_peak_multiplier    = 1.00,
    weather_multiplier     = 1.00,
    location_multiplier    = 1.00,
    fleet_multiplier       = 1.00,
    updated_at             = NOW()
WHERE code = 'PREMIUM';

-- --- 2. Fleet partners + revenue config -----------------------------
CREATE TABLE IF NOT EXISTS fleet_partners (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name                    TEXT        NOT NULL,
  contact_name            TEXT,
  contact_email           TEXT,
  -- Share of the 40% platform pool this fleet earns on its drivers' rides.
  platform_share_percent  DECIMAL(5, 2) NOT NULL DEFAULT 0.00
                            CHECK (platform_share_percent >= 0 AND platform_share_percent <= 100),
  is_active               BOOLEAN     NOT NULL DEFAULT TRUE,
  notes                   TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS revenue_configs (
  id                      INTEGER PRIMARY KEY CHECK (id = 1),
  driver_share_percent    DECIMAL(5, 2) NOT NULL DEFAULT 60.00
                            CHECK (driver_share_percent >= 0 AND driver_share_percent <= 100),
  platform_share_percent  DECIMAL(5, 2) NOT NULL DEFAULT 40.00
                            CHECK (platform_share_percent >= 0 AND platform_share_percent <= 100),
  updated_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  -- Global split must always total 100.
  CHECK (driver_share_percent + platform_share_percent = 100)
);

INSERT INTO revenue_configs (id, driver_share_percent, platform_share_percent)
VALUES (1, 60.00, 40.00)
ON CONFLICT (id) DO NOTHING;

-- --- 3. Driver-to-fleet assignment -----------------------------------
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS fleet_id UUID REFERENCES fleet_partners(id);
CREATE INDEX IF NOT EXISTS idx_drivers_fleet_id ON drivers (fleet_id);

-- --- 4. Per-ride revenue allocation on the price snapshot -----------
ALTER TABLE ride_price_snapshots
  ADD COLUMN IF NOT EXISTS driver_share_cents       BIGINT,
  ADD COLUMN IF NOT EXISTS platform_share_cents     BIGINT,
  ADD COLUMN IF NOT EXISTS netride_share_cents      BIGINT,
  ADD COLUMN IF NOT EXISTS fleet_allocations        JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS driver_fleet_id          UUID REFERENCES fleet_partners(id),
  ADD COLUMN IF NOT EXISTS revenue_config_snapshot  JSONB NOT NULL DEFAULT '{}';
