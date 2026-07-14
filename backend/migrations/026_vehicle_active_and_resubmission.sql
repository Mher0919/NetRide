-- backend/migrations/026_vehicle_active_and_resubmission.sql
-- Active vehicle resolution, vehicle color enforcement, resubmission workflow,
-- and data consistency improvements.

-- 1. Add approved_at for tracking when vehicles were approved
ALTER TABLE driver_vehicles ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;

-- 2. Add index for fast active-vehicle lookups
CREATE INDEX IF NOT EXISTS idx_dv_active_vehicle
  ON driver_vehicles(driver_id, vehicle_status)
  WHERE vehicle_status = 'APPROVED';

-- 3. Add driver_vehicle_resubmission_requests table for full vehicle resubmission
CREATE TABLE IF NOT EXISTS driver_vehicle_resubmission_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  submission_id UUID REFERENCES driver_vehicle_submissions(id) ON DELETE SET NULL,
  requested_by_admin_id UUID REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'resubmission_required'
    CHECK (status IN ('resubmission_required', 'in_progress', 'submitted', 'reviewed')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dvrr_driver_status
  ON driver_vehicle_resubmission_requests(driver_id, status);

-- 4. Add has_vehicle_action_required to drivers for resubmission state
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS has_vehicle_action_required BOOLEAN DEFAULT FALSE;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS last_vehicle_action_required_at TIMESTAMPTZ;
