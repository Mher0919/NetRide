// tests/fixtures/seed-test-driver2.cjs — idempotent second test driver
// (driver2@NetRide.dev / password123) so e2e cancellation scenarios can
// exercise two-driver flows (reject → other driver; accept-cancel → other
// driver).
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
require('../../backend/node_modules/dotenv').config({ path: require('path').resolve(__dirname, '../../backend/.env') });
require('../helpers/test-env-guard.cjs');
const bcrypt = require('../../backend/node_modules/bcryptjs');
const { Client } = require('../../backend/node_modules/pg');

async function main() {
  const client = new Client({ connectionString: process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL });
  await client.connect();
  const hash = await bcrypt.hash('password123', 4);
  // Select-then-insert instead of ON CONFLICT (email): some deployed schemas
  // lack the unique constraint the upsert relied on, which aborted the whole
  // fixture before the (idempotent) driver-profile step below.
  const existingUser = await client.query(
    `SELECT id, email FROM users WHERE lower(email) = lower($1)`,
    ['driver2@NetRide.dev'],
  );
  let driver2Id;
  if (existingUser.rows.length > 0) {
    driver2Id = existingUser.rows[0].id;
    await client.query(
      `UPDATE users SET password_hash = $2, is_active = TRUE, updated_at = NOW() WHERE id = $1`,
      [driver2Id, hash],
    );
  } else {
    const res = await client.query(
      `INSERT INTO users (email, full_name, password_hash, role, is_verified, verification_status, is_active, rating, rating_count)
       VALUES ($1, $2, $3, 'DRIVER', TRUE, 'VERIFIED', TRUE, 5.0, 0)
       RETURNING id`,
      ['driver2@NetRide.dev', 'Test Driver B', hash],
    );
    driver2Id = res.rows[0].id;
  }
  // Existence check instead of ON CONFLICT: some deployed schemas lost the
  // unique index on drivers.user_id, which made the upsert fail even though
  // the fixture row itself was always fine.
  const existing = await client.query(`SELECT 1 FROM drivers WHERE user_id = $1`, [driver2Id]);
  if (existing.rows.length === 0) {
    await client.query(
      `INSERT INTO drivers (user_id, license_number) VALUES ($1, $2)`,
      [driver2Id, 'LIC654321'],
    );
  }
  console.log('driver2@NetRide.dev ready, id =', driver2Id);
  await client.end();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
