-- 060_otp_purpose.sql
--
-- Binds every one-time code to the flow that generated it. Before this
-- migration the verification_codes table was keyed only by email, so a code
-- issued for one flow (e.g. a portal password reset) could be replayed
-- against another flow (e.g. portal login 2FA or the consumer login flow).
--
-- Existing rows are treated as LOGIN codes (the only consumer of the table
-- at the time), which keeps any in-flight signup/login code working.

ALTER TABLE verification_codes
  ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'LOGIN';

CREATE INDEX IF NOT EXISTS idx_verification_codes_email_purpose
  ON verification_codes(email, purpose);
