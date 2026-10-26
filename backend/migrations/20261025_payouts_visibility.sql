-- 20261025_payouts_visibility.sql
--
-- Driver-facing payout history is user-manageable: a driver can swipe a
-- recent payout away from their account view. This is a VISIBILITY flag
-- only — the payout row stays in the ledger so weekly withdrawal limits,
-- reconciliation and admin reporting keep the complete trail.

ALTER TABLE payouts ADD COLUMN IF NOT EXISTS hidden_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_payouts_visible
  ON payouts (driver_id, requested_at DESC)
  WHERE hidden_at IS NULL;
