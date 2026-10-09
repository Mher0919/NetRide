-- backend/migrations/052_stripe_payments.sql
--
-- STRIPE PAYMENTS + IMMUTABLE FARE BREAKDOWNS
-- ---------------------------------------------------------------------------
-- Stripe Connect (separate charges & transfers):
--   * rider fares and sponsor budget top-ups are charged on the PLATFORM
--     account (PaymentIntents / Checkout Sessions);
--   * drivers receive Transfers to their Express connected account.
--
-- Every money column is INTEGER CENTS (BIGINT). The backend is the only
-- writer; clients never send authoritative amounts. Idempotency is enforced
-- with unique keys / partial unique indexes so retries and duplicate
-- webhooks can never charge, settle or transfer twice.
--
-- Depends on 051_stripe_enums.sql (payout_method SPECIAL_TOPUP,
-- wallet WALLET_TOPUP) — separate transaction on purpose (Postgres 55P04).

-- ---------------------------------------------------------------------------
-- 1. stripe_customers — rider (and any off-session payer) Stripe Customer
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stripe_customers (
  user_id                 UUID        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  stripe_customer_id      TEXT        NOT NULL UNIQUE,
  default_payment_method_id TEXT,
  card_brand              TEXT,
  card_last4              TEXT,
  card_exp_month          INT,
  card_exp_year           INT,
  -- Explicit rider consent to conditional off-session charges (special
  -- no-show fallback). Recorded server-side with a timestamp.
  off_session_consent     BOOLEAN     NOT NULL DEFAULT FALSE,
  off_session_consent_at  TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- 2. driver_stripe_accounts — Express connected account per driver
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS driver_stripe_accounts (
  driver_id           UUID        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  stripe_account_id   TEXT        NOT NULL UNIQUE,
  details_submitted   BOOLEAN     NOT NULL DEFAULT FALSE,
  payouts_enabled     BOOLEAN     NOT NULL DEFAULT FALSE,
  charges_enabled     BOOLEAN     NOT NULL DEFAULT FALSE,
  requirements_due    JSONB,
  disabled_reason     TEXT,
  last_synced_at      TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- 3. stripe_payments — every Stripe collection attempt, one row per PI
--    (rider wallet top-up, sponsor budget top-up, ride charge, special
--    additional charge). Local status is only advanced by verified webhooks
--    or by an explicit reconciliation read of the Stripe object.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stripe_payments (
  id                        UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  purpose                   TEXT        NOT NULL
                            CHECK (purpose IN ('RIDER_WALLET_TOPUP','SPONSOR_BUDGET_TOPUP','RIDE_CHARGE','RIDE_ADDITIONAL_CHARGE')),
  user_id                   UUID,
  sponsor_id                UUID        REFERENCES sponsors(id) ON DELETE SET NULL,
  ride_id                   UUID        REFERENCES rides(id) ON DELETE SET NULL,
  amount_cents              BIGINT      NOT NULL CHECK (amount_cents > 0),
  currency                  TEXT        NOT NULL DEFAULT 'USD',
  status                    TEXT        NOT NULL DEFAULT 'PENDING'
                            CHECK (status IN ('PENDING','REQUIRES_ACTION','PROCESSING','SUCCEEDED','FAILED','CANCELED','REFUNDED')),
  stripe_customer_id        TEXT,
  stripe_payment_intent_id  TEXT        UNIQUE,
  stripe_checkout_session_id TEXT       UNIQUE,
  stripe_charge_id          TEXT,
  stripe_fee_cents          BIGINT      NOT NULL DEFAULT 0,
  idempotency_key           TEXT        UNIQUE,
  ledger_entry_id           UUID        REFERENCES sponsor_ledger_entries(id) ON DELETE SET NULL,
  failure_reason            TEXT,
  metadata                  JSONB,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  succeeded_at              TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS stripe_payments_user_idx
  ON stripe_payments (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS stripe_payments_sponsor_idx
  ON stripe_payments (sponsor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS stripe_payments_ride_idx
  ON stripe_payments (ride_id, created_at DESC);
CREATE INDEX IF NOT EXISTS stripe_payments_status_idx
  ON stripe_payments (status, created_at DESC);

-- ---------------------------------------------------------------------------
-- 4. stripe_webhook_events — verified-webhook idempotency ledger.
--    The event id is the primary key: duplicate deliveries insert nothing
--    and are skipped.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  stripe_event_id  TEXT        PRIMARY KEY,
  type             TEXT        NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'PROCESSING'
                   CHECK (status IN ('PROCESSING','PROCESSED','FAILED','SKIPPED')),
  payload          JSONB,
  error            TEXT,
  received_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS stripe_webhook_events_type_idx
  ON stripe_webhook_events (type, received_at DESC);
CREATE INDEX IF NOT EXISTS stripe_webhook_events_status_idx
  ON stripe_webhook_events (status, received_at DESC);

-- ---------------------------------------------------------------------------
-- 5. ride_fare_breakdowns — the IMMUTABLE financial snapshot of an accepted
--    ride. Written once per ride from server-side data (quote snapshot +
--    revenue allocation + special reservation). Later campaign edits,
--    commission changes or special changes never alter an accepted ride.
--
--    Invariants (validated server-side before write):
--      original_fare_cents = rider_share_cents + sponsor_subsidy_cents
--                            + promo_discount_cents + credits_applied_cents
--      driver_earnings_cents + platform_commission_cents = original_fare_cents
--      all amounts >= 0; sponsor_subsidy_cents <= original_fare_cents
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ride_fare_breakdowns (
  ride_id                     UUID        PRIMARY KEY REFERENCES rides(id) ON DELETE CASCADE,
  special_redemption_id       UUID        REFERENCES special_redemptions(id) ON DELETE SET NULL,
  currency                    TEXT        NOT NULL DEFAULT 'USD',

  -- what the rider was quoted and what they owe
  original_fare_cents         BIGINT      NOT NULL DEFAULT 0 CHECK (original_fare_cents >= 0),
  promo_discount_cents        BIGINT      NOT NULL DEFAULT 0 CHECK (promo_discount_cents >= 0),
  credits_applied_cents       BIGINT      NOT NULL DEFAULT 0 CHECK (credits_applied_cents >= 0),
  sponsor_subsidy_cents       BIGINT      NOT NULL DEFAULT 0 CHECK (sponsor_subsidy_cents >= 0),
  rider_share_cents           BIGINT      NOT NULL DEFAULT 0 CHECK (rider_share_cents >= 0),

  -- what NetRide owes per the commission policy, always from the ORIGINAL fare
  driver_earnings_cents       BIGINT      NOT NULL DEFAULT 0 CHECK (driver_earnings_cents >= 0),
  platform_commission_cents   BIGINT      NOT NULL DEFAULT 0 CHECK (platform_commission_cents >= 0),
  fleet_share_cents           BIGINT      NOT NULL DEFAULT 0 CHECK (fleet_share_cents >= 0),
  driver_share_percent        DOUBLE PRECISION,
  platform_share_percent      DOUBLE PRECISION,

  -- what has actually been collected / settled
  rider_collected_cents       BIGINT      NOT NULL DEFAULT 0 CHECK (rider_collected_cents >= 0),
  sponsor_collected_cents     BIGINT      NOT NULL DEFAULT 0 CHECK (sponsor_collected_cents >= 0),
  additional_rider_charge_cents BIGINT    NOT NULL DEFAULT 0 CHECK (additional_rider_charge_cents >= 0),
  additional_charge_status    TEXT        NOT NULL DEFAULT 'NONE'
                              CHECK (additional_charge_status IN ('NONE','REQUIRED','PROCESSING','COLLECTED','FAILED','WAIVED')),
  sponsor_contribution_status TEXT        NOT NULL DEFAULT 'NONE'
                              CHECK (sponsor_contribution_status IN ('NONE','RESERVED','COLLECTED','RELEASED','FAILED')),
  driver_settled_cents        BIGINT      NOT NULL DEFAULT 0 CHECK (driver_settled_cents >= 0),
  settlement_status           TEXT        NOT NULL DEFAULT 'PENDING'
                              CHECK (settlement_status IN ('PENDING','PARTIALLY_SETTLED','SETTLED','EXCEPTION')),

  -- Stripe objects + consent evidence
  rider_payment_intent_id     TEXT,
  additional_charge_payment_intent_id TEXT,
  additional_charge_consent_at TIMESTAMPTZ,
  additional_charge_collected_at TIMESTAMPTZ,
  sponsor_settled_at          TIMESTAMPTZ,
  driver_settled_at           TIMESTAMPTZ,
  settled_at                  TIMESTAMPTZ,
  expiration_processed_at     TIMESTAMPTZ,
  reconciliation_note         TEXT,

  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ride_fare_breakdowns_settlement_idx
  ON ride_fare_breakdowns (settlement_status, created_at DESC);
CREATE INDEX IF NOT EXISTS ride_fare_breakdowns_additional_idx
  ON ride_fare_breakdowns (additional_charge_status, created_at DESC)
  WHERE additional_charge_status <> 'NONE';
CREATE INDEX IF NOT EXISTS ride_fare_breakdowns_sponsor_idx
  ON ride_fare_breakdowns (sponsor_contribution_status, created_at DESC)
  WHERE sponsor_contribution_status <> 'NONE';

-- ---------------------------------------------------------------------------
-- 6. financial_transactions — separate rider / sponsor components + Stripe
--    references so a single $10 ride reconciles across both funding sources.
-- ---------------------------------------------------------------------------
ALTER TABLE financial_transactions
  ADD COLUMN IF NOT EXISTS original_fare_cents        BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rider_share_cents          BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sponsor_subsidy_cents      BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sponsor_collected_cents    BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS additional_rider_charge_cents BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stripe_fee_cents           BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stripe_payment_intent_id   TEXT,
  ADD COLUMN IF NOT EXISTS stripe_transfer_id         TEXT,
  ADD COLUMN IF NOT EXISTS sponsor_contribution_status TEXT NOT NULL DEFAULT 'NONE',
  ADD COLUMN IF NOT EXISTS additional_charge_status   TEXT NOT NULL DEFAULT 'NONE';

CREATE INDEX IF NOT EXISTS financial_transactions_ride_stripe_idx
  ON financial_transactions (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 7. payouts — real Stripe Transfer tracking. The existing payout ledger is
--    preserved; a transfer only changes the rail it uses.
-- ---------------------------------------------------------------------------
ALTER TABLE payouts
  ADD COLUMN IF NOT EXISTS stripe_transfer_id     TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS stripe_transfer_status TEXT,
  ADD COLUMN IF NOT EXISTS stripe_failure_reason  TEXT;

-- Driver earnings true-up when a special ride was completed under the legacy
-- discounted-fare accounting (one true-up per ride).
CREATE UNIQUE INDEX IF NOT EXISTS payouts_special_topup_ride_uniq
  ON payouts (ride_id)
  WHERE method = 'SPECIAL_TOPUP';

CREATE INDEX IF NOT EXISTS payouts_stripe_transfer_idx
  ON payouts (stripe_transfer_status)
  WHERE stripe_transfer_status IS NOT NULL;
