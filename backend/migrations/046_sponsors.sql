-- backend/migrations/046_sponsors.sql
--
-- SPONSORS + SPECIALS — sponsor-funded ride discount marketplace.
-- ---------------------------------------------------------------------------
-- Money is integer cents (BIGINT) everywhere, matching wallet/credits/ledger.
--
-- Financial model (three independent ledgers, never conflated):
--   sponsors.remaining_budget_cents   = CACHED aggregate (audit source is
--                                       sponsor_ledger_entries, which is the
--                                       only place budget movements are recorded)
--   payouts (method='SPONSOR_CREDIT')  = driver financial entitlement (60% of
--                                       the sponsor-funded discount)
--   ride_credit_accounts / rider_wallets = rider benefit (refund OR credits)
--   netride allocation                  = 40% share, recorded on the redemption
--
-- The canonical domain object is special_redemptions. Its lifecycle:
--   CREATED              rider selected the sponsor (pre-ride intent)
--   RIDE_PENDING         special ride requested; snapshot + budget check done
--   WAITING_FOR_SPONSOR  ride completed; one-time validation code issued
--   SPONSOR_VALIDATED    sponsor confirmed the visit
--   REWARD_SELECTED      rider chose refund/credits; settlement running
--   REWARD_COMPLETED     settlement done (idempotent terminal)
--   CANCELLED            sponsor (or system) cancelled pre-reward
--   EXPIRED              validation code expired
--   REWARD_FAILED        settlement failed; safe to retry
--
-- Immutability: every redemption snapshots the sponsor's name/type/location/
-- address/discount config at creation, and the discount AMOUNT at ride
-- request (calculated_discount_cents). Later sponsor edits never rewrite
-- historical redemptions.

-- NOTE: enum extensions (user_role 'SPONSOR', payout_method 'SPONSOR_CREDIT')
-- live in 046a_sponsors_enums.sql and must be applied BEFORE this file
-- (Postgres 55P04: an enum value cannot be used in the transaction that
-- adds it — payout_method is referenced by the partial index below).

