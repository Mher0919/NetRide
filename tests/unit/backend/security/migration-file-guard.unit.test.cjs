// tests/unit/backend/security/migration-file-guard.unit.test.cjs
//
// Regression suite for the shared migration filename guard. The migration
// scripts accept a filename from argv; without this guard
// `node scripts/backfill-applied.cjs ../../etc/passwd` style traversal would
// read arbitrary files (finding C, backfill-applied.cjs).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  isSafeMigrationFile,
  resolveMigrationFile,
} = require('../../../../backend/scripts/lib/migration-file.cjs');

const DIR = path.resolve(__dirname, '../../../../backend/migrations');

test('migration guard: normal migration names pass and stay inside migrations/', () => {
  for (const name of ['001_initial_schema.sql', '123e.sql', 'abc-def_1.2.sql']) {
    assert.equal(isSafeMigrationFile(name), true, name);
    const resolved = resolveMigrationFile(DIR, name);
    assert.equal(path.dirname(resolved), DIR, name);
  }
});

test('migration guard: traversal, absolute and encoded names are rejected', () => {
  for (const bad of [
    '../secrets.sql',
    '..\\secrets.sql',
    'a/../b.sql',
    'sub/dir/x.sql',
    '..',
    '.',
    '/etc/passwd',
    'C:\\Windows\\x.sql',
    '%2e%2e%2fsecrets.sql',
    'x.sql\0.png',
    'x.txt',
    '.hidden.sql',
    '',
    null,
    42,
    'x'.repeat(500) + '.sql',
  ]) {
    assert.equal(isSafeMigrationFile(bad), false, `isSafe(${String(bad)})`);
    assert.equal(resolveMigrationFile(DIR, bad), null, `resolve(${String(bad)})`);
  }
});

test('migration guard: every real migration file in the repo passes', () => {
  const fs = require('node:fs');
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql'));
  assert.ok(files.length > 0, 'expected migration files in backend/migrations');
  for (const f of files) {
    assert.equal(isSafeMigrationFile(f), true, f);
  }
});
