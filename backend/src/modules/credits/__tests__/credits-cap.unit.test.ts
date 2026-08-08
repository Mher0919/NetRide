// backend/src/modules/credits/__tests__/credits-cap.unit.test.ts
//
// Pure unit tests for the credit-application cap math (money logic that
// runs inside the ride request transaction). No network, no DB.

import test from 'node:test';
import assert from 'node:assert/strict';

import { computeCreditApplication } from '../credits-cap';

test('no capCents -> applies min(balance, remaining fare)', () => {
  assert.equal(computeCreditApplication(2000, 1500), 1500);
  assert.equal(computeCreditApplication(500, 1500), 500);
});

test('capCents caps the amount below the balance', () => {
  assert.equal(computeCreditApplication(2000, 1500, 750), 750);
});

test('capCents above the balance -> balance wins', () => {
  assert.equal(computeCreditApplication(400, 1500, 1000), 400);
});

test('capCents above remaining fare -> remaining wins', () => {
  assert.equal(computeCreditApplication(2000, 800, 1500), 800);
});

test('zero balance -> nothing applied', () => {
  assert.equal(computeCreditApplication(0, 1500, 750), 0);
});

test('zero fare -> nothing applied even with balance', () => {
  assert.equal(computeCreditApplication(2000, 0), 0);
});

test('negative/NaN inputs clamp to zero', () => {
  assert.equal(computeCreditApplication(-100, 1500), 0);
  assert.equal(computeCreditApplication(2000, -50), 0);
  assert.equal(computeCreditApplication(2000, 1500, -75), 0);
  assert.equal(computeCreditApplication(2000, 1500, NaN), 0);
});

test('fractional inputs round to whole cents', () => {
  assert.equal(computeCreditApplication(2000.4, 1500.6), 1501);
  assert.equal(computeCreditApplication(2000, 1500, 749.6), 750);
});