-- ---------------------------------------------------------------------------
-- SPONSORS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sponsors (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_name            TEXT        NOT NULL,
  business_type            TEXT        NOT NULL DEFAULT 'OTHER',
  business_description     TEXT,
  manager_name             TEXT,
  phone                    TEXT,
  email                    TEXT,
  other_contact_info       TEXT,
  address                  TEXT,
  city                     TEXT,
  state                    TEXT,
  postal_code              TEXT,
  country                  TEXT,
  latitude                 DOUBLE PRECISION,
  longitude                DOUBLE PRECISION,
  logo_url                 TEXT,
  cover_image_url          TEXT,

  discount_type            TEXT        NOT NULL
                             CHECK (discount_type IN ('PERCENTAGE', 'FIXED_AMOUNT')),
  discount_percent         DOUBLE PRECISION
                             CHECK (discount_percent IS NULL OR (discount_percent > 0 AND discount_percent <= 100)),
  max_discount_percent     DOUBLE PRECISION NOT NULL DEFAULT 90
                             CHECK (max_discount_percent > 0 AND max_discount_percent <= 100),
  discount_fixed_amount_cents BIGINT
                             CHECK (discount_fixed_amount_cents IS NULL OR discount_fixed_amount_cents > 0),

  initial_budget_cents     BIGINT      NOT NULL DEFAULT 0
                             CHECK (initial_budget_cents >= 0),
  remaining_budget_cents   BIGINT      NOT NULL DEFAULT 0
                             CHECK (remaining_budget_cents >= 0),
  reserved_budget_cents    BIGINT      NOT NULL DEFAULT 0
                             CHECK (reserved_budget_cents >= 0),
  used_budget_cents        BIGINT      NOT NULL DEFAULT 0
                             CHECK (used_budget_cents >= 0),

  status                   TEXT        NOT NULL DEFAULT 'INACTIVE'
                             CHECK (status IN ('ACTIVE', 'INACTIVE', 'SUSPENDED', 'DEPLETED')),
  specials_enabled         BOOLEAN     NOT NULL DEFAULT TRUE,
  map_listing_enabled      BOOLEAN     NOT NULL DEFAULT TRUE,

  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Eligible-sponsor scan (SPECIALS list / markers / recommendation queries).
-- Only ACTIVE + enabled sponsors with any usable budget are ever visible.
CREATE INDEX IF NOT EXISTS sponsors_eligibility_idx
  ON sponsors (status, specials_enabled, map_listing_enabled)
  WHERE remaining_budget_cents > 0;
CREATE INDEX IF NOT EXISTS sponsors_status_idx ON sponsors (status);
CREATE INDEX IF NOT EXISTS sponsors_business_type_idx ON sponsors (business_type);
-- Geo-bounded queries (markers/specials near a point/bbox).
CREATE INDEX IF NOT EXISTS sponsors_geo_idx ON sponsors (latitude, longitude);

-- ---------------------------------------------------------------------------
-- SPONSOR PORTAL ACCOUNTS (role=SPONSOR users bound to exactly one sponsor)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sponsor_portal_accounts (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sponsor_id            UUID        NOT NULL REFERENCES sponsors(id) ON DELETE CASCADE,
  user_id               UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_active             BOOLEAN     NOT NULL DEFAULT TRUE,
  must_change_password  BOOLEAN     NOT NULL DEFAULT TRUE,
  created_by_admin_id   UUID,
  last_login_at         TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS sponsor_portal_accounts_sponsor_uniq
  ON sponsor_portal_accounts (sponsor_id);
CREATE UNIQUE INDEX IF NOT EXISTS sponsor_portal_accounts_user_uniq
  ON sponsor_portal_accounts (user_id);

-- ---------------------------------------------------------------------------
-- SPONSOR BUDGET LEDGER (the audit source — never mutate budget silently)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sponsor_ledger_entries (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sponsor_id          UUID        NOT NULL REFERENCES sponsors(id) ON DELETE CASCADE,
  type                TEXT        NOT NULL
                        CHECK (type IN ('INITIAL_FUNDING', 'BUDGET_ADJUSTMENT',
                                       'DISCOUNT_REDEEMED', 'REVERSAL', 'EXPIRATION')),
  amount_cents        BIGINT      NOT NULL,          -- signed: +funding / -consumed
  direction           TEXT        NOT NULL DEFAULT 'CREDIT'
                        CHECK (direction IN ('CREDIT', 'DEBIT')),
  reference_type      TEXT,
  reference_id        UUID,
  reason              TEXT,
  actor_user_id       UUID,
  actor_role          TEXT,
  balance_after_cents BIGINT      NOT NULL,          -- cached aggregate after entry
  idempotency_key     TEXT        UNIQUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sponsor_ledger_sponsor_idx
  ON sponsor_ledger_entries (sponsor_id, created_at DESC);
-- One DISCOUNT_REDEEMED entry per redemption: a double reward settle can
-- never create a second budget debit.
CREATE UNIQUE INDEX IF NOT EXISTS sponsor_ledger_redeem_uniq
  ON sponsor_ledger_entries (reference_id)
  WHERE type = 'DISCOUNT_REDEEMED';

-- ---------------------------------------------------------------------------
-- SPECIAL REDEMPTIONS (the canonical sponsorship domain object)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS special_redemptions (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sponsor_id          UUID        NOT NULL REFERENCES sponsors(id),
  rider_id            UUID        NOT NULL REFERENCES users(id),
  driver_id           UUID,
  ride_id             UUID        UNIQUE REFERENCES rides(id) ON DELETE SET NULL,

  -- Immutable snapshots (see module header): taken at creation / ride request.
  sponsor_name             TEXT        NOT NULL,
  sponsor_business_type    TEXT        NOT NULL,
  sponsor_latitude         DOUBLE PRECISION,
  sponsor_longitude        DOUBLE PRECISION,
  sponsor_address          TEXT,
  discount_type            TEXT        NOT NULL
                             CHECK (discount_type IN ('PERCENTAGE', 'FIXED_AMOUNT')),
  discount_percent         DOUBLE PRECISION,
  discount_fixed_amount_cents BIGINT,
  discount_label           TEXT        NOT NULL,     -- "20%" / "$8.00" display copy
  calculated_discount_cents BIGINT     NOT NULL DEFAULT 0,
                            -- authoritative discount for THIS ride (computed at
                            -- ride request from the quoted fare, budget-capped)

  -- One-time validation code (HMAC-SHA256 hash only — never plaintext).
  validation_code_hash    TEXT,
  validation_expires_at   TIMESTAMPTZ,
  validation_attempts     INT         NOT NULL DEFAULT 0,
  max_validation_attempts INT         NOT NULL DEFAULT 5,

  status                  TEXT        NOT NULL DEFAULT 'CREATED'
                            CHECK (status IN ('CREATED', 'RIDE_PENDING',
                                   'WAITING_FOR_SPONSOR', 'SPONSOR_VALIDATED',
                                   'REWARD_SELECTED', 'REWARD_COMPLETED',
                                   'CANCELLED', 'EXPIRED', 'REWARD_FAILED')),

  ride_requested_at       TIMESTAMPTZ,
  ride_completed_at       TIMESTAMPTZ,

  sponsor_validated_at    TIMESTAMPTZ,
  sponsor_validated_by    UUID,

  cancelled_by            UUID,
  cancelled_at            TIMESTAMPTZ,
  cancellation_reason_code TEXT,
  cancellation_reason_text TEXT,

  reward_choice            TEXT CHECK (reward_choice IN ('REFUND', 'CREDITS')),
  reward_amount_cents      BIGINT,                  -- what the rider receives
  sponsor_funded_cents     BIGINT,                  -- sponsor debited (D)
  driver_allocation_cents  BIGINT,                  -- 60% of D
  netride_allocation_cents BIGINT,                  -- 40% of D
  netride_bonus_cents      BIGINT,                  -- extra +10% credits (NetRide expense)
  wallet_transaction_id    UUID,
  credit_transaction_id    UUID,

  sponsor_settled_at       TIMESTAMPTZ,             -- budget debited + allocations booked
  reward_processed_at      TIMESTAMPTZ,
  reward_failed_reason     TEXT,

  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS special_redemptions_rider_status_idx
  ON special_redemptions (rider_id, status);
CREATE INDEX IF NOT EXISTS special_redemptions_sponsor_created_idx
  ON special_redemptions (sponsor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS special_redemptions_sponsor_status_idx
  ON special_redemptions (sponsor_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS special_redemptions_status_created_idx
  ON special_redemptions (status, created_at DESC);
CREATE INDEX IF NOT EXISTS special_redemptions_validated_idx
  ON special_redemptions (sponsor_id, sponsor_validated_at DESC);
-- Code lookup: exact hash match only.
CREATE INDEX IF NOT EXISTS special_redemptions_code_hash_idx
  ON special_redemptions (validation_code_hash)
  WHERE validation_code_hash IS NOT NULL;

-- Driver sponsor-earnings: the 60% sponsor-funded share is booked as a
-- distinct earnings component on the existing payouts ledger. Requires the
-- 'SPONSOR_CREDIT' enum value from 046a (cannot be added here — 55P04).
CREATE UNIQUE INDEX IF NOT EXISTS payouts_sponsor_credit_ride_uniq
  ON payouts (ride_id)
  WHERE method = 'SPONSOR_CREDIT';

-- ---------------------------------------------------------------------------
-- RIDE integration
-- ---------------------------------------------------------------------------
-- The sponsor discount is a fare REDUCTION funded by the sponsor: the rider's
-- wallet is charged final_payment_cents (fare − promo − credits − sponsor
-- discount). The original quoted fare is never modified (spec §73).
ALTER TABLE rides ADD COLUMN IF NOT EXISTS sponsor_discount_cents BIGINT NOT NULL DEFAULT 0;

-- Rider refund settlements carry a new wallet transaction type.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_transactions_type_check') THEN
    ALTER TABLE wallet_transactions DROP CONSTRAINT wallet_transactions_type_check;
    ALTER TABLE wallet_transactions ADD CONSTRAINT wallet_transactions_type_check
      CHECK (type IN ('ADMIN_GRANT', 'RIDE_PAYMENT', 'RIDE_REFUND', 'ADJUSTMENT', 'SPONSOR_REWARD'));
  END IF;
END $$;

-- First-time SPECIALS intro is persisted server-side (spec §94): the intro
-- shows once per rider, ever.
ALTER TABLE users ADD COLUMN IF NOT EXISTS specials_intro_seen_at TIMESTAMPTZ;