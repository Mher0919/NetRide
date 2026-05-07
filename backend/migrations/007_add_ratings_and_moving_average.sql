-- backend/migrations/007_add_ratings_and_moving_average.sql

-- Add rating fields to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS rating DOUBLE PRECISION DEFAULT 5.0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS rating_count INTEGER DEFAULT 0;

-- Update ratings table schema
-- 1. Add new columns
ALTER TABLE ratings ADD COLUMN IF NOT EXISTS rater_id UUID REFERENCES users(id);
ALTER TABLE ratings ADD COLUMN IF NOT EXISTS target_id UUID REFERENCES users(id);
ALTER TABLE ratings ADD COLUMN IF NOT EXISTS target_role VARCHAR(20);

-- 2. Migrate existing data (if any)
UPDATE ratings SET rater_id = rider_id, target_id = driver_id, target_role = 'DRIVER' WHERE rater_id IS NULL;

-- 3. Remove old unique constraint and columns if needed, but let's keep it safe for now
-- or just remove the unique constraint on ride_id to allow dual ratings
ALTER TABLE ratings DROP CONSTRAINT IF EXISTS ratings_ride_id_key;

-- 4. Clean up old columns (optional, but better to match schema)
-- ALTER TABLE ratings DROP COLUMN rider_id;
-- ALTER TABLE ratings DROP COLUMN driver_id;
