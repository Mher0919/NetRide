-- backend/migrations/035_platform_pricing.sql
--
-- Central platform pricing: replaces driver-controlled pricing with a
-- single, config-driven pricing engine.
--
-- 1. pricing_configurations — singleton row (id = 1) holding every rate.
--    Admin-editable; the pricing engine caches it in memory (60s TTL).
-- 2. ride_price_snapshots — the fare quoted at request time, stored per
--    ride so booking, payout, and payment all agree.
--
-- Additive only: driver pricing columns (price_per_mile, price_range_min,
-- price_range_max, recommended_price, price_last_changed) and ride-type
-- preference tables are retained for historical data.

-- ---------------------------------------------------------------------------
-- 1. PRICING CONFIGURATION (singleton)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pricing_configurations (
  id                   INT PRIMARY KEY CHECK (id = 1),
  base_fare            NUMERIC(8, 2)  NOT NULL DEFAULT 3.50,
  per_km_rate          NUMERIC(8, 2)  NOT NULL DEFAULT 1.50,
  per_minute_rate      NUMERIC(8, 2)  NOT NULL DEFAULT 0.35,
  minimum_fare         NUMERIC(8, 2)  NOT NULL DEFAULT 7.00,
  booking_fee          NUMERIC(8, 2)  NOT NULL DEFAULT 1.50,
  service_fee_rate     NUMERIC(5, 4)  NOT NULL DEFAULT 0.1000,
  tax_rate             NUMERIC(5, 4)  NOT NULL DEFAULT 0.0875,
  max_demand_multiplier NUMERIC(4, 2) NOT NULL DEFAULT 2.00,
  peak_time_multiplier NUMERIC(4, 2)  NOT NULL DEFAULT 1.25,
  off_peak_multiplier  NUMERIC(4, 2)  NOT NULL DEFAULT 0.95,
  updated_at           TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

INSERT INTO pricing_configurations (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. RIDE PRICE SNAPSHOTS (quoted fare == charged fare)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ride_price_snapshots (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id              UUID NOT NULL UNIQUE REFERENCES rides(id) ON DELETE CASCADE,
  distance_km          NUMERIC(10, 3) NOT NULL,
  duration_minutes     NUMERIC(10, 2) NOT NULL,
  multiplier_breakdown JSONB NOT NULL DEFAULT '{}'::jsonb,
  config               JSONB NOT NULL DEFAULT '{}'::jsonb,
  final_fare           NUMERIC(10, 2) NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ride_price_snapshots_ride_id
  ON ride_price_snapshots (ride_id);
