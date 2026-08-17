// backend/scripts/check-shared-columns.cjs
// Lightweight smoke probe: a curated list of important tables / columns
// the app code reaches for at startup. Use to catch schema drift without
// running the full gaps audit.
//
// Pure pg queries, no migration scanning. Exits 0 if every probe passes,
// 1 otherwise.

require('dotenv').config();
const { Client } = require('pg');

const probes = [
  ['table', 'users', null],
  ['column', 'users', 'rating'],
  ['column', 'users', 'is_active'],
  ['column', 'users', 'verification_status'],
  ['column', 'users', 'blocked_reason'],
  ['column', 'users', 'referral_onboarding_state'],
  ['table', 'drivers', null],
  ['column', 'drivers', 'rating'],
  ['column', 'drivers', 'is_active'],
  ['column', 'drivers', 'cancellation_count'],
  ['column', 'drivers', 'last_cancellation_at'],
  ['table', 'driver_vehicles', null],
  ['column', 'driver_vehicles', 'service_class'],
  ['column', 'driver_vehicles', 'seats'],
  ['column', 'driver_vehicles', 'is_luxury'],
  ['table', 'driver_vehicle_submissions', null],
  ['column', 'driver_vehicle_submissions', 'seats'],
  ['column', 'driver_vehicle_submissions', 'is_luxury'],
  ['table', 'ride_driver_rejections', null],
  ['column', 'ride_driver_rejections', 'interaction_type'],
  ['column', 'ride_driver_rejections', 'reason_code'],
  ['column', 'ride_driver_rejections', 'reason_text'],
  ['table', 'rides', null],
  ['column', 'rides', 'status'],
  ['column', 'rides', 'cancellation_reason_code'],
  ['column', 'rides', 'cancellation_reason_text'],
  ['column', 'rides', 'cancelled_by'],
  ['column', 'rides', 'cancelled_at'],
  ['column', 'rides', 'driver_id'],
  ['table', 'vehicle_models', null],
  ['table', 'ride_price_snapshots', null],
  ['table', 'promo_codes', null],
  ['table', 'rider_wallets', null],
  ['table', 'wallet_transactions', null],
  ['table', 'special_redemptions', null],
  ['table', 'sponsor_ledger_entries', null],
  ['table', 'financial_transactions', null],
  ['table', 'regions', null],
  ['column', 'verification_codes', 'email'],
  ['index', 'idx_ratings_flagged', null],
  ['index', 'idx_verification_codes_email', null],
  ['index', 'idx_rides_status', null],
  ['index', 'financial_transactions_ride_uniq', null],
  ['enum', 'user_role', 'ADMIN'],
  ['enum', 'user_role', 'DRIVER'],
  ['enum', 'user_role', 'RIDER'],
  ['enum', 'user_role', 'SPONSOR'],
  ['enum', 'verification_status', 'BLOCKED'],
  ['enum', 'payout_method', 'TIP_CREDIT'],
  ['enum', 'payout_method', 'SPONSOR_CREDIT'],
];

(async () => {
  const c = new Client({ connectionString: process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL });
  c.on('error', (e) => console.error('pg client error:', e.message));
  await c.connect();
  let pass = 0, fail = 0;
  for (const [kind, name, extra] of probes) {
    try {
      let q, label;
      if (kind === 'table') {
        q = `SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename=$1`;
        label = `table:${name}`;
      } else if (kind === 'column') {
        q = `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2`;
        label = `column:${name}.${extra}`;
      } else if (kind === 'index') {
        q = `SELECT 1 FROM pg_indexes WHERE indexname=$1`;
        label = `index:${name}`;
      } else if (kind === 'enum') {
        q = `SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname=$1 AND e.enumlabel=$2`;
        label = `enum:${name}.${extra}`;
      }
      const r = await c.query(q, kind === 'table' || kind === 'index' ? [name] : [name, extra]);
      if (r.rowCount > 0) pass++;
      else { fail++; console.log(`❌ ${label}`); }
    } catch (e) {
      fail++;
      console.log(`❌ ${kind}:${name}${extra ? '.' + extra : ''} (error: ${e.message})`);
    }
  }
  console.log(`\nSMOKE: ${pass} ok, ${fail} missing`);
  await c.end();
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
