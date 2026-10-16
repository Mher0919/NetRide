// backend/scripts/lib/migration-file.cjs
//
// Shared filename guard for the migration tooling. Migration names arrive
// from the command line (`node scripts/run-migrations.cjs 001_x.sql`) or
// from a directory listing; before either is joined into a path it must be a
// plain basename — no separators, no `..`, no absolute paths, no null bytes,
// no URL-encoded traversal — and the final resolved path must stay inside
// the migrations directory.

const path = require('path');

const SAFE_MIGRATION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.sql$/;
const MAX_NAME_LENGTH = 200;

function isSafeMigrationFile(name) {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (name.length > MAX_NAME_LENGTH) return false;
  if (name.includes('\0')) return false;
  // Rejects `..`, `.`, `a/b.sql`, `a\\b.sql`, absolute paths and every
  // encoded variant (`%2e%2e%2f` fails the character class anyway).
  if (path.basename(name) !== name) return false;
  return SAFE_MIGRATION_NAME.test(name);
}

/** Returns the absolute path, or null when the name is unsafe/escapes. */
function resolveMigrationFile(dir, name) {
  if (!isSafeMigrationFile(name)) return null;
  const root = path.resolve(dir);
  const resolved = path.resolve(root, name);
  // Defense in depth: even if the pattern ever loosens, the file must land
  // directly inside the migrations directory.
  if (path.dirname(resolved) !== root) return null;
  return resolved;
}

module.exports = { isSafeMigrationFile, resolveMigrationFile };
