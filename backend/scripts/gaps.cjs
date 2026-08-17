// backend/scripts/gaps.cjs — DEFECTIVE-FREE audit of missing migration artifacts.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const url = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
const DIR = path.resolve(__dirname, '..', 'migrations');

// Strip SQL line comments (single-line -- + multi-line /* */) so audit
// patterns don't match text like "-- for faster lookup".
function stripComments(src) {
  let out = '';
  let i = 0;
  let inBlock = false;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (inBlock) {
      if (two === '*/') { inBlock = false; i += 2; continue; }
      i++;
      continue;
    }
    if (two === '--') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (two === '/*') {
      inBlock = true;
      i += 2;
      continue;
    }
    out += src[i];
    i++;
  }
  return out;
}

// Patterns: we extract the CREATE TABLE name (handling IF NOT EXISTS),
// ALTER TABLE … ADD COLUMN name (handling IF NOT EXISTS),
// CREATE INDEX name (handling IF NOT EXISTS),
// ALTER TYPE … ADD VALUE 'name' (handling IF NOT EXISTS),
// CREATE TYPE name AS ENUM ('v1','v2').
function escape(s) { return s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'); }
function capture(src, pattern) {
  // Match-only artifacts whose names are SQL-reserved tokens used in IF
  // NOT EXISTS / IF EXISTS guards. The regex above captures a candidate
  // whose name is a non-keyword token; tokens like 'EXISTS', 'IF', 'for',
  // 'on' are stripped after the capture so we don't report bogus gaps.
  const STOP = new Set([
    'IF', 'EXISTS', 'NOT', 'CONCURRENTLY', 'TRIGGER', 'for',
    'as', 'in', 'on', 'at', 'and', 'to', 'is', 'of', 'no', 'by',
  ]);
  return Array.from(src.matchAll(pattern))
    .map((m) => (m[2] || m[1]))
    .map((s) => s.replace(/["]/g, '').split('.').pop())
    .filter((n) => n && !STOP.has(n.toUpperCase()) && /[a-z_]/i.test(n));
}

(async () => {
  const c = new Client({ connectionString: url });
  await c.connect();

  const tables = new Map();
  for (const r of (await c.query(`
    SELECT t.tablename, c.relname IS NOT NULL AS present
      FROM pg_tables t
      LEFT JOIN pg_class c ON c.relname = t.tablename
     WHERE t.schemaname='public'
  `)).rows) {
    tables.set(r.tablename, !!r.present);
  }
  const cols = new Map();
  for (const r of (await c.query(`
    SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public'
  `)).rows) {
    if (!cols.has(r.table_name)) cols.set(r.table_name, new Set());
    cols.get(r.table_name).add(r.column_name);
  }
  const idx = new Set(
    (await c.query(`SELECT indexname FROM pg_indexes WHERE schemaname='public'`)).rows.map((r) => r.indexname),
  );
  const enumLabels = new Map();
  for (const r of (await c.query(`
    SELECT t.typname, e.enumlabel
      FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
  `)).rows) {
    if (!enumLabels.has(r.typname)) enumLabels.set(r.typname, new Set());
    enumLabels.get(r.typname).add(r.enumlabel);
  }
  const types = new Set(
    (await c.query(`SELECT typname FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public'`)).rows.map((r) => r.typname),
  );

  const report = [];
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.sql')).sort()) {
    const sql = stripComments(fs.readFileSync(path.join(DIR, f), 'utf8'));
    const issues = [];

    // CREATE TABLE [IF NOT EXISTS] table_name — strip IF NOT EXISTS if present.
    const ctRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["]?([\w."]+)["]?/gi;
    for (const t of capture(sql, ctRe)) {
      if (!tables.has(t)) issues.push(`table:${t}`);
    }

    // CREATE INDEX [IF NOT EXISTS] idx_name
    const ciRe = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?["]?([\w_]+)["]?/gi;
    for (const i of capture(sql, ciRe)) {
      if (!idx.has(i)) issues.push(`index:${i}`);
    }

    // ALTER TABLE tbl ADD COLUMN [IF NOT EXISTS] col
    const acRe = /ALTER\s+TABLE\s+["]?([\w."]+)["]?\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?["]?([\w]+)["]?[,)\s]/gi;
    for (const ac of sql.matchAll(acRe)) {
      const tbl = ac[1].replace(/["]/g, '').split('.').pop();
      const col = ac[2].replace(/["]/g, '');
      if (!(cols.get(tbl) || new Set()).has(col)) issues.push(`column:${tbl}.${col}`);
    }

    // ALTER TYPE typeName ADD VALUE [IF NOT EXISTS] 'value'
    const evtRe = /ALTER\s+TYPE\s+["]?([\w."]+)["]?\s+ADD\s+VALUE\s+(?:IF\s+NOT\s+EXISTS\s+)?'([\w_]+)'/gi;
    for (const ev of sql.matchAll(evtRe)) {
      const t = ev[1].replace(/["]/g, '').split('.').pop();
      const v = ev[2];
      if (!(enumLabels.get(t) || new Set()).has(v)) issues.push(`enum:add:${t}.${v}`);
    }

    // CREATE TYPE typeName AS ENUM ('a','b',…)
    const ct2Re = /CREATE\s+TYPE\s+["]?([\w."]+)["]?\s+AS\s+ENUM\s*\(([^)]+)\)/gi;
    for (const ct of sql.matchAll(ct2Re)) {
      const t = ct[1].replace(/["]/g, '').split('.').pop();
      const vals = Array.from(ct[2].matchAll(/'([\w_]+)'/g)).map((m) => m[1]);
      if (!types.has(t)) {
        issues.push(`type:${t}`);
        continue;
      }
      const present = enumLabels.get(t) || new Set();
      const missing = vals.filter((v) => !present.has(v));
      if (missing.length > 0) issues.push(`enum:create:${t}(${missing.join(',')})`);
    }

    report.push({ file: f, count: issues.length, issues });
  }
  console.log('\nMigrations with confirmed gaps:');
  console.table(report.filter((r) => r.count > 0).map((r) => ({
    file: r.file,
    count: r.count,
    items: r.issues.join(' ; '),
  })));
  console.log(`\nTotal confirmed gaps: ${report.reduce((s, r) => s + r.count, 0)}`);
  await c.end();
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
