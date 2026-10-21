-- 20261019_repair_zero_fare_settlements.sql
--
-- Repair historical RIDE_COMPLETION rows written by the completion path bug
-- where the fare / promotion / credit components were read from the Trip
-- projection (which omits those columns). Every affected row therefore has
-- fare_cents = promotion_cents = credits_cents = gross_amount_cents = 0 even
-- though the ride row carries the real reserved amounts.
--
-- Only rows that are provably affected are touched: the ledger fare is zero
-- while the ride reserved a positive final payment. Wallet/payment status is
-- deliberately NOT rewritten here — this migration restores the fare
-- breakdown only; it never moves money or reclassifies a settlement.
--
-- Idempotent: after the first run fare_cents is non-zero, so the predicate
-- no longer matches.

UPDATE financial_transactions f
SET fare_cents = r.final_payment_cents,
    promotion_cents = COALESCE(r.promo_discount_cents, 0),
    credits_cents = COALESCE(r.credits_applied_cents, 0),
    gross_amount_cents = r.final_payment_cents
                       + COALESCE(r.promo_discount_cents, 0)
                       + COALESCE(r.credits_applied_cents, 0)
                       + COALESCE(f.tip_cents, 0),
    original_fare_cents = CASE
      WHEN COALESCE(f.original_fare_cents, 0) = 0
        THEN ROUND(COALESCE(r.fare_amount, 0) * 100)
      ELSE f.original_fare_cents
    END,
    rider_share_cents = CASE
      WHEN COALESCE(f.rider_share_cents, 0) = 0
        THEN r.final_payment_cents
      ELSE f.rider_share_cents
    END,
    updated_at = NOW()
FROM rides r
WHERE f.ride_id = r.id
  AND f.type = 'RIDE_COMPLETION'
  AND COALESCE(f.fare_cents, 0) = 0
  AND COALESCE(r.final_payment_cents, 0) > 0;
