-- backend/migrations/20260718_face_audit_admin_nullable.sql

-- Face-check events are recorded automatically by the system (not by an
-- admin action), so admin_id must be allowed to be NULL. The previous
-- NOT NULL constraint caused every face verification to fail with a
-- 500 ("null value in column admin_id violates not-null constraint").

ALTER TABLE audit_logs
  ALTER COLUMN admin_id DROP NOT NULL;
