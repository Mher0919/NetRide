// tests/fixtures/seed-specials-e2e-sponsor.cjs
//
// SAFE TEST ENVIRONMENT FIXTURE (dev only)
// ---------------------------------------------------------------------------
// Creates the DETERMINISTIC sponsor fixture required by
// tests/e2e/specials/e2e-specials.cjs, which mints a sponsor JWT against
// hard-coded UUIDs:
//   * user    58c00a35-d098-4633-95d4-90666f5b670d (role SPONSOR)
//   * sponsor 5b6d32d1-90bf-40d1-a4a8-9c0f6afd1f29 ($5 FIXED_AMOUNT, funded)
//
// The sponsor carries the persistent `is_test = TRUE` fixture marker (and
// business_type 'TEST'), so the admin dashboard + rider-facing lists hide it
// by default while the e2e can still address it by id.
//
// Safety gates:
//   * refuses to run when NODE_ENV=production
//   * idempotent — re-running restores ACTIVE status, $5 discount and a
//     full (unreserved) budget without duplicating ledger entries
//   * clears only the e2e rider's own open/expired special state so the
//     "one pending card" assertion is deterministic
//
// Run:  node tests/fixtures/seed-specials-e2e-sponsor.cjs

require('../../backend/node_modules/dotenv').config({ path: require('path').resolve(__dirname, '../../backend/.env') });
process.env.NODE_ENV = process.env.NODE_ENV || 'development';
if (process.env.NODE_ENV === 'production') {
  console.error('❌ Refusing to seed test fixtures in production');
  process.exit(1);
}
const bcrypt = require('../../backend/node_modules/bcryptjs');
const { Client } = require('../../backend/node_modules/pg');

const SPONSOR_USER_ID = '58c00a35-d098-4633-95d4-90666f5b670d';
const SPONSOR_ID = '5b6d32d1-90bf-40d1-a4a8-9c0f6afd1f29';
const SPONSOR_EMAIL = 'mhermkrtumyan3@gmail.com';
const E2E_RIDER_EMAIL = 'rider@netride.dev';
const INITIAL_BUDGET_CENTS = 1_000_000; // $10,000 test budget
const DISCOUNT_CENTS = 500; // $5.00 fixed

