-- backend/migrations/044_financial_ledger.sql
--
-- FINANCIAL LEDGER (server-authoritative ride settlement)
-- ---------------------------------------------------------------------------
-- ONE financial_transactions row per completed ride (type RIDE_COMPLETION).
-- Written only by the backend at ride completion time, idempotently
-- (idempotency_key ride_completion:{rideId} + partial unique on ride_id).
-- Money is stored as integer cents. All timestamps in UTC (timestamptz).
--
-- Status lifecycle (financial settlement, separate from ride lifecycle):
--   SETTLED          rider payment fully captured (or fully covered by
--                    promo/credits -> due 0)
--   PENDING_CAPTURE  wallet charge fell short of the amount due
--                    (amount_owed_cents > 0); revenue not yet settled
--                    until the outstanding amount is captured
--
-- Revenue accounting rule: only SETTLED rows count toward revenue, driver
-- earnings summaries and analytics. A ride is financially counted once
-- (and only once) thanks to the partial unique index below.

CREATE TABLE IF NOT EXISTS financial_transactions (
  id                    UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  ride_id               UUID        NOT NULL REFERENCES rides(id),
  rider_id              UUID,
  driver_id             UUID,
  type                  TEXT        NOT NULL DEFAULT 'RIDE_COMPLETION'
                                      CHECK (type IN ('RIDE_COMPLETION')),
  status                TEXT        NOT NULL DEFAULT 'SETTLED'
                                      CHECK (status IN ('SETTLED', 'PENDING_CAPTURE')),
  currency              TEXT        NOT NULL DEFAULT 'USD',

  gross_amount_cents    BIGINT      NOT NULL DEFAULT 0,
  fare_cents            BIGINT      NOT NULL DEFAULT 0,
  promotion_cents       BIGINT      NOT NULL DEFAULT 0,
  credits_cents         BIGINT      NOT NULL DEFAULT 0,
  tip_cents             BIGINT      NOT NULL DEFAULT 0,
  wallet_payment_cents  BIGINT      NOT NULL DEFAULT 0,
  amount_owed_cents     BIGINT      NOT NULL DEFAULT 0,

  driver_share_cents    BIGINT      NOT NULL DEFAULT 0,
  platform_share_cents  BIGINT      NOT NULL DEFAULT 0,
  netride_share_cents   BIGINT      NOT NULL DEFAULT 0,

  payment_provider      TEXT,
  payment_reference     TEXT,
  idempotency_key       TEXT        UNIQUE,
  completed_at          TIMESTAMPTZ NOT NULL,
  settled_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- At most one financial settlement per ride: concurrent completion
-- attempts (double socket emit, retry after crash) can only insert once.
CREATE UNIQUE INDEX IF NOT EXISTS financial_transactions_ride_uniq
  ON financial_transactions (ride_id)
  WHERE type = 'RIDE_COMPLETION';

CREATE INDEX IF NOT EXISTS financial_transactions_completed_at_idx
  ON financial_transactions (completed_at DESC);
CREATE INDEX IF NOT EXISTS financial_transactions_driver_idx
  ON financial_transactions (driver_id, completed_at DESC);
CREATE INDEX IF NOT EXISTS financial_transactions_rider_idx
  ON financial_transactions (rider_id, completed_at DESC);
CREATE INDEX IF NOT EXISTS financial_transactions_status_idx
  ON financial_transactions (status);
CREATE INDEX IF NOT EXISTS financial_transactions_status_completed_idx
  ON financial_transactions (status, completed_at DESC);