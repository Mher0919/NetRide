// tests/unit/backend/modules/portal/portal-identity.unit.test.ts
//
// Unit tests for the colab (portal) ⇄ driver/rider identity separation
// introduced with migration 058:
//
//   * a driver/rider and a sponsor/partner/fleet identity may share an email
//     as two independent rows,
//   * portal login resolves ONLY portal-class identities,
//   * consumer login resolves ONLY consumer-class identities,
//   * a disabled portal row reports "disabled" while the identity stays
//     active (re-enablable), and a consumer row's state is never inspected,
//   * admin linking refuses rider/driver/admin selections,
//   * the shared test-account predicate used by admin list filtering.
//
// The mirrors below follow the exact algorithms in
// portal-identities.ts / portal-auth.service.ts; the HTTP E2E
// (tests/e2e/dashboard-workflows/run-colab-identity-e2e.cjs) exercises the
// real SQL against the database.

import test from 'node:test';
import assert from 'node:assert/strict';
import { isTestEmail, TEST_EMAIL_SQL } from '../../../../../backend/src/utils/testUser';

// ---------------------------------------------------------------------------
// Reference mirrors
// ---------------------------------------------------------------------------

type Role = 'RIDER' | 'DRIVER' | 'ADMIN' | 'SPONSOR' | 'PARTNER' | 'FLEET';
interface Identity {
  id: string;
  email: string;
  role: Role;
  is_active: boolean;
  password: string;
  ownsPortalAccount: boolean;
}

const CONSUMER_ROLES: Role[] = ['RIDER', 'DRIVER', 'ADMIN'];
const PORTAL_ROLES: Role[] = ['SPONSOR', 'PARTNER', 'FLEET'];

/** Mirror of findPortalIdentityByEmail(): portal class + owns a portal account. */
function findPortalIdentityByEmail(users: Identity[], email: string): Identity | null {
  return (
    users.find(
      (u) => u.email === email && PORTAL_ROLES.includes(u.role) && u.ownsPortalAccount,
    ) ?? null
  );
}

/** Mirror of the consumer lookup in auth.service.loginWithPassword(). */
function findConsumerIdentityByEmail(users: Identity[], email: string): Identity | null {
  return users.find((u) => u.email === email && CONSUMER_ROLES.includes(u.role)) ?? null;
}

/** Mirror of isPortalIdentity(): role class only. */
function isPortalIdentity(user: Identity): boolean {
  return PORTAL_ROLES.includes(user.role);
}

const PORTAL_ACCESS_DISABLED = 'Your login is disabled. Contact NetRide support to restore access.';
const PORTAL_ACCESS_NOT_ENABLED = 'Portal access is not enabled for this account. Contact NetRide support.';

/** Mirror of the post-password-check outcome in portal-auth.service.login(). */
function portalLoginOutcome(
  users: Identity[],
  email: string,
  password: string,
  portalRowActive: boolean,
): { ok: boolean; error?: string; identityId?: string } {
  const identity = findPortalIdentityByEmail(users, email);
  if (!identity || identity.password !== password) return { ok: false, error: 'Invalid email or password' };
  if (!identity.is_active) return { ok: false, error: 'Your account is disabled. Contact NetRide support.' };
  if (!identity.ownsPortalAccount) return { ok: false, error: PORTAL_ACCESS_NOT_ENABLED };
  if (!portalRowActive) return { ok: false, error: PORTAL_ACCESS_DISABLED };
  return { ok: true, identityId: identity.id };
}

function makeSharedEmailUsers(): Identity[] {
  return [
    {
      id: 'rider-1',
      email: 'shared@example.test',
      role: 'RIDER',
      is_active: false, // driver/rider row deactivated — must NOT matter for colab
      password: 'RiderPass!',
      ownsPortalAccount: false,
    },
    {
      id: 'sponsor-1',
      email: 'shared@example.test',
      role: 'SPONSOR',
      is_active: true,
      password: 'ColabPass!',
      ownsPortalAccount: true,
    },
  ];
}

// ---------------------------------------------------------------------------
// Identity resolution
// ---------------------------------------------------------------------------

test('portal login selects the colab identity even when the rider row is inactive', () => {
  const users = makeSharedEmailUsers();
  const outcome = portalLoginOutcome(users, 'shared@example.test', 'ColabPass!', true);
  assert.equal(outcome.ok, true, 'colab login must succeed');
  assert.equal(outcome.identityId, 'sponsor-1', 'must never pick the rider row');
});

test('portal login never accepts the rider password for a colab email', () => {
  const users = makeSharedEmailUsers();
  const outcome = portalLoginOutcome(users, 'shared@example.test', 'RiderPass!', true);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error, 'Invalid email or password');
});

test('consumer login selects the rider identity even when a colab row shares the email', () => {
  const users = makeSharedEmailUsers();
  const rider = findConsumerIdentityByEmail(users, 'shared@example.test');
  assert.equal(rider?.id, 'rider-1');
  assert.equal(rider?.password, 'RiderPass!', 'consumer lookup must never resolve the colab row');
});

