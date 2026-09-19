-- backend/migrations/048_otp_code_hashing.sql
--
-- OTP / email-2FA hardening:
--   * code_hash  — SHA-256 hex digest of the 6-digit code. The plaintext
--                  `code` column stays for legacy rows only; NEW codes are
--                  written exclusively as a hash so a DB leak never exposes
--                  live authentication codes.
--   * attempts   — failed-verification counter. After MAX_ATTEMPTS failures
--                  the code row is deleted (brute-force throttling).

ALTER TABLE verification_codes ADD COLUMN IF NOT EXISTS code_hash TEXT;
ALTER TABLE verification_codes ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;