-- backend/migrations/038_referral_onboarding_device.sql
--
-- REFERRAL ONBOARDING + DEVICE FRAUD SIGNALS
-- ---------------------------------------------------------------------------
-- Phase 1-12 of the referral iteration: first-time referral onboarding
-- (scan / manual code / skip — permanently closes), plus a privacy-conscious
-- device registry used ONLY as a risk signal for reward eligibility. A
-- device is never the sole authority; account, ride, payment and abuse
-- signals combine into a NORMAL / REVIEW / BLOCKED risk state on the user.
--
-- Changes:
--   users.referral_onboarding_state  NULL | 'SKIPPED' | 'USED'
--        NULL   → onboarding pending (rider can scan a code)
--        SKIPPED→ rider permanently declined (one referral per rider, forever)
--        USED   → rider already linked (superset of referral_relationships)
--   users.device_risk_state          'NORMAL' | 'REVIEW' | 'BLOCKED'
--        Reward-time gate: BLOCKED rejects referral reward eligibility.
--        REVIEW grants but is flagged in audit + admin dashboards.
--   users.fcm_token                  (latent gap: existed in Prisma but was
--        never created by a migration — adding it here retroactively)
--   user_devices                     per (user, install) registry with the
--        opaque install/device id the rider app generates at first launch.
--
-- Idempotency strategy (same pattern as all prior migrations): ADD COLUMN
-- IF NOT EXISTS / CREATE TABLE IF NOT EXISTS / CHECK constraints added via
-- DO blocks so re-running the file is always safe.

-- ===========================================================================
-- 1. USERS — onboarding + risk state columns
-- ===========================================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_onboarding_state TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS device_risk_state TEXT NOT NULL DEFAULT 'NORMAL';
ALTER TABLE users ADD COLUMN IF NOT EXISTS fcm_token TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_referral_onboarding_state_check'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_referral_onboarding_state_check
      CHECK (referral_onboarding_state IN ('SKIPPED', 'USED') OR referral_onboarding_state IS NULL);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_device_risk_state_check'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_device_risk_state_check
      CHECK (device_risk_state IN ('NORMAL', 'REVIEW', 'BLOCKED'));
  END IF;
END $$;

-- The reward pipeline reads the risk state on every completion — keep it indexed.
CREATE INDEX IF NOT EXISTS users_device_risk_state_idx ON users (device_risk_state)
  WHERE device_risk_state <> 'NORMAL';

-- ===========================================================================
-- 2. USER DEVICES — privacy-conscious install registry
-- ===========================================================================
-- device_id is an opaque id the app persists at install time (it is NOT a
-- hardware identifier). One install can legitimately serve multiple accounts
-- (family device sharing) — this table only enables risk *signals*, never
-- automatic bans.

CREATE TABLE IF NOT EXISTS user_devices (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id   TEXT        NOT NULL,
  platform    TEXT,
  device_model TEXT,
  app_version TEXT,
  first_seen_at TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, device_id)
);

CREATE INDEX IF NOT EXISTS user_devices_device_id_idx ON user_devices (device_id);
CREATE INDEX IF NOT EXISTS user_devices_user_id_idx ON user_devices (user_id);
