// backend/src/utils/testUser.ts
//
// Detection of "test" accounts so E2E/dev seed data can be separated from
// real accounts across the admin dashboard.
//
// SECURITY: test classification is used for privileged behaviour (skipping
// the saved-card requirement, the test-ride completion endpoint), so it must
// NEVER be derivable from an email address an attacker can register. The
// rule is therefore:
//
//   1. Reserved, non-registrable domains (`netride.test`, `netride.dev`,
//      `test.netride`, `test.netride.com`, RFC-reserved `example.com` /
//      `example.org`): ANY local part is a test account.
//   2. Operator-controlled domains (`netride.org`, `netride.com`, plus any
//      domains configured via `TEST_EMAIL_DOMAINS`): the local part must
//      contain a boundary-separated `test`/`sandbox`/`dev`/`e2e` segment
//      (e.g. `partner-test@netride.org`). Only the organization can create
//      mailboxes on these domains, so the pattern is not attacker-reachable.
//   3. An explicit operator allowlist of complete addresses
//      (`TEST_ACCOUNT_EMAILS`, comma-separated).
//
// The previous heuristic applied the local-part pattern to EVERY domain,
// which classified ordinary attacker-registerable addresses such as
// `test123@gmail.com` as test accounts.
//
// `TEST_EMAIL_SQL(column)` is the canonical SQL rendering of the same rule —
// every admin list query must use it so TS and SQL can never drift.
import { pool } from '../config/database';

/** Domains that cannot be registered by the public (RFC 2606 / reserved). */
const TEST_DOMAINS = [
  'netride.test',
  'netride.dev',
  'test.netride',
  'test.netride.com',
  'example.com',
  'example.org',
];

/**
 * Domains owned/controlled by the operator where a boundary-separated
 * test/sandbox/dev/e2e local part marks a test mailbox. Extendable with
 * `TEST_EMAIL_DOMAINS` (comma-separated).
 */
function operatorDomains(): string[] {
  const extra = String(process.env.TEST_EMAIL_DOMAINS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
  return ['netride.org', 'netride.com', ...extra];
}

const TEST_EMAIL_REGEX =
  /(^|[-_.+])(test|sandbox|dev|e2e)([-_.+0-9@]|$)/i;

/** Explicit operator-configured allowlist of complete test addresses. */
function testEmailAllowlist(): string[] {
  return String(process.env.TEST_ACCOUNT_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isTestEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const lower = email.trim().toLowerCase();
  if (!lower.includes('@')) return false;
  const domain = lower.slice(lower.lastIndexOf('@') + 1);

  if (testEmailAllowlist().includes(lower)) return true;
  if (TEST_DOMAINS.includes(domain)) return true;
  if (operatorDomains().includes(domain)) return TEST_EMAIL_REGEX.test(lower);
  return false;
}

function sqlEscapeLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Canonical SQL predicate for the test-email rule. `column` must be a
 * trusted SQL fragment (a column reference such as `u.email`), never user
 * input. Returns a boolean expression safe to inline in WHERE/SELECT.
 */
export function TEST_EMAIL_SQL(column: string): string {
  const lower = `lower(${column})`;
  const reserved = TEST_DOMAINS.map((d) => `${lower} LIKE '%@${d}'`).join('\n    OR ');
  const operator = operatorDomains()
    .map((d) => `${lower} LIKE '%@${d}'`)
    .join('\n      OR ');
  const allowed = testEmailAllowlist();
  const allowedSql = allowed
    .map((e) => `${lower} = '${sqlEscapeLiteral(e)}'`)
    .join('\n    OR ');
  return `(
    ${reserved}
    OR (
      (${operator})
      AND ${column} ~* '(^|[-_.+])(test|sandbox|dev|e2e)([-_.+0-9@]|$)'
    )
    ${allowedSql ? `\n    OR ${allowedSql}` : ''}
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
    // ride — fail closed: an unverifiable classification must never grant
    // test-only privileges.
    console.warn(`[TEST_USER] areBothTestUsers lookup failed: ${err.message}`);
    return false;
  }
}
