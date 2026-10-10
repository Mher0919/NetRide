-- backend/migrations/054_withdrawals.sql
--
-- MANUAL WITHDRAWALS (drivers + sponsors)
-- ---------------------------------------------------------------------------
-- * The automatic weekly payout sweep (WEEKLY_AUTO creation) is retired:
--   payouts are created ONLY by the account owner pressing "Withdraw".
-- * Weekly rule (shared by drivers and sponsors): at most one withdrawal per
--   calendar week, and the availability window ALWAYS opens on Monday 00:00
--   UTC — a withdrawal on any day of the week makes the next opportunity the
--   following Monday. Accounts that never withdrew are immediately eligible.
-- * Sponsors get a managed card (Stripe Checkout mode=setup) and a manual
--   budget withdrawal implemented as STRIPE REFUNDS of their funding charges
--   (auditable, idempotent per withdrawal), recorded in the sponsor ledger
--   as WITHDRAWAL entries.

-- 1. Sponsor payment profile columns (Stripe Customer + default card).
ALTER TABLE sponsors
  ADD COLUMN IF NOT EXISTS stripe_customer_id        TEXT,
  ADD COLUMN IF NOT EXISTS default_payment_method_id TEXT,
  ADD COLUMN IF NOT EXISTS card_brand                TEXT,
  ADD COLUMN IF NOT EXISTS card_last4                TEXT,
  ADD COLUMN IF NOT EXISTS card_exp_month            INT,
  ADD COLUMN IF NOT EXISTS card_exp_year             INT,
  ADD COLUMN IF NOT EXISTS updated_payment_at        TIMESTAMPTZ;

-- 2. Sponsor withdrawals (one row per manual withdrawal request).
CREATE TABLE IF NOT EXISTS sponsor_withdrawals (
  id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  sponsor_id    UUID        NOT NULL REFERENCES sponsors(id) ON DELETE CASCADE,
  amount_cents  BIGINT      NOT NULL CHECK (amount_cents > 0),
  currency      TEXT        NOT NULL DEFAULT 'USD',
  status        TEXT        NOT NULL DEFAULT 'PENDING'
                CHECK (status IN ('PENDING','COMPLETED','FAILED')),
  -- Stripe refund ids applied to funding charges (idempotent replay-safe).
  refund_ids    JSONB       NOT NULL DEFAULT '[]',
  failure_reason TEXT,
  created_by    UUID,
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sponsor_withdrawals_sponsor_idx
  ON sponsor_withdrawals (sponsor_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS sponsor_withdrawals_status_idx
  ON sponsor_withdrawals (status, requested_at ASC)
  WHERE status IN ('PENDING','FAILED');

-- 3. Sponsor ledger: allow WITHDRAWAL entries.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sponsor_ledger_entries_type_check') THEN
    ALTER TABLE sponsor_ledger_entries DROP CONSTRAINT sponsor_ledger_entries_type_check;
  END IF;
  ALTER TABLE sponsor_ledger_entries
    ADD CONSTRAINT sponsor_ledger_entries_type_check
    CHECK (type IN ('INITIAL_FUNDING','BUDGET_ADJUSTMENT','DISCOUNT_REDEEMED',
                    'REVERSAL','EXPIRATION','WITHDRAWAL'));
END $$;