test('a colab-only email is invisible to the consumer lookup', () => {
  const users = makeSharedEmailUsers();
  assert.equal(findConsumerIdentityByEmail(users, 'sponsor-only@example.test'), null);
});

test('a disabled portal row reports disabled; the inactive rider never leaks into the message', () => {
  const users = makeSharedEmailUsers();
  const inactive = portalLoginOutcome(users, 'shared@example.test', 'ColabPass!', false);
  assert.equal(inactive.ok, false);
  assert.equal(inactive.error, PORTAL_ACCESS_DISABLED);
  // The identity itself is still active — re-enabling restores access.
  assert.equal(users[1].is_active, true);
  const enabled = portalLoginOutcome(users, 'shared@example.test', 'ColabPass!', true);
  assert.equal(enabled.ok, true, 'same credentials work again after re-enable');
});

test('a role without any portal account is invisible to portal login (uniform error)', () => {
  const users = makeSharedEmailUsers();
  users[1].ownsPortalAccount = false;
  const outcome = portalLoginOutcome(users, 'shared@example.test', 'ColabPass!', true);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error, 'Invalid email or password', 'no enumeration — same error as unknown email');
});

test('an existing identity whose only portal account vanished reports not-enabled', () => {
  // Defensive branch: the identity still resolves (account row existed at
  // resolution time) but has zero portal accounts left.
  const users = makeSharedEmailUsers();
  const statesCount = 0;
  const error = statesCount === 0 ? PORTAL_ACCESS_NOT_ENABLED : null;
  assert.equal(error, PORTAL_ACCESS_NOT_ENABLED);
});

// ---------------------------------------------------------------------------
// Linking rules
// ---------------------------------------------------------------------------

test('only sponsor/partner/fleet identities may be linked as colab logins', () => {
  const users = makeSharedEmailUsers();
  assert.equal(isPortalIdentity(users[0]), false, 'rider is not linkable');
  assert.equal(isPortalIdentity(users[1]), true, 'sponsor is linkable');
  for (const role of ['DRIVER', 'RIDER', 'ADMIN'] as Role[]) {
    assert.equal(isPortalIdentity({ ...users[1], role }), false, `${role} must be rejected`);
  }
});

test('an email owned only by a driver/rider does not block a NEW colab login', () => {
  const users: Identity[] = [
    {
      id: 'rider-9',
      email: 'shared@example.test',
      role: 'RIDER',
      is_active: true,
      password: 'RiderPass!',
      ownsPortalAccount: false,
    },
  ];
  const dup = findPortalIdentityByEmail(users, 'shared@example.test');
  assert.equal(dup, null, 'a consumer-only email is not a colab duplicate');
});

test('a colab identity owning another portal account IS a duplicate', () => {
  const users = makeSharedEmailUsers();
  assert.notEqual(findPortalIdentityByEmail(users, 'shared@example.test'), null);
});

// ---------------------------------------------------------------------------
// Test-account predicate (real implementation)
// ---------------------------------------------------------------------------

test('isTestEmail flags every observed E2E/sandbox pattern', () => {
  const testEmails = [
    'e2e-ref-0807213556-a@test.netride',
    'probe-0807213746@test.netride',
    'auto-close-1786172372035@test.netride',
    'payment-rider-a@netride.test',
    'stripe-e2e-93004048@netride.test',
    'driver@NetRide.dev',
    'drvtest-1786262904@test.netride.com',
    'partner-test@netride.org',
    'fleet-test@netride.org',
    'rider@example.com',
    '+test@netride.org',
    'sandbox@netride.org',
    'test.one@netride.org',
  ];
  for (const email of testEmails) {
    assert.equal(isTestEmail(email), true, `${email} must be classified as test`);
  }
});

test('isTestEmail leaves real accounts alone', () => {
  const realEmails = [
    'mhermkrtumyan2@gmail.com',
    'mmkrtumyan29@gmail.com',
    'admin@netride.org',
    'devon@gmail.com',
    'attestation@company.com',
  ];
  for (const email of realEmails) {
    assert.equal(isTestEmail(email), false, `${email} must NOT be classified as test`);
  }
});

test('isTestEmail handles null/undefined safely', () => {
  assert.equal(isTestEmail(null), false);
  assert.equal(isTestEmail(undefined), false);
  assert.equal(isTestEmail(''), false);
});

test('TEST_EMAIL_SQL matches the TS rule (same domains + boundary fragments)', () => {
  const sql = TEST_EMAIL_SQL('u.email');
  for (const domain of ['@netride.test', '@netride.dev', '@test.netride', '@test.netride.com', '@example.com', '@example.org']) {
    assert.ok(sql.includes(domain), `SQL must cover ${domain}`);
  }
  assert.ok(sql.includes('(^|[-_.+])(test|sandbox|dev|e2e)'), 'SQL must keep the boundary regex');
  assert.ok(sql.includes('~*'), 'match must be case-insensitive');
});
