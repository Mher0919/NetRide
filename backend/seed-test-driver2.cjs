// backend/seed-test-driver2.cjs — idempotent second test driver
// (driver2@NetRide.dev / password123) so e2e cancellation scenarios can
// exercise two-driver flows (reject → other driver; accept-cancel → other
// driver).
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { Client } = require('pg');

async function main() {
  const client = new Client({ connectionString: process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL });
  await client.connect();
  const hash = await bcrypt.hash('password123', 4);
  const res = await client.query(
    `INSERT INTO users (email, full_name, password_hash, role, is_verified, verification_status, is_active, rating, rating_count)
     VALUES ($1, $2, $3, 'DRIVER', TRUE, 'VERIFIED', TRUE, 5.0, 0)
     ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name
     RETURNING id, email`,
    ['driver2@NetRide.dev', 'Test Driver B', hash],
  );
  const driver2Id = res.rows[0].id;
  await client.query(
    `INSERT INTO drivers (user_id, license_number)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO NOTHING`,
    [driver2Id, 'LIC654321'],
  );
  console.log('driver2@NetRide.dev ready, id =', driver2Id);
  await client.end();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
