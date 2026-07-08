-- backend/migrations/009_admin_and_audit_logs.sql

-- 1. Add 'ADMIN' to user_role enum
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'ADMIN';

-- 2. Create verification_status enum
DO $$ BEGIN
    CREATE TYPE verification_status AS ENUM ('PENDING', 'VERIFIED', 'REJECTED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- 3. Add verification_status to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_status verification_status DEFAULT 'PENDING';

-- 4. Create audit_logs table
CREATE TABLE IF NOT EXISTS audit_logs (
    id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    admin_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    action     TEXT NOT NULL, -- e.g., 'VERIFY', 'REJECT', 'SET_PENDING'
    details    TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Update is_verified based on verification_status for existing users (optional but good for consistency)
UPDATE users SET verification_status = 'VERIFIED' WHERE is_verified = TRUE;
