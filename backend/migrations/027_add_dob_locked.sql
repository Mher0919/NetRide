-- 027_add_dob_locked.sql
-- Once an admin approves a date-of-birth change (via profile change or
-- identity verification), the field becomes immutable for the user.

ALTER TABLE users ADD COLUMN IF NOT EXISTS dob_locked BOOLEAN NOT NULL DEFAULT FALSE;

-- Add index for quick lookups when checking dob_locked in submitProfileChange
CREATE INDEX IF NOT EXISTS idx_users_dob_locked ON users(id, dob_locked);
