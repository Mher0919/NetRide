// backend/scripts/backfill-financial-ledger.ts
//
// Idempotent, non-destructive backfill of the financial settlement ledger
// (financial_transactions) for rides that were COMPLETED before migration
// 044 existed. Safe to re-run any number of times:
//
//   - Only rides WITHOUT an existing RIDE_COMPLETION ledger row are
//     considered (NOT EXISTS guard).
//   - The insert carries the same idempotency_key the live path uses
//     (ride_completion:{rideId}) with ON CONFLICT DO NOTHING.
//
// Values mirror the live completion path:
//   fare_cents            = final_payment_cents (fare after promo+credits)
//   promotion/credits     = the stored per-ride discount columns
//   tip_cents             = tip_amount (decimal dollars -> cents)
//   wallet_payment_cents  = what the wallet actually paid at completion
//   driver/platform share = ride_price_snapshots allocation (migration 041)
//   status                = SETTLED when fully covered, PENDING_CAPTURE
//                           when an outstanding balance remains
//
// Usage: npx ts-node scripts/backfill-financial-ledger.ts

import { pool } from '../src/config/database';

const BACKFILL_SQL = `
INSERT INTO financial_transactions (
  ride_id, rider_id, driver_id, type, status, currency,
  gross_amount_cents, fare_cents, promotion_cents, credits_cents, tip_cents,
  wallet_payment_cents, amount_owed_cents,
  driver_share_cents, platform_share_cents, netride_share_cents,
  payment_provider, payment_reference, idempotency_key,
  completed_at, settled_at
)
SELECT
  r.id, r.rider_id, r.driver_id, 'RIDE_COMPLETION',
  CASE WHEN COALESCE(r.final_payment_cents, 0) - COALESCE(r.wallet_payment_cents, 0) <= 0
       THEN 'SETTLED' ELSE 'PENDING_CAPTURE' END,
  'USD',
  COALESCE(r.final_payment_cents, 0)
    + COALESCE(r.promo_discount_cents, 0)
    + COALESCE(r.credits_applied_cents, 0)
    + ROUND(COALESCE(r.tip_amount, 0) * 100),
  COALESCE(r.final_payment_cents, 0),
  COALESCE(r.promo_discount_cents, 0),
  COALESCE(r.credits_applied_cents, 0),
  ROUND(COALESCE(r.tip_amount, 0) * 100),
  COALESCE(r.wallet_payment_cents, 0),
  GREATEST(0, COALESCE(r.final_payment_cents, 0) - COALESCE(r.wallet_payment_cents, 0)),
  COALESCE(s.driver_share_cents, 0),
  COALESCE(s.platform_share_cents, 0),
  COALESCE(s.netride_share_cents, 0),
  'wallet', r.id,
  'ride_completion:' || r.id,
  r.completed_at,
  CASE WHEN COALESCE(r.final_payment_cents, 0) - COALESCE(r.wallet_payment_cents, 0) <= 0
       THEN r.completed_at ELSE NULL END
FROM rides r
LEFT JOIN ride_price_snapshots s ON s.ride_id = r.id
WHERE r.status = 'COMPLETED'
  AND NOT EXISTS (
    SELECT 1 FROM financial_transactions f
    WHERE f.ride_id = r.id AND f.type = 'RIDE_COMPLETION'
  )
ON CONFLICT (idempotency_key) DO NOTHING
`;

async function main() {
  const before = await pool.query(
    `SELECT COUNT(*) AS total FROM financial_transactions WHERE type = 'RIDE_COMPLETION'`,
  );
  console.log(
    `[BACKFILL] ledger rows before: ${Number(before.rows[0].total)}`,
  );

  const inserted = await pool.query(BACKFILL_SQL);
  console.log(`[BACKFILL] inserted ${inserted.rowCount} new ledger row(s).`);

  const after = await pool.query(
    `SELECT
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE status = 'SETTLED') AS settled,
       COUNT(*) FILTER (WHERE status = 'PENDING_CAPTURE') AS pending
     FROM financial_transactions WHERE type = 'RIDE_COMPLETION'`,
  );
  const row = after.rows[0];
  console.log(
    `[BACKFILL] ledger now: ${Number(row.total)} total ` +
      `(${Number(row.settled)} SETTLED, ${Number(row.pending)} PENDING_CAPTURE).`,
  );
  await pool.end();
}

main().catch(async (err) => {
  console.error('[BACKFILL] failed:', err.message);
  await pool.end();
  process.exit(1);
});