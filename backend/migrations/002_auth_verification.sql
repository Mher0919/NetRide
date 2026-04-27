-- backend/migrations/002_auth_verification.sql

-- Add verification_codes table
CREATE TABLE IF NOT EXISTS verification_codes (
    id          SERIAL PRIMARY KEY,
    email       TEXT NOT NULL,
    code        VARCHAR(6) NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Create index for faster lookup and cleanup
CREATE INDEX IF NOT EXISTS idx_verification_codes_email ON verification_codes(email);

-- Add full_name and other optional fields if they don't exist in the context of manual registration
-- The users table already has email and full_name, so we are good there.
