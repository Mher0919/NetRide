-- 022_onboarding_phone_fields.sql
--
-- Adds step-by-step onboarding tracking, phone verification flag,
-- license plate state, and ZIP code fields.

-- 1. Track onboarding progress per user (nullable = not started)
ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_step INTEGER;

-- 2. Separate phone verification flag (distinct from is_verified which is overloaded)
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN NOT NULL DEFAULT FALSE;

-- 3. License plate state + ZIP code on driver_vehicles
ALTER TABLE driver_vehicles ADD COLUMN IF NOT EXISTS license_plate_state TEXT;
ALTER TABLE driver_vehicles ADD COLUMN IF NOT EXISTS zip_code TEXT;

-- 4. Add headshot_uploaded flag so we know the first step is complete
ALTER TABLE users ADD COLUMN IF NOT EXISTS headshot_uploaded BOOLEAN NOT NULL DEFAULT FALSE;
