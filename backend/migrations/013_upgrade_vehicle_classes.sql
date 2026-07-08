-- backend/migrations/013_upgrade_vehicle_classes.sql

-- 1. Create the new vehicle_class enum
DO $$ BEGIN
    CREATE TYPE vehicle_class AS ENUM ('CORE', 'ELITE', 'PRESTIGE');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- 2. Add requested_class to rides table
ALTER TABLE rides ADD COLUMN IF NOT EXISTS requested_class vehicle_class DEFAULT 'CORE';

-- 3. Add active_class to drivers table
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS active_class vehicle_class DEFAULT 'CORE';

-- 4. Update vehicle_category enum (Prisma handles this, but let's do SQL for safety)
-- Actually, let's keep vehicle_category as it is and add class mapping if needed, 
-- or just migration existing values.
-- Let's stick to the plan of upgrading the enum values if possible, 
-- but Postgres doesn't easily allow renaming enum values used in tables.
-- Better to add a new column and migrate.

ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS service_class vehicle_class DEFAULT 'CORE';

-- Migrate existing data
UPDATE vehicles SET service_class = 'CORE' WHERE category = 'ECONOMY';
UPDATE vehicles SET service_class = 'ELITE' WHERE category = 'PREMIUM';
UPDATE vehicles SET service_class = 'PRESTIGE' WHERE category IN ('SUV', 'VAN');

-- 5. Add cancellation_rate and acceptance_rate to drivers for dispatch weighting
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS cancellation_count INT DEFAULT 0;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS acceptance_count INT DEFAULT 0;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS last_cancellation_at TIMESTAMPTZ;

-- 6. Add rider_rating field to rides to snapshot it at request time
ALTER TABLE rides ADD COLUMN IF NOT EXISTS snapshot_rider_rating NUMERIC(3,2);
