-- backend/migrations/008_add_vehicle_models.sql

-- 1. Create Vehicle Models table for the full list of cars from open-vehicle-db
CREATE TABLE IF NOT EXISTS vehicle_models (
  id    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  make  TEXT NOT NULL,
  model TEXT NOT NULL,
  year  INT NOT NULL,
  UNIQUE(make, model, year)
);

-- 2. Update driver_vehicles to store specific car details and colors
ALTER TABLE driver_vehicles ADD COLUMN IF NOT EXISTS make TEXT;
ALTER TABLE driver_vehicles ADD COLUMN IF NOT EXISTS model TEXT;
ALTER TABLE driver_vehicles ADD COLUMN IF NOT EXISTS year INT;
ALTER TABLE driver_vehicles ADD COLUMN IF NOT EXISTS color TEXT;
ALTER TABLE driver_vehicles ADD COLUMN IF NOT EXISTS interior_color TEXT;

-- 3. Add index for searching vehicle models
CREATE INDEX IF NOT EXISTS idx_vehicle_models_search ON vehicle_models (make, model);
