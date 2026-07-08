// backend/src/utils/testUser.ts
//
// Email-based detection of "test" accounts so the test loop can skip the
// payment side of a ride and still credit the driver wallet. We use a
// simple regex so no schema change is required.
//
// A user is considered a test user when their email matches one of:
//   - contains a `+test`, `+sandbox`, or `+dev` plus-tag
//   - the local part starts with `test`, `sandbox`, or `dev`
//   - the domain is `@netride.test`
//
// The matching rule is intentionally permissive — every test/dev
// workflow we've seen uses one of those patterns. If you need to
// onboard a new test account, just create it with one of those
// substrings in the email and the bypass will activate.
import { pool } from '../config/database';

const TEST_EMAIL_REGEX =
  /(^|\+)(test|sandbox|dev)([-_.]|$)/i;

const TEST_DOMAINS = ['netride.test', 'netride.dev'];

export function isTestEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const lower = email.toLowerCase();
  if (TEST_EMAIL_REGEX.test(lower)) return true;
  return TEST_DOMAINS.some((d) => lower.endsWith('@' + d));
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
