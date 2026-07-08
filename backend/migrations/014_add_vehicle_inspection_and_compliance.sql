-- backend/migrations/014_add_vehicle_inspection_and_compliance.sql

-- 1. Create compliance_status enum
DO $$ BEGIN
    CREATE TYPE compliance_status AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- 2. Add inspection fields to driver_vehicles
ALTER TABLE driver_vehicles ADD COLUMN IF NOT EXISTS inspection_photo_url TEXT;
ALTER TABLE driver_vehicles ADD COLUMN IF NOT EXISTS inspection_expiry_date TIMESTAMPTZ;
ALTER TABLE driver_vehicles ADD COLUMN IF NOT EXISTS inspection_status compliance_status DEFAULT 'PENDING';
ALTER TABLE driver_vehicles ADD COLUMN IF NOT EXISTS inspection_notes TEXT;

-- 3. Add compliance_snapshot to rides for historical auditing
ALTER TABLE rides ADD COLUMN IF NOT EXISTS compliance_snapshot JSONB DEFAULT '{}';

-- 4. Add index for performance on status
CREATE INDEX IF NOT EXISTS idx_driver_vehicles_inspection_status ON driver_vehicles(inspection_status);
