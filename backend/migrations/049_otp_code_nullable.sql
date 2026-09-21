-- backend/migrations/049_otp_code_nullable.sql
--
-- Follow-up to 048 (OTP code hashing): since 048 every NEW verification
-- code is persisted ONLY as code_hash — the plaintext `code` column is
-- kept purely for legacy rows. It is still declared NOT NULL though, so
-- every generateOTP() INSERT (login 2FA, signup, forgot-password, admin
-- 2FA) fails with:
--
--   null value in column "code" of relation "verification_codes"
--   violates not-null constraint
--
-- Drop the NOT NULL: hashed-only rows are now valid, legacy rows keep
-- their plaintext.

ALTER TABLE verification_codes ALTER COLUMN code DROP NOT NULL;