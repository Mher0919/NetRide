// tests/unit/backend/utils/ride-scope-sql.unit.test.ts
//
// Regression suite for the production/test ride classification shared by the
// Revenue summary and Revenue analytics endpoints. Production and test
// metrics must never be computed from different predicates.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TEST_RIDE_SQL,
  rideScopeCondition,
  TEST_EMAIL_SQL,
} from '../../../../backend/src/utils/testUser';

test('TEST_EMAIL_SQL: reserved domains and operator domains are classified', () => {
  const sql = TEST_EMAIL_SQL('u.email');
  assert.match(sql, /@netride\.test/);
  assert.match(sql, /@netride\.dev/);
  assert.match(sql, /@example\.com/);
  assert.match(sql, /netride\.org/);
  // Regex rule applied only to operator-owned domains.
  assert.match(sql, /test\|sandbox\|dev\|e2e/);
});

test('TEST_RIDE_SQL: a ride is test when the rider is test and no production driver is attached', () => {
  const sql = TEST_RIDE_SQL('r', 'ru', 'du');
  assert.match(sql, /ru\.email/);
  assert.match(sql, /du\.email/);
  assert.match(sql, /r\.driver_id IS NULL/);
});

test('rideScopeCondition: production is the exact complement of test', () => {
  const testCond = rideScopeCondition('test');
  const prodCond = rideScopeCondition('production');
  assert.equal(prodCond, `NOT ${testCond}`);
  assert.equal(testCond, TEST_RIDE_SQL());
});

test('rideScopeCondition: aliases are honoured for joined queries', () => {
  const sql = rideScopeCondition('production', 'ride', 'rider_user', 'driver_user');
  assert.match(sql, /ride\.driver_id IS NULL/);
  assert.match(sql, /rider_user\.email/);
  assert.match(sql, /driver_user\.email/);
  assert.ok(sql.startsWith('NOT '));
});

test('TEST_EMAIL_SQL: attacker-registerable public domains are never test', () => {
  // The SQL mirrors isTestEmail: the local-part pattern applies ONLY to the
  // operator domains — a gmail address containing "test" is NOT test data.
  const sql = TEST_EMAIL_SQL('u.email');
  const gmailBranch = /lower\(u\.email\) LIKE '%@gmail\.com'/;
  assert.ok(!gmailBranch.test(sql));
});
