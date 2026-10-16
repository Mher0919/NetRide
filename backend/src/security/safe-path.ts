// backend/src/security/safe-path.ts
//
// Filesystem path guards for scripts that accept filenames. The migration
// runner takes a filename from the command line; without validation it would
// happily read `../../etc/passwd` and try to apply it as SQL (path traversal
// / arbitrary file read). Keep the resolved path inside the permitted
// directory and require a plain, well-formed basename.

import * as path from 'path';

const SAFE_MIGRATION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.sql$/;
const MAX_NAME_LENGTH = 200;

export function isSafeMigrationFilename(name: unknown): name is string {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (name.length > MAX_NAME_LENGTH) return false;
  if (name.includes('\0')) return false;
  // Rejects `..`, `.`, `a/b.sql`, `a\b.sql`, absolute paths and every
  // encoded variant (`%2e%2e%2f` fails the character class anyway).
  if (path.basename(name) !== name) return false;
  return SAFE_MIGRATION_NAME.test(name);
}

/** Returns the absolute path, or null when the name is unsafe/escapes. */
export function resolveMigrationFilename(dir: string, name: unknown): string | null {
  if (!isSafeMigrationFilename(name)) return null;
  const root = path.resolve(dir);
  const resolved = path.resolve(root, name);
  if (path.dirname(resolved) !== root) return null;
  return resolved;
}
