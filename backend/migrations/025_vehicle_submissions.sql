-- backend/migrations/025_vehicle_submissions.sql
-- Vehicle status lifecycle for pending submissions, document ownership,
-- and replacement workflow.  Each driver can have at most one APPROVED
-- vehicle and zero or more PENDING_REVIEW submissions.

-- 1. Add vehicle-level status (separate from inspection_status which tracks
--    the inspection certificate itself).
ALTER TABLE driver_vehicles ADD COLUMN IF NOT EXISTS vehicle_status VARCHAR(30)
  NOT NULL DEFAULT 'APPROVED';
-- Valid values: APPROVED (active), PENDING_REVIEW (pending admin approval),
-- REJECTED (submission denied), INACTIVE (replaced/superseded),
-- RESUBMISSION_REQUIRED (admin requested changes to submission).

-- 2. Vehicle-specific document columns so insurance + registration are
--    owned by the vehicle record, not just the driver profile.
ALTER TABLE driver_vehicles ADD COLUMN IF NOT EXISTS insurance_photo_url TEXT;
ALTER TABLE driver_vehicles ADD COLUMN IF NOT EXISTS registration_photo_url TEXT;

-- 3. Admin review fields for pending submissions.
ALTER TABLE driver_vehicles ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ;
ALTER TABLE driver_vehicles ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE driver_vehicles ADD COLUMN IF NOT EXISTS reviewed_by_admin_id UUID
  REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE driver_vehicles ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

-- 4. Index for fast pending-vehicle lookups.
CREATE INDEX IF NOT EXISTS idx_dv_vehicle_status ON driver_vehicles(vehicle_status);
CREATE INDEX IF NOT EXISTS idx_dv_driver_status   ON driver_vehicles(driver_id, vehicle_status);

-- 5. Add a driver_vehicle_submissions table for tracking the full history
--    of replace-vehicle requests. Each row is one submission attempt.
CREATE TABLE IF NOT EXISTS driver_vehicle_submissions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status            VARCHAR(30) NOT NULL DEFAULT 'PENDING_REVIEW'
    CHECK (status IN ('PENDING_REVIEW', 'APPROVED', 'REJECTED', 'RESUBMISSION_REQUIRED')),
  -- Snapshot of the requested vehicle fields at submission time.
  make              TEXT,
  model             TEXT,
  year              INT,
  color             TEXT,
  interior_color    TEXT,
  license_plate_number TEXT NOT NULL,
  license_plate_state  TEXT,
  zip_code          TEXT,
  -- Document URLs submitted with this vehicle.
  registration_photo_url TEXT,
  insurance_photo_url   TEXT,
  inspection_photo_url  TEXT,
  -- Admin review fields.
  rejection_reason  TEXT,
  reviewed_at       TIMESTAMPTZ,
  reviewed_by_admin_id UUID REFERENCES users(id) ON DELETE SET NULL,
  -- Timestamps.
  submitted_at      TIMESTAMPTZ DEFAULT NOW(),
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dvs_driver_status ON driver_vehicle_submissions(driver_id, status);
CREATE INDEX IF NOT EXISTS idx_dvs_status         ON driver_vehicle_submissions(status);

-- RLS policies
ALTER TABLE driver_vehicle_submissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS dvs_driver_select ON driver_vehicle_submissions;
CREATE POLICY dvs_driver_select ON driver_vehicle_submissions
  FOR SELECT USING (driver_id = auth.uid()::text::uuid);

DROP POLICY IF EXISTS dvs_driver_insert ON driver_vehicle_submissions;
CREATE POLICY dvs_driver_insert ON driver_vehicle_submissions
  FOR INSERT WITH CHECK (driver_id = auth.uid()::text::uuid);

DROP POLICY IF EXISTS dvs_admin_all ON driver_vehicle_submissions;
CREATE POLICY dvs_admin_all ON driver_vehicle_submissions
  FOR ALL
  USING (EXISTS (SELECT 1 FROM users WHERE id = auth.uid()::text::uuid AND role = 'ADMIN'));
