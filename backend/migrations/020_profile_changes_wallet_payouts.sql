-- 020_profile_changes_wallet_payouts.sql
--
-- Profile-change approval queue, driver wallets, payout cards, and
-- payouts. Replaces the direct PATCH /driver/profile write path with
-- a pending→approved/rejected review workflow.
--
-- Idempotent. Safe to run after 001..019.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------- enums ----------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE profile_change_status AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payout_card_status AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payout_status AS ENUM ('PENDING', 'PROCESSING', 'PAID', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payout_method AS ENUM ('WEEKLY_AUTO', 'ON_DEMAND', 'RIDE_CREDIT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE card_brand AS ENUM ('visa', 'mastercard', 'amex', 'discover', 'unknown');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- profile_change_requests ---------------------------------------

CREATE TABLE IF NOT EXISTS profile_change_requests (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  driver_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requested_changes    JSONB NOT NULL,
  status               profile_change_status NOT NULL DEFAULT 'PENDING',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at          TIMESTAMPTZ,
  reviewed_by_admin_id UUID REFERENCES users(id) ON DELETE SET NULL,
  rejection_reason     TEXT,
  -- denormalized for quick admin list rendering if a card is queued
  card_last4           TEXT,
  card_brand           card_brand,
  -- snapshot of driver state at submission time, so rejection can restore
  prev_is_active       BOOLEAN,
  prev_bg_status       background_check_status,
  -- enforce "one open PENDING per driver" at the DB layer
  CONSTRAINT one_open_change_per_driver
    EXCLUDE (driver_id WITH =) WHERE (status = 'PENDING')
);

CREATE INDEX IF NOT EXISTS profile_change_requests_status_idx
  ON profile_change_requests (status, created_at DESC);
CREATE INDEX IF NOT EXISTS profile_change_requests_driver_idx
  ON profile_change_requests (driver_id, created_at DESC);

-- ---------- payout_cards (PCI-minimal; never store PAN or CVC) -------------

CREATE TABLE IF NOT EXISTS payout_cards (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  driver_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  brand            card_brand NOT NULL,
  last4            CHAR(4) NOT NULL,
  exp_month        INT  NOT NULL CHECK (exp_month BETWEEN 1 AND 12),
  exp_year         INT  NOT NULL CHECK (exp_year BETWEEN 2024 AND 2099),
  cardholder_name  TEXT NOT NULL,
  zip              TEXT NOT NULL,
  status           payout_card_status NOT NULL DEFAULT 'PENDING',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at      TIMESTAMPTZ,
  rejected_at      TIMESTAMPTZ,
  rejection_reason TEXT
);

CREATE INDEX IF NOT EXISTS payout_cards_driver_status_idx
  ON payout_cards (driver_id, status);
CREATE INDEX IF NOT EXISTS payout_cards_status_idx
  ON payout_cards (status, created_at DESC);

-- ---------- driver_wallets ------------------------------------------------

CREATE TABLE IF NOT EXISTS driver_wallets (
  driver_id               UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance_cents           BIGINT NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  lifetime_earnings_cents BIGINT NOT NULL DEFAULT 0 CHECK (lifetime_earnings_cents >= 0),
  payout_card_id          UUID REFERENCES payout_cards(id) ON DELETE SET NULL,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------- payouts --------------------------------------------------------

CREATE TABLE IF NOT EXISTS payouts (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  driver_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  fee_cents    BIGINT NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  net_cents    BIGINT NOT NULL CHECK (net_cents >= 0),
  status       payout_status NOT NULL DEFAULT 'PENDING',
  method       payout_method NOT NULL,
  ride_id      UUID REFERENCES rides(id) ON DELETE SET NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  reference    TEXT,
  notes        TEXT
);

-- Idempotency for ride credits: at most one RIDE_CREDIT row per ride.
CREATE UNIQUE INDEX IF NOT EXISTS payouts_ride_credit_unique
  ON payouts (ride_id) WHERE method = 'RIDE_CREDIT';

-- Idempotency for weekly auto-payouts: at most one OPEN WEEKLY_AUTO row
-- per driver. Lets the cron re-run safely without producing duplicate
-- payouts for the same week.
CREATE UNIQUE INDEX IF NOT EXISTS payouts_weekly_auto_pending_unique
  ON payouts (driver_id) WHERE method = 'WEEKLY_AUTO' AND status = 'PENDING';

CREATE INDEX IF NOT EXISTS payouts_driver_status_idx
  ON payouts (driver_id, status, requested_at DESC);
CREATE INDEX IF NOT EXISTS payouts_status_idx
  ON payouts (status, requested_at DESC);

-- ---------- RLS extensions ------------------------------------------------
ALTER TABLE profile_change_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE payout_cards             ENABLE ROW LEVEL SECURITY;
ALTER TABLE driver_wallets           ENABLE ROW LEVEL SECURITY;
ALTER TABLE payouts                  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Drivers can view own change requests" ON profile_change_requests;
CREATE POLICY "Drivers can view own change requests" ON profile_change_requests
  FOR SELECT USING (auth.uid() = driver_id);

DROP POLICY IF EXISTS "Drivers can view own payout cards" ON payout_cards;
CREATE POLICY "Drivers can view own payout cards" ON payout_cards
  FOR SELECT USING (auth.uid() = driver_id);

DROP POLICY IF EXISTS "Drivers can view own wallet" ON driver_wallets;
CREATE POLICY "Drivers can view own wallet" ON driver_wallets
  FOR SELECT USING (auth.uid() = driver_id);

DROP POLICY IF EXISTS "Drivers can view own payouts" ON payouts;
CREATE POLICY "Drivers can view own payouts" ON payouts
  FOR SELECT USING (auth.uid() = driver_id);