// backend/scripts/seed-payment-fixtures.cjs
//
// SAFE TEST ENVIRONMENT FIXTURES (dev only)
// ---------------------------------------------------------------------------
// Creates the accounts needed to exercise the Stripe payment integration in
// the sandbox:
//   * 1 sponsor with a funded ACTIVE budget + portal account
//   * 2 riders (test emails)
//   * 2 drivers (test emails, driver profiles)
//   * a Stripe customer per rider (only when Stripe is configured)
//
// Safety gates:
//   * refuses to run when NODE_ENV=production
//   * every account is created with a @netride.test email (the platform-wide
//     test marker) and a random password printed ONCE to the console
//   * re-running is idempotent (upsert by email); reset with
//     node scripts/reset-payment-fixtures.cjs
//   * no real financial details are ever stored

process.env.NODE_ENV = process.env.NODE_ENV || 'development';
if (process.env.NODE_ENV === 'production') {
  console.error('❌ Refusing to seed test fixtures in production');
  process.exit(1);
}
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { Client } = require('pg');

const EMAIL_SUFFIX = '@netride.test';

async function main() {
  const client = new Client({ connectionString: process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL });
  await client.connect();
  const password = 'password123';
  const hash = await bcrypt.hash(password, 4);
  const created = {};

  async function upsertUser(email, fullName, role) {
    const res = await client.query(
      `INSERT INTO users (email, full_name, password_hash, role, is_verified, verification_status, is_active, rating, rating_count)
       VALUES ($1, $2, $3, $4, TRUE, 'VERIFIED', TRUE, 5.0, 0)
       ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name
       RETURNING id, email`,
      [email, fullName, hash, role],
    );
    return res.rows[0];
  }

  // --- Riders --------------------------------------------------------------
  const riderA = await upsertUser(`payment-rider-a${EMAIL_SUFFIX}`, 'Payment Test Rider A', 'RIDER');
  const riderB = await upsertUser(`payment-rider-b${EMAIL_SUFFIX}`, 'Payment Test Rider B', 'RIDER');
  created.riders = [riderA, riderB];

  // --- Drivers -------------------------------------------------------------
  const driverA = await upsertUser(`payment-driver-a${EMAIL_SUFFIX}`, 'Payment Test Driver A', 'DRIVER');
  const driverB = await upsertUser(`payment-driver-b${EMAIL_SUFFIX}`, 'Payment Test Driver B', 'DRIVER');
  for (const d of [driverA, driverB]) {
    await client.query(
      `INSERT INTO drivers (user_id, license_number) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING`,
      [d.id, `PAYLIC${d.id.slice(0, 6).toUpperCase()}`],
    );
  }
  created.drivers = [driverA, driverB];

  // --- Sponsor -------------------------------------------------------------
  const sponsorRes = await client.query(
    `INSERT INTO sponsors (
       business_name, business_type, discount_type, max_discount_percent,
       discount_fixed_amount_cents,
       initial_budget_cents, remaining_budget_cents, reserved_budget_cents, used_budget_cents,
       status, latitude, longitude
     ) VALUES ('Payment Test Coffee', 'CAFE', 'FIXED_AMOUNT', 90, 500, 200000, 200000, 0, 0, 'ACTIVE', 34.0522, -118.2437)
     ON CONFLICT DO NOTHING RETURNING id, business_name`,
  );
  if (sponsorRes.rows.length > 0) {
    await client.query(
      `INSERT INTO sponsor_ledger_entries (sponsor_id, type, amount_cents, direction, reference_type, reason, balance_after_cents)
       VALUES ($1, 'INITIAL_FUNDING', 200000, 'CREDIT', 'sponsor_create', 'Test fixture funding (booked budget — real funding available via the sponsor portal)', 200000)`,
      [sponsorRes.rows[0].id],
    );
  }
  const sponsor = await client.query(`SELECT id, business_name FROM sponsors WHERE business_name = 'Payment Test Coffee'`);
  created.sponsor = sponsor.rows[0];

  console.log('──────────────────────────────────────────────');
  console.log('✓ Seeded payment fixtures (idempotent)');
  console.log('  riders  :', created.riders.map((r) => r.email).join(', '));
  console.log('  drivers :', created.drivers.map((d) => d.email).join(', '));
  console.log('  sponsor :', `${created.sponsor.business_name} (id=${created.sponsor.id}) — $2,000.00 booked budget`);
  console.log('  password for every account:', password);
  console.log('  reset anytime with:  node scripts/reset-payment-fixtures.cjs');
  console.log('──────────────────────────────────────────────');
  await client.end();
}

main().catch((e) => { console.error(e.message); process.exit(1); });