async function main() {
  const client = new Client({ connectionString: process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL });
  await client.connect();

  const emailOwner = await client.query(`SELECT id FROM users WHERE lower(email) = lower($1)`, [SPONSOR_EMAIL]);
  if (emailOwner.rows.length > 0 && emailOwner.rows[0].id !== SPONSOR_USER_ID) {
    throw new Error(
      `Email ${SPONSOR_EMAIL} is already owned by user ${emailOwner.rows[0].id}; ` +
        `the e2e fixture requires ${SPONSOR_USER_ID}. Resolve manually in this dev database.`,
    );
  }

  // --- Sponsor portal identity ----------------------------------------------
  const hash = await bcrypt.hash('password123', 4);
  await client.query(
    `INSERT INTO users (id, email, full_name, password_hash, role, is_verified, verification_status,
                        is_active, rating, rating_count, password_changed_at)
     VALUES ($1, $2, 'Specials E2E Sponsor', $3, 'SPONSOR', TRUE, 'VERIFIED', TRUE, 5.0, 0, NOW())
     ON CONFLICT (id) DO UPDATE SET
       email = EXCLUDED.email,
       role = 'SPONSOR',
       is_active = TRUE,
       password_changed_at = NOW()`,
    [SPONSOR_USER_ID, SPONSOR_EMAIL, hash],
  );

  // --- Sponsor + funded budget ----------------------------------------------
  await client.query(
    `INSERT INTO sponsors (
       id, business_name, business_type, business_description, address, city, state,
       latitude, longitude, discount_type, discount_percent, max_discount_percent,
       discount_fixed_amount_cents, initial_budget_cents, remaining_budget_cents,
       reserved_budget_cents, used_budget_cents, status, specials_enabled,
       map_listing_enabled, is_test
     ) VALUES (
       $1, 'Specials E2E Test Cafe', 'TEST', 'Deterministic e2e fixture — hidden from real riders.',
       '100 Test Fixture Ave', 'Los Angeles', 'CA', 34.0195, -118.4912,
       'FIXED_AMOUNT', NULL, 90, $2, $3, $3, 0, 0, 'ACTIVE', TRUE, TRUE, TRUE
     )
     ON CONFLICT (id) DO UPDATE SET
       business_name = EXCLUDED.business_name,
       business_type = EXCLUDED.business_type,
       address = EXCLUDED.address,
       latitude = EXCLUDED.latitude,
       longitude = EXCLUDED.longitude,
       discount_type = 'FIXED_AMOUNT',
       discount_percent = NULL,
       discount_fixed_amount_cents = $2,
       initial_budget_cents = $3,
       remaining_budget_cents = $3,
       reserved_budget_cents = 0,
       used_budget_cents = 0,
       status = 'ACTIVE',
       specials_enabled = TRUE,
       map_listing_enabled = TRUE,
       is_test = TRUE,
       updated_at = NOW()`,
    [SPONSOR_ID, DISCOUNT_CENTS, INITIAL_BUDGET_CENTS],
  );

  await client.query(
    `INSERT INTO sponsor_ledger_entries (sponsor_id, type, amount_cents, direction, reference_type, reason, balance_after_cents, idempotency_key)
     VALUES ($1, 'INITIAL_FUNDING', $2, 'CREDIT', 'sponsor_create', 'Specials e2e fixture funding (booked budget)', $2, 'fixture:specials-e2e:initial-funding')
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [SPONSOR_ID, INITIAL_BUDGET_CENTS],
  );

  // --- Portal account link (sponsorMiddleware resolves via this row) --------
  await client.query(
    `INSERT INTO sponsor_portal_accounts (sponsor_id, user_id, is_active, must_change_password)
     VALUES ($1, $2, TRUE, FALSE)
     ON CONFLICT (sponsor_id) DO UPDATE SET
       user_id = EXCLUDED.user_id,
       is_active = TRUE,
       must_change_password = FALSE,
       updated_at = NOW()`,
    [SPONSOR_ID, SPONSOR_USER_ID],
  );

  // --- Deterministic rider special state ------------------------------------
  // The e2e asserts exactly ONE pending validation card for the seeded rider.
  const rider = await client.query(`SELECT id FROM users WHERE lower(email) = lower($1)`, [E2E_RIDER_EMAIL]);
  if (rider.rows.length > 0) {
    const riderId = rider.rows[0].id;
    await client.query(
      `UPDATE special_redemptions
       SET status = 'CANCELLED', cancelled_at = NOW(),
           cancellation_reason_code = 'TEST_RESET',
           cancellation_reason_text = 'specials e2e fixture reset',
           updated_at = NOW()
       WHERE rider_id = $1 AND status IN ('CREATED', 'RIDE_PENDING')`,
      [riderId],
    );
    await client.query(
      `UPDATE special_redemptions
       SET status = 'EXPIRED', updated_at = NOW()
       WHERE rider_id = $1 AND status = 'WAITING_FOR_SPONSOR'`,
      [riderId],
    );
  } else {
    console.warn(`⚠️  Rider ${E2E_RIDER_EMAIL} not found — run the standard dev seeds first.`);
  }

  console.log('──────────────────────────────────────────────');
  console.log('✓ Seeded specials e2e sponsor fixture (idempotent)');
  console.log(`  sponsor user : ${SPONSOR_EMAIL} (id=${SPONSOR_USER_ID})`);
  console.log(`  sponsor      : Specials E2E Test Cafe (id=${SPONSOR_ID})`);
  console.log(`  discount     : $${(DISCOUNT_CENTS / 100).toFixed(2)} fixed · budget $${(INITIAL_BUDGET_CENTS / 100).toFixed(2)}`);
  console.log('  e2e          : npm run e2e:specials (backend must be running)');
  console.log('──────────────────────────────────────────────');
  await client.end();
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
