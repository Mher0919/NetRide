import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const migrationPath = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'backend',
  'migrations',
  '20261030_group_rides.sql',
);
const sql = fs.readFileSync(migrationPath, 'utf8');

const newTables = [
  'friendships',
  'ride_group_settings',
  'ride_groups',
  'ride_group_members',
  'ride_group_invitations',
  'ride_group_messages',
  'ride_group_route_plans',
  'ride_group_quotes',
  'ride_group_quote_shares',
  'ride_group_payments',
];

test('group tips table is deny-by-default as well', () => {
  const tipsSql = fs.readFileSync(
    path.resolve(__dirname, '..', '..', '..', '..', 'backend', 'migrations', '20261031_group_tips.sql'),
    'utf8',
  );
  assert.ok(tipsSql.includes('ride_group_tips'));
  assert.ok(tipsSql.includes('ENABLE ROW LEVEL SECURITY'));
  assert.ok(tipsSql.includes('REVOKE ALL PRIVILEGES'));
  assert.ok(tipsSql.includes('payouts_tip_credit_unique'));
});

test('every new group-owned table enables RLS and revokes client roles', () => {
  for (const table of newTables) {
    assert.ok(sql.includes(`'${table}'`), `${table} must be in the RLS list`);
  }
  assert.ok(sql.includes('ENABLE ROW LEVEL SECURITY'));
  assert.ok(sql.includes("REVOKE ALL PRIVILEGES ON TABLE public.%I FROM %I"));
  assert.ok(sql.includes("ARRAY['anon', 'authenticated']"));
});

test('group migration does not blindly touch PostGIS-owned tables', () => {
  assert.ok(!/ALTER TABLE\s+public?\.?spatial_ref_sys/i.test(sql));
  assert.ok(!/ENABLE ROW LEVEL SECURITY[^;]*spatial_ref_sys/i.test(sql));
});

test('capacity is enforced in the database, not only the service', () => {
  assert.ok(sql.includes('enforce_group_member_capacity'));
  assert.ok(sql.includes('enforce_group_invitation_capacity'));
  assert.ok(sql.includes('GROUP_FULL'));
  assert.ok(sql.includes('FOR UPDATE'));
});

test('quote and payment reconciliation invariants are database constraints', () => {
  assert.ok(sql.includes('ride_group_quotes_reconcile'));
  assert.ok(sql.includes('ride_group_payments_reconcile'));
  assert.ok(sql.includes('ride_group_payments_quote_participant_uniq'));
});

test('one active group ride and one rating per participant are enforced', () => {
  assert.ok(sql.includes('rides_one_active_group_ride_uniq'));
  assert.ok(sql.includes('ratings_ride_rater_uniq'));
});
