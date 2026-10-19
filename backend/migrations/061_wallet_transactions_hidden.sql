-- 061_wallet_transactions_hidden.sql
--
-- Rider-controlled PAYMENT HISTORY visibility.
--
-- The wallet ledger is append-only financial truth and is NEVER mutated or
-- deleted. "Delete"/"Clear all" in the rider app only HIDES entries from the
-- rider's own history view (`hidden_at IS NULL` filter), so accounting,
-- reconciliation and admin reports keep the complete trail.

ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS hidden_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_wallet_tx_visible
  ON wallet_transactions (user_id, created_at DESC)
  WHERE hidden_at IS NULL;
