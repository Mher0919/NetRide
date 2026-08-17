// backend/scripts/run-migrations.cjs
// Idempotent migration runner that tracks every applied migration in
// `migrations_applied`. Usage:
//   node scripts/run-migrations.cjs                      # run everything missing
//   node scripts/run-migrations.cjs <filename.sql>        # run a specific file
//
// Connects via DIRECT_DATABASE_URL (session-mode) so multi-statement DDL
// keeps working — pgbouncer transaction mode rejects `CREATE INDEX
// CONCURRENTLY` and sometimes DDL.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const url = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
const DIR = path.resolve(__dirname, '..', 'migrations');

(async () => {
  const c = new Client({ connectionString: url });
  await c.connect();

  await c.query(`
    CREATE TABLE IF NOT EXISTS migrations_applied (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      notes TEXT
    );
  `);

  const applied = new Set(
    (await c.query(`SELECT filename FROM migrations_applied`)).rows.map((r) => r.filename),
  );

  const all = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
  const argv = process.argv.slice(2);
  const target = argv[0];
  const todo = target ? [target] : all;

  let ran = 0;
  let skipped = 0;
  let failed = 0;

  for (const f of todo) {
    if (!all.includes(f)) {
      console.log(`[skip] ${f} not in migrations/`);
      continue;
    }
    if (applied.has(f)) {
      skipped++;
      continue;
    }
    const sql = fs.readFileSync(path.join(DIR, f), 'utf8');
    console.log(`[apply] ${f} (${sql.length} bytes)`);
    try {
      await c.query('BEGIN');
      await c.query(sql);
      await c.query(
        `INSERT INTO migrations_applied (filename) VALUES ($1)
         ON CONFLICT (filename) DO NOTHING`,
        [f],
      );
      await c.query('COMMIT');
      ran++;
      console.log(`[apply] ${f} ✓`);
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      failed++;
      console.log(`[apply] ${f} ❌ ${e.message.split('\n')[0]}`);
    }
  }

  console.log(`\nSUMMARY: ran=${ran} skipped=${skipped} failed=${failed}`);
  await c.end();
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
