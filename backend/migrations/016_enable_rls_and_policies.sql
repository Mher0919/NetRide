-- backend/migrations/016_enable_rls_and_policies.sql

-- Enable RLS on all public tables
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE drivers ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE driver_vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE rides ENABLE ROW LEVEL SECURITY;
ALTER TABLE ratings ENABLE ROW LEVEL SECURITY;
ALTER TABLE favorite_drivers ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE verification_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicle_models ENABLE ROW LEVEL SECURITY;

-- Default Policies (since the backend uses a superuser connection, these primarily restrict direct API/anon access)

-- 1. Users table: authenticated users can read/update their own data
DROP POLICY IF EXISTS "Users can view own data" ON users;
CREATE POLICY "Users can view own data" ON users
FOR SELECT USING (auth.uid() = id);

DROP POLICY IF EXISTS "Users can update own data" ON users;
CREATE POLICY "Users can update own data" ON users
FOR UPDATE USING (auth.uid() = id);

-- 2. Drivers table: drivers can view/update their own profile
DROP POLICY IF EXISTS "Drivers can view own profile" ON drivers;
CREATE POLICY "Drivers can view own profile" ON drivers
FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Drivers can update own profile" ON drivers;
CREATE POLICY "Drivers can update own profile" ON drivers
FOR UPDATE USING (auth.uid() = user_id);

-- 3. Rides table: riders and assigned drivers can view the trip
DROP POLICY IF EXISTS "Participants can view ride" ON rides;
CREATE POLICY "Participants can view ride" ON rides
FOR SELECT USING (auth.uid() = rider_id OR auth.uid() = driver_id);

-- 4. Vehicles and Models: publicly readable for discovery
DROP POLICY IF EXISTS "Public can view vehicles" ON vehicles;
CREATE POLICY "Public can view vehicles" ON vehicles
FOR SELECT USING (true);

DROP POLICY IF EXISTS "Public can view vehicle models" ON vehicle_models;
CREATE POLICY "Public can view vehicle models" ON vehicle_models
FOR SELECT USING (true);

-- 5. Ratings: participants can view
DROP POLICY IF EXISTS "Participants can view ratings" ON ratings;
CREATE POLICY "Participants can view ratings" ON ratings
FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM rides 
    WHERE rides.id = ratings.ride_id 
    AND (rides.rider_id = auth.uid() OR rides.driver_id = auth.uid())
  )
);

-- 6. Favorite Drivers: riders can manage their own
DROP POLICY IF EXISTS "Riders can manage favorites" ON favorite_drivers;
CREATE POLICY "Riders can manage favorites" ON favorite_drivers
FOR ALL USING (auth.uid() = rider_id);

-- 7. Audit Logs and Verification Codes: RESTRICTED
-- These remain "Deny All" for direct API access by default once RLS is enabled, 
-- as no specific policies are being added for them. 
-- The backend (superuser) will still have access.

-- Note: The Node.js backend connects using a role that bypasses RLS (usually 'postgres' in Supabase).
-- These policies provide a safety net for any potential direct Supabase client usage.
