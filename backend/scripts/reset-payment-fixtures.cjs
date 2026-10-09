// backend/scripts/reset-payment-fixtures.cjs
//
// Deletes every fixture created by seed-payment-fixtures.cjs (and any other
// @netride.test account needing cleanup) including their financial records,
// so each test run can start from a known state. Dev/test only.

const envGuard = () => {
  require('dotenv').config();
  if (process.env.NODE_ENV === 'production') {
    console.error('❌ Refusing to reset fixtures in production');
    process.exit(1);
  }
};
envGuard();
const { Client } = require('pg');

(async () => {
  const client = new Client({ connectionString: process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL });
  await client.connect();

  const users = await client.query(
    `SELECT id FROM users WHERE email ILIKE '%@netride.test' OR email ILIKE '%payment-rider%' OR email ILIKE '%payment-driver%'`,
  );
  const ids = users.rows.map((r) => r.id);
  console.log(`found ${ids.length} test users`);

  if (ids.length > 0) {
    await client.query(`DELETE FROM stripe_payments WHERE user_id = ANY($1::uuid[])`, [ids]);
    await client.query(`DELETE FROM stripe_customers WHERE user_id = ANY($1::uuid[])`, [ids]);
    await client.query(`DELETE FROM wallet_transactions WHERE user_id = ANY($1::uuid[])`, [ids]);
    await client.query(`DELETE FROM rider_wallets WHERE user_id = ANY($1::uuid[])`, [ids]);
    await client.query(`DELETE FROM driver_wallets WHERE driver_id = ANY($1::uuid[])`, [ids]);
    await client.query(
      `DELETE FROM special_redemptions WHERE rider_id = ANY($1::uuid[])
        OR driver_id = ANY($1::uuid[])
        OR sponsor_id IN (SELECT id FROM sponsors WHERE business_name = 'Payment Test Coffee')`,
      [ids],
    );
    await client.query(`DELETE FROM payouts WHERE driver_id = ANY($1::uuid[])`, [ids]);
    await client.query(`DELETE FROM financial_transactions WHERE rider_id = ANY($1::uuid[]) OR driver_id = ANY($1::uuid[])`, [ids]);
    await client.query(`DELETE FROM ride_fare_breakdowns WHERE ride_id IN (SELECT id FROM rides WHERE rider_id = ANY($1::uuid[]) OR driver_id = ANY($1::uuid[]))`, [ids]);
    await client.query(`DELETE FROM rides WHERE rider_id = ANY($1::uuid[]) OR driver_id = ANY($1::uuid[])`, [ids]);
    await client.query(`DELETE FROM drivers WHERE user_id = ANY($1::uuid[])`, [ids]);
    await client.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [ids]);
  }

  await client.query(`DELETE FROM stripe_payments WHERE sponsor_id IN (SELECT id FROM sponsors WHERE business_name = 'Payment Test Coffee')`);
  await client.query(`DELETE FROM sponsor_ledger_entries WHERE sponsor_id IN (SELECT id FROM sponsors WHERE business_name = 'Payment Test Coffee')`);
  await client.query(`DELETE FROM sponsors WHERE business_name = 'Payment Test Coffee'`);

  console.log('✓ payment fixtures reset');
  await client.end();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });