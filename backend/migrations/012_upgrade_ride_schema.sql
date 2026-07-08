-- backend/migrations/012_upgrade_ride_schema.sql

-- Add missing columns to rides table
ALTER TABLE rides ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS distance_meters INTEGER;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS duration_seconds INTEGER;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS fare_amount NUMERIC(10,2);
ALTER TABLE rides ADD COLUMN IF NOT EXISTS trajectory JSONB DEFAULT '[]';
ALTER TABLE rides ADD COLUMN IF NOT EXISTS estimated_distance_meters INTEGER;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS estimated_duration_seconds INTEGER;

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_rides_status ON rides(status);
CREATE INDEX IF NOT EXISTS idx_rides_rider_id ON rides(rider_id);
CREATE INDEX IF NOT EXISTS idx_rides_driver_id ON rides(driver_id);
CREATE INDEX IF NOT EXISTS idx_rides_created_at ON rides(created_at);
