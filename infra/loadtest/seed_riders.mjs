// Seed 100 rider accounts directly into the database for load testing.
// Usage: node infra/loadtest/seed_riders.mjs
import pg from 'pg';
import bcrypt from 'bcryptjs';

const pool = new pg.Pool({
  connectionString: 'postgresql://ridehail:secret@localhost:5432/ridehail',
});

const PASSWORD = 'test123456';

async function main() {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const total = 100;
  let created = 0;

  for (let i = 0; i < total; i++) {
    const email = `loadtest.rider.${i}@test.com`;
    try {
      await pool.query(
        `INSERT INTO users (email, full_name, password_hash, role, is_verified, is_active, password_changed_at)
         VALUES ($1, $2, $3, 'RIDER', true, true, NOW())
         ON CONFLICT (email) DO NOTHING`,
        [email, `Load Rider ${i}`, passwordHash]
      );
      created++;
    } catch (err) {
      console.error(`Failed to create ${email}:`, err.message);
    }
    if ((i + 1) % 10 === 0 || i === total - 1) {
      console.log(`[${i + 1}/${total}] ${created} riders created`);
    }
  }

  console.log(`\nDone. ${created} riders created.`);
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
