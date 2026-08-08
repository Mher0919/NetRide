// backend/src/modules/referral/__tests__/referral-onboarding.unit.test.ts
//
// Unit tests for referral onboarding + device-fraud PURE policy logic.
// These run with NO network and NO database, so they execute in CI /
// pre-commit in milliseconds.
//
// DB-backed guarantees (one-referral-per-rider UNIQUE constraint, reward
// idempotency, device registry, audit events) are enforced by schema +
// service code requiring a live Postgres — covered by migration DDL and
// the E2E smoke script instead.

import test from 'node:test';
import assert from 'node:assert/strict';

import { accountsToRisk } from '../../../services/device-risk.service';

// ---- Device risk ladder (Phases 11-12 policy) ------------------------------

test('accountsToRisk: single account is NORMAL', () => {
  assert.equal(accountsToRisk(1), 'NORMAL');
});

test('accountsToRisk: exactly two accounts is REVIEW', () => {
  assert.equal(accountsToRisk(2), 'REVIEW');
});

test('accountsToRisk: three accounts is BLOCKED', () => {
  assert.equal(accountsToRisk(3), 'BLOCKED');
});

test('accountsToRisk: heavy device sharing stays BLOCKED', () => {
  assert.equal(accountsToRisk(9), 'BLOCKED');
});

test('accountsToRisk: unknown/zero defaults to NORMAL (never blocks by accident)', () => {
  assert.equal(accountsToRisk(0), 'NORMAL');
});
