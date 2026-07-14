-- 023_driver_phone_separate.sql
--
-- Adds driver-specific phone number/verification fields so rider and
-- driver phone numbers can differ for the same person (dual-role).
-- When a driver's phone matches their rider's already-verified number,
-- the server auto-verifies it without sending a Twilio code.

ALTER TABLE drivers ADD COLUMN IF NOT EXISTS phone_number TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN NOT NULL DEFAULT FALSE;
CREATE UNIQUE INDEX IF NOT EXISTS idx_drivers_phone_number ON drivers(phone_number) WHERE phone_number IS NOT NULL;
