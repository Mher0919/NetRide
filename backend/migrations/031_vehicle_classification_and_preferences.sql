-- Migration 031: Vehicle classification + driver ride preferences
-- Idempotent; safe to re-run.

-- 1. Add derived classification columns to driver_vehicles.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'driver_vehicles' AND column_name = 'service_class'
  ) THEN
    ALTER TABLE driver_vehicles ADD COLUMN service_class "vehicle_class" NOT NULL DEFAULT 'CORE';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'driver_vehicles' AND column_name = 'seats'
  ) THEN
    ALTER TABLE driver_vehicles ADD COLUMN seats INTEGER;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'driver_vehicles' AND column_name = 'is_luxury'
  ) THEN
    ALTER TABLE driver_vehicles ADD COLUMN is_luxury BOOLEAN NOT NULL DEFAULT FALSE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'driver_vehicle_submissions' AND column_name = 'seats'
  ) THEN
    ALTER TABLE driver_vehicle_submissions ADD COLUMN seats INTEGER;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'driver_vehicle_submissions' AND column_name = 'is_luxury'
  ) THEN
    ALTER TABLE driver_vehicle_submissions ADD COLUMN is_luxury BOOLEAN NOT NULL DEFAULT FALSE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_driver_vehicles_service_class ON driver_vehicles (service_class);

-- 2. Driver ride preferences (one row per driver + ride type).
CREATE TABLE IF NOT EXISTS driver_ride_preferences (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  driver_id   UUID NOT NULL REFERENCES "users"(id) ON DELETE CASCADE,
  ride_type   "vehicle_class" NOT NULL,
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at  TIMESTAMP(3) DEFAULT now(),
  CONSTRAINT uq_driver_ride_preferences UNIQUE (driver_id, ride_type)
);

CREATE INDEX IF NOT EXISTS idx_driver_ride_preferences_driver ON driver_ride_preferences (driver_id);

-- 3. Backfill preferences: every approved vehicle's driver gets all
--    vehicle-eligible ride types enabled by default (opt-out model).
INSERT INTO driver_ride_preferences (driver_id, ride_type, enabled)
SELECT DISTINCT dv.driver_id,
       unnest(ARRAY['CORE','ELITE','PRESTIGE'])::"vehicle_class" AS ride_type,
       TRUE
FROM driver_vehicles dv
WHERE dv.vehicle_status = 'APPROVED'
  AND dv.driver_id IS NOT NULL
ON CONFLICT (driver_id, ride_type) DO NOTHING;
