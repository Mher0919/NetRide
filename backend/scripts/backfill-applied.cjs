// backend/scripts/backfill-applied.cjs
// For migrations that have EFFECTIVELY been applied previously (artefacts
// already in the live DB) but were never registered in migrations_applied.
// Reads the migration file's declared targets and probes the live DB; if
// every declared target is present, inserts the file name into
// migrations_applied. If any target is missing, the file is left for
// `npm run migrate` to actually run.
//
// Usage:
//   node scripts/backfill-applied.cjs                # scan all
//   node scripts/backfill-applied.cjs <filename.sql> # scan one

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const url = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
const DIR = path.resolve(__dirname, '..', 'migrations');

function stripComments(src) {
  let out = '';
  const i2 = (i) => src.slice(i, i + 2);
  let i = 0, inBlock = false;
  while (i < src.length) {
    const t = i2(i);
    if (inBlock) {
      if (t === '*/') { inBlock = false; i += 2; continue; }
      i++; continue;
    }
    if (t === '--') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (t === '/*') { inBlock = true; i += 2; continue; }
    out += src[i++];
  }
  return out;
}

async function probe(url, f) {
  const c = new Client({ connectionString: url });
  await c.connect();
  const sql = stripComments(fs.readFileSync(path.join(DIR, f), 'utf8'));

  // Built once per probe to keep the work bounded.
  const colCache = new Map();
  async function hasColumn(t, col) {
    if (!colCache.has(t)) {
      const r = await c.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
        [t],
      );
      colCache.set(t, new Set(r.rows.map((x) => x.column_name)));
    }
    return colCache.get(t).has(col);
  }
  async function hasIndex(i) {
    const r = await c.query('SELECT 1 FROM pg_indexes WHERE indexname=$1', [i]);
    return r.rowCount > 0;
  }
  async function hasEnumLabel(t, v) {
    const r = await c.query(
      `SELECT 1 FROM pg_enum e
        JOIN pg_type ty ON ty.oid = e.enumtypid
        WHERE ty.typname = $1 AND e.enumlabel = $2`,
      [t, v],
    );
    return r.rowCount > 0;
  }
  async function hasEnumType(t) {
    const r = await c.query('SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname=\'public\' AND t.typname=$1', [t]);
    return r.rowCount > 0;
  }
  async function hasTable(t) {
    const r = await c.query('SELECT 1 FROM pg_tables WHERE schemaname=\'public\' AND tablename=$1', [t]);
    return r.rowCount > 0;
  }

  const missing = [];
  const STOP = new Set([
    'IF', 'EXISTS', 'NOT', 'CONCURRENTLY', 'TRIGGER', 'for',
    'as', 'in', 'on', 'at', 'and', 'to', 'is', 'of', 'no', 'by',
  ]);
  const cleanToken = (s) => {
    s = s.replace(/["]/g, '').split('.').pop();
    if (!s || !/[a-z_]/i.test(s) || STOP.has(s.toUpperCase())) return null;
    return s;
  };

  // CREATE TABLE / COLUMN / INDEX / TYPE / ADD VALUE
  for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["]?([\w."]+)["]?/gi)) {
    const t = cleanToken(m[1]); if (!t) continue;
    if (!(await hasTable(t))) missing.push(`table:${t}`);
  }
  for (const m of sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?["]?([\w_]+)["]?/gi)) {
    const i = cleanToken(m[1]); if (!i) continue;
    if (!(await hasIndex(i))) missing.push(`index:${i}`);
  }
  for (const m of sql.matchAll(/ALTER\s+TABLE\s+["]?([\w."]+)["]?\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?["]?([\w]+)["]?/gi)) {
    const t = cleanToken(m[1]); const col = cleanToken(m[2]);
    if (!t || !col) continue;
    if (!(await hasColumn(t, col))) missing.push(`column:${t}.${col}`);
  }
  for (const m of sql.matchAll(/ALTER\s+TYPE\s+["]?([\w."]+)["]?\s+ADD\s+VALUE\s+(?:IF\s+NOT\s+EXISTS\s+)?\x27([\w_]+)\x27/gi)) {
    const t = cleanToken(m[1]); const v = cleanToken(m[2]);
    if (!t || !v) continue;
    if (!(await hasEnumLabel(t, v))) missing.push(`enum:add:${t}.${v}`);
  }
  for (const m of sql.matchAll(/CREATE\s+TYPE\s+["]?([\w."]+)["]?\s+AS\s+ENUM\s*\(([^)]+)\)/gi)) {
    const t = cleanToken(m[1]); if (!t) continue;
    const vals = Array.from(m[2].matchAll(/\x27([\w_]+)\x27/g)).map((x) => cleanToken(x[1])).filter(Boolean);
    if (!(await hasEnumType(t))) { missing.push(`type:${t}`); continue; }
    for (const v of vals) {
      if (!(await hasEnumLabel(t, v))) missing.push(`enum:create:${t}(${v})`);
    }
  }

  await c.end();
  return missing;
}

(async () => {
  const target = process.argv[2];
  const c = new Client({ connectionString: url });
  await c.connect();
  const applied = new Set(
    (await c.query('SELECT filename FROM migrations_applied')).rows.map((r) => r.filename),
  );
  await c.end();

  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
  const todo = target ? [target] : files;

  let backfilled = 0;
  let eligible = 0;
  let skipped = 0;
  for (const f of todo) {
    if (applied.has(f)) { skipped++; continue; }
    const missing = await probe(url, f);
    eligible++;
    if (missing.length === 0) {
      const c2 = new Client({ connectionString: url });
      await c2.connect();
      await c2.query(
        `INSERT INTO migrations_applied (filename, notes) VALUES ($1, $2)
         ON CONFLICT (filename) DO NOTHING`,
        [f, 'backfill: all declared artefacts already in DB'],
      );
      await c2.end();
      backfilled++;
      console.log(`[backfill] ${f} ✓`);
    } else {
      console.log(`[skip] ${f} — still needs apply: ${missing.slice(0, 4).join(', ')}`);
    }
  }

  console.log(`\nSUMMARY: total=${todo.length} skipped_existing=${skipped} eligible=${eligible} backfilled=${backfilled}`);
})().catch(e => { console.error('failed:', e.message); process.exit(1); });
