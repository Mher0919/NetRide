// backend/apply-migration-20260818.cjs
// Applies migrations/20260818_add_ride_driver_interaction_types.sql to the
// DIRECT_DATABASE_URL (session pooler — DDL-safe; the pgbouncer?=true URL is
// transaction-mode only and rejects multi-statement DDL).
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const { Client } = require('pg');

const DIRECT_URL =
  process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;

async function main() {
  const client = new Client({ connectionString: DIRECT_URL });
  await client.connect();
  console.log('Connected via', DIRECT_URL.replace(/\/\/[^@]*@/, '//***@'));
  const sqlPath = path.join(__dirname, 'migrations', '20260818_add_ride_driver_interaction_types.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');
  await client.query(sql);
  console.log('Migration applied: interaction_type / reason_code / reason_text on ride_driver_rejections');
  const res = await client.query(`
    SELECT column_name, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_name = 'ride_driver_rejections'
     ORDER BY ordinal_position`);
  console.table(res.rows.map(r => ({
    column: r.column_name,
    nullable: r.is_nullable,
    default: r.column_default,
  })));
  const chk = await client.query(`
    SELECT conname, pg_get_constraintdef(oid) AS def
      FROM pg_constraint
     WHERE conrelid = 'ride_driver_rejections'::regclass
     ORDER BY conname`);
  console.log('Constraints:');
  chk.rows.forEach(r => console.log(`  ${r.conname}: ${r.def}`));
  await client.end();
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
