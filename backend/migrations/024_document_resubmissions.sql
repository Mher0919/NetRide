-- backend/migrations/024_document_resubmissions.sql
-- Document resubmission requirements for driver compliance lifecycle.

-- 1. Create driver_document_requirements table
CREATE TABLE IF NOT EXISTS driver_document_requirements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document_type VARCHAR(50) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'resubmission_required'
    CHECK (status IN ('resubmission_required', 'submitted', 'reviewed')),
  current_document_url TEXT,
  requested_by_admin_id UUID REFERENCES users(id) ON DELETE SET NULL,
  request_reason TEXT,
  requested_at TIMESTAMPTZ DEFAULT NOW(),
  resubmitted_at TIMESTAMPTZ,
  new_document_url TEXT,
  reviewed_at TIMESTAMPTZ,
  reviewed_by_admin_id UUID REFERENCES users(id) ON DELETE SET NULL,
  review_decision TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_ddr_driver_status ON driver_document_requirements(driver_id, status);
CREATE INDEX IF NOT EXISTS idx_ddr_admin_lookup ON driver_document_requirements(driver_id, document_type);

-- 3. RLS (mirrors existing policy pattern)
ALTER TABLE driver_document_requirements ENABLE ROW LEVEL SECURITY;

-- Drivers can view their own requirements
DROP POLICY IF EXISTS ddr_driver_select ON driver_document_requirements;
CREATE POLICY ddr_driver_select ON driver_document_requirements
  FOR SELECT USING (
    driver_id = auth.uid()::text::uuid
  );

-- Admins can view all and insert/update
DROP POLICY IF EXISTS ddr_admin_all ON driver_document_requirements;
CREATE POLICY ddr_admin_all ON driver_document_requirements
  FOR ALL
  USING (
    EXISTS (SELECT 1 FROM users WHERE id = auth.uid()::text::uuid AND role = 'ADMIN')
  );

-- 4. Add action_required_status to drivers for quick lookup
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS has_action_required BOOLEAN DEFAULT FALSE;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS last_action_required_at TIMESTAMPTZ;
