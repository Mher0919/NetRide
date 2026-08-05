-- backend/migrations/036_pricing_profiles.sql
--
-- PRICING PROFILES
-- ---------------------------------------------------------------------------
-- Introduces configurable pricing profiles so NetRide can own the fare for
-- every ride category it exposes (currently only PREMIUM). Each profile is
-- a named row of rate parameters; the pricing engine is profile-agnostic.
--
-- Future ride categories (STANDARD, BLACK, XL, LUXURY) are added by
-- inserting a new row here (plus a UI label) — no engine refactor needed.
--
-- The legacy `pricing_configurations` singleton is retained untouched for
-- backward compatibility with historical snapshots.

CREATE TABLE IF NOT EXISTS pricing_profiles (
  code                   TEXT PRIMARY KEY,
  label                  TEXT        NOT NULL,
  base_fare              DECIMAL(10, 2) NOT NULL DEFAULT 3.50,
  per_km_rate            DECIMAL(10, 2) NOT NULL DEFAULT 1.50,
  per_minute_rate        DECIMAL(10, 2) NOT NULL DEFAULT 0.35,
  minimum_fare           DECIMAL(10, 2) NOT NULL DEFAULT 7.00,
  booking_fee            DECIMAL(10, 2) NOT NULL DEFAULT 1.50,
  service_fee_rate       DECIMAL(5, 4)  NOT NULL DEFAULT 0.10,
  tax_rate               DECIMAL(5, 4)  NOT NULL DEFAULT 0.0875,
  max_demand_multiplier  DECIMAL(4, 2)  NOT NULL DEFAULT 2.00,
  peak_time_multiplier   DECIMAL(4, 2)  NOT NULL DEFAULT 1.25,
  off_peak_multiplier    DECIMAL(4, 2)  NOT NULL DEFAULT 0.95,
  weather_multiplier     DECIMAL(4, 2)  NOT NULL DEFAULT 1.00,
  location_multiplier    DECIMAL(4, 2)  NOT NULL DEFAULT 1.00,
  fleet_multiplier       DECIMAL(4, 2)  NOT NULL DEFAULT 1.00,
  active                 BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed the PREMIUM profile from the current platform configuration so the
-- live rates carry over unchanged.
INSERT INTO pricing_profiles (
  code, label, base_fare, per_km_rate, per_minute_rate, minimum_fare,
  booking_fee, service_fee_rate, tax_rate, max_demand_multiplier,
  peak_time_multiplier, off_peak_multiplier
)
SELECT
  'PREMIUM', 'NetRide Premium', base_fare, per_km_rate, per_minute_rate,
  minimum_fare, booking_fee, service_fee_rate, tax_rate,
  max_demand_multiplier, peak_time_multiplier, off_peak_multiplier
FROM pricing_configurations
WHERE id = 1
ON CONFLICT (code) DO NOTHING;

-- Keep the PREMIUM profile populated even if the singleton row is ever
-- removed or reset.
INSERT INTO pricing_profiles (
  code, label, base_fare, per_km_rate, per_minute_rate, minimum_fare,
  booking_fee, service_fee_rate, tax_rate, max_demand_multiplier,
  peak_time_multiplier, off_peak_multiplier
)
VALUES (
  'PREMIUM', 'NetRide Premium', 3.50, 1.50, 0.35, 7.00, 1.50, 0.10,
  0.0875, 2.00, 1.25, 0.95
)
ON CONFLICT (code) DO NOTHING;
