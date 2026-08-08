-- backend/migrations/039_rider_wallet.sql
--
-- RIDER WALLET — stored-value wallet for paying ride fares.
-- ---------------------------------------------------------------------------
-- The rider wallet is the DEFAULT payment method for a ride: the wallet is
-- charged the remaining fare AFTER promos and ride credits have been applied
-- (credits are a discount on top, the wallet pays the rest). No payment
-- provider exists in this product — wallets are funded through admin grants
-- and test-mode seeding. The backend is the only writer; riders only read.
--
-- Changes:
--   rider_wallets         per-rider stored value (BIGINT cents)
--   wallet_transactions   append-only ledger, one row per movement
--   rides.wallet_payment_cents  what the wallet was charged for the ride
--   rides.wallet_refunded_at    set once when a cancelled ride is refunded
--
-- Idempotency strategy (same pattern as all prior migrations): ADD COLUMN
-- IF NOT EXISTS / CREATE TABLE IF NOT EXISTS / CHECK constraints added via
-- DO blocks so re-running the file is always safe.

-- ===========================================================================
-- 1. RIDER WALLETS — stored-value balances
-- ===========================================================================

CREATE TABLE IF NOT EXISTS rider_wallets (
  user_id                UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance_cents          BIGINT NOT NULL DEFAULT 0,
  lifetime_deposited_cents BIGINT NOT NULL DEFAULT 0,
  lifetime_spent_cents   BIGINT NOT NULL DEFAULT 0,
  updated_at             TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'rider_wallets_balance_nonneg'
  ) THEN
    ALTER TABLE rider_wallets ADD CONSTRAINT rider_wallets_balance_nonneg
      CHECK (balance_cents >= 0);
  END IF;
END $$;

-- ===========================================================================
-- 2. WALLET TRANSACTIONS — append-only ledger
-- ===========================================================================
-- amount_cents is signed: positive = deposit (ADMIN_GRANT, RIDE_REFUND),
-- negative = spend (RIDE_PAYMENT, ADJUSTMENT). balance_after_cents is the
-- wallet balance immediately after this movement. idempotency_key dedupes
-- retries and concurrent lifecycle events (e.g. double-cancel).

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents        BIGINT NOT NULL,
  type                TEXT NOT NULL,
  reference_type      TEXT,
  reference_id        UUID,
  ride_id             UUID REFERENCES rides(id) ON DELETE SET NULL,
  description         TEXT,
  balance_after_cents BIGINT NOT NULL,
  idempotency_key     TEXT UNIQUE,
  created_at          TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'wallet_transactions_type_check'
  ) THEN
    ALTER TABLE wallet_transactions ADD CONSTRAINT wallet_transactions_type_check
      CHECK (type IN ('ADMIN_GRANT', 'RIDE_PAYMENT', 'RIDE_REFUND', 'ADJUSTMENT'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS wallet_transactions_user_created_idx
  ON wallet_transactions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS wallet_transactions_type_idx
  ON wallet_transactions (type);

-- ===========================================================================
-- 3. RIDES — wallet payment columns
-- ===========================================================================

ALTER TABLE rides ADD COLUMN IF NOT EXISTS wallet_payment_cents BIGINT NOT NULL DEFAULT 0;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS wallet_refunded_at TIMESTAMPTZ(6);
