-- After-trip tip credits: tips added AFTER the ride is COMPLETED are
-- credited to the driver wallet separately (the ride-completion credit
-- only captured the tip amount that existed at completion time).
ALTER TYPE payout_method ADD VALUE IF NOT EXISTS 'TIP_CREDIT';

-- Idempotency: at most one TIP_CREDIT row per ride. The wallet UPDATE is
-- guarded by the same delta math in the tip endpoint, so re-runs of the
-- same tip request never double-credit.
CREATE UNIQUE INDEX IF NOT EXISTS payouts_tip_credit_unique
  ON payouts (ride_id) WHERE method = 'TIP_CREDIT';
