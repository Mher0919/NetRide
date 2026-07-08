-- backend/migrations/018_add_face_verification.sql

-- Per-user face verification state.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS face_enrollment_url TEXT,
  ADD COLUMN IF NOT EXISTS last_face_check_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_face_check_score DECIMAL(4, 3),
  ADD COLUMN IF NOT EXISTS last_face_check_device_id TEXT,
  ADD COLUMN IF NOT EXISTS last_device_id TEXT,
  ADD COLUMN IF NOT EXISTS last_offline_lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS last_offline_lng DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS last_offline_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS face_check_status TEXT NOT NULL DEFAULT 'CLEAR';

-- Top-level status enum constraint.
ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_face_check_status_check;
ALTER TABLE users
  ADD CONSTRAINT users_face_check_status_check
  CHECK (face_check_status IN ('CLEAR', 'FLAGGED', 'PENDING_REVIEW'));

-- Per-event audit trail. The admin dashboard reads this when a driver is
-- flagged so an operator can manually clear or confirm.
CREATE TABLE IF NOT EXISTS face_check_events (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  captured_clip_url   TEXT,
  reference_image_url TEXT,
  status              TEXT NOT NULL CHECK (status IN ('PASS', 'FAIL', 'FLAGGED')),
  match_score         DECIMAL(4, 3),
  liveness_face_frames INT,
  liveness_motion_px  DECIMAL(6, 2),
  liveness_blink_count INT,
  liveness_laplacian_var DECIMAL(6, 2),
  device_id           TEXT,
  lat                 DOUBLE PRECISION,
  lng                 DOUBLE PRECISION,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_by_admin_id UUID REFERENCES users(id),
  reviewed_at         TIMESTAMPTZ,
  review_notes        TEXT,
  review_decision     TEXT CHECK (review_decision IN ('APPROVED', 'REJECTED'))
);

CREATE INDEX IF NOT EXISTS idx_face_check_events_user_id ON face_check_events(user_id);
CREATE INDEX IF NOT EXISTS idx_face_check_events_status ON face_check_events(status);
CREATE INDEX IF NOT EXISTS idx_face_check_events_pending
  ON face_check_events(created_at DESC)
  WHERE status = 'FLAGGED' AND reviewed_at IS NULL;

ALTER TABLE face_check_events ENABLE ROW LEVEL SECURITY;