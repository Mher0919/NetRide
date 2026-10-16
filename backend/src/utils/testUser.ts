// backend/src/utils/testUser.ts
//
// Detection of "test" accounts so E2E/dev seed data can be separated from
// real accounts across the admin dashboard. We use a simple regex so no
// schema change is required.
//
// A user is considered a test user when their email matches one of:
//   - contains a `+test`, `+sandbox`, `+dev` or `+e2e` plus-tag
//   - the local part (or a `-`/`_`/`.` separated segment) is
//     `test`, `sandbox`, `dev` or `e2e` (e.g. `partner-test@…`)
//   - the local part starts with `test`/`sandbox`/`dev`/`e2e`
//   - the domain is a test domain: `netride.test`, `netride.dev`,
//     `test.netride`, `test.netride.com`, or a reserved example domain
//
// `TEST_EMAIL_SQL(column)` is the canonical SQL rendering of the same rule —
// every admin list query must use it so TS and SQL can never drift.
import { pool } from '../config/database';

const TEST_EMAIL_REGEX =
  /(^|[-_.+])(test|sandbox|dev|e2e)([-_.+0-9@]|$)|^(test|sandbox|dev|e2e)([-_.+0-9@]|$)/i;

const TEST_DOMAINS = [
  'netride.test',
  'netride.dev',
  'test.netride',
  'test.netride.com',
  'example.com',
  'example.org',
];

export function isTestEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const lower = email.trim().toLowerCase();
  if (TEST_EMAIL_REGEX.test(lower)) return true;
  return TEST_DOMAINS.some((d) => lower.endsWith('@' + d));
}

/**
 * Canonical SQL predicate for the test-email rule. `column` must be a
 * trusted SQL fragment (a column reference such as `u.email`), never user
 * input. Returns a boolean expression safe to inline in WHERE/SELECT.
 */
export function TEST_EMAIL_SQL(column: string): string {
  return `(
    ${column} ~* '(^|[-_.+])(test|sandbox|dev|e2e)([-_.+0-9@]|$)'
    OR lower(${column}) LIKE '%@netride.test'
    OR lower(${column}) LIKE '%@netride.dev'
    OR lower(${column}) LIKE '%@test.netride'
    OR lower(${column}) LIKE '%@test.netride.com'
    OR lower(${column}) LIKE '%@example.com'
    OR lower(${column}) LIKE '%@example.org'
  )`;
}

/**
 * True when BOTH the rider and the driver of a trip are test users.
 * Single round-trip — fetches both emails in one query and ANDs the
 * result.
 */
export async function areBothTestUsers(
  riderId: string,
  driverId: string | null | undefined,
): Promise<boolean> {
  if (!driverId) return false;
  try {
    const res = await pool.query(
      `SELECT id, email FROM users WHERE id = ANY($1::uuid[])`,
      [[riderId, driverId]],
    );
    const emails = new Map<string, string>();
    for (const row of res.rows) {
      emails.set(row.id, row.email);
    }
    return isTestEmail(emails.get(riderId)) && isTestEmail(emails.get(driverId));
  } catch (err: any) {
    // Schema-level failures (no users table, etc.) should not crash the
    // ride — fail open and let the normal flow run.
    console.warn(`[TEST_USER] areBothTestUsers lookup failed: ${err.message}`);
    return false;
  }
}
