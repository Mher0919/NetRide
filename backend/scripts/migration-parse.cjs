// backend/scripts/migration-parse.cjs
// Print every CREATE / ALTER artefact per migration file as a structured
// table so an author or reviewer can see exactly what a migration touches.
// SQL comments are stripped to avoid catching `-- for faster lookup`-style
// keyword noise. Pure parser — no DB connection.
//
// Usage:
//   node scripts/migration-parse.cjs                # parse every file
//   node scripts/migration-parse.cjs <filename.sql> # parse one

const fs = require('fs');
const path = require('path');

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

function parseArtefacts(sql) {
  const out = { tables: [], indexes: [], columns: [], enumsAdd: [], enumsCreate: [] };
  for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["]?([\w."]+)["]?/gi)) {
    out.tables.push(m[1].replace(/["]/g, ''));
  }
  for (const m of sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?["]?([\w_]+)["]?\s+ON\s+([\w.]+)/gi)) {
    out.indexes.push({ name: m[1], on: m[2].replace(/["]/g, '') });
  }
  for (const m of sql.matchAll(/ALTER\s+TABLE\s+["]?([\w."]+)["]?\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?["]?([\w]+)["]?/gi)) {
    out.columns.push({ table: m[1].replace(/["]/g, '').split('.').pop(), column: m[2] });
  }
  for (const m of sql.matchAll(/ALTER\s+TYPE\s+["]?([\w."]+)["]?\s+ADD\s+VALUE\s+(?:IF\s+NOT\s+EXISTS\s+)?\x27([\w_]+)\x27/gi)) {
    out.enumsAdd.push({ type: m[1].replace(/["]/g, '').split('.').pop(), value: m[2] });
  }
  for (const m of sql.matchAll(/CREATE\s+TYPE\s+["]?([\w."]+)["]?\s+AS\s+ENUM\s*\(([^)]+)\)/gi)) {
    const t = m[1].replace(/["]/g, '').split('.').pop();
    const vals = Array.from(m[2].matchAll(/\x27([\w_]+)\x27/g)).map((x) => x[1]);
    out.enumsCreate.push({ type: t, values: vals });
  }
  return out;
}

function fmt(file, a) {
  console.log(`\n── ${file} ──`);
  if (a.tables.length)      console.table(a.tables.map((t) => ({ kind: 'table',   name: t })));
  if (a.indexes.length)     console.table(a.indexes.map((i) => ({ kind: 'index',   name: i.name, on: i.on })));
  if (a.columns.length)     console.table(a.columns.map((c) => ({ kind: 'column',  table: c.table, column: c.column })));
  if (a.enumsAdd.length)    console.table(a.enumsAdd.map((e) => ({ kind: 'enum+',    type: e.type, value: e.value })));
  if (a.enumsCreate.length) console.table(a.enumsCreate.map((e) => ({ kind: 'enum', type: e.type, values: e.values.join(',') })));
}

const target = process.argv[2];
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
for (const f of target ? [target] : files) {
  if (!files.includes(f)) { console.log(`[missing] ${f}`); continue; }
  const sql = stripComments(fs.readFileSync(path.join(DIR, f), 'utf8'));
  fmt(f, parseArtefacts(sql));
}
