// backend/src/services/__tests__/financial-ledger.unit.test.ts
//
// Unit tests for the financial settlement ledger decision logic. Pure
// functions only — no network, no Redis, no DB — so they run in CI in
// milliseconds. Registered in run-tests.cjs.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  centsValue,
  settlementStatusFor,
  grossAmountCents,
} from '../financial-ledger.service';

// --- Money column conversion (the 100× regression guard) ----------------

test('centsValue: BIGINT-as-string cents are NOT multiplied by 100', () => {
  // final_payment_cents = 2050 means $20.50. The historic bug multiplied
  // this by 100 and charged $2,050.
  assert.equal(centsValue('2050'), 2050);
  assert.equal(centsValue('0'), 0);
});

test('centsValue: handles BigInt, number and null/garbage inputs', () => {
  assert.equal(centsValue(2050n), 2050);
  assert.equal(centsValue(2050), 2050);
  assert.equal(centsValue(null), 0);
  assert.equal(centsValue(undefined), 0);
  assert.equal(centsValue('abc'), 0);
  assert.equal(centsValue(2050.4), 2050);
});

// --- Settlement status (the one-ledger-row-per-ride business rule) -------

test('settlementStatusFor: fully covered ride is SETTLED', () => {
  assert.equal(settlementStatusFor(0), 'SETTLED');
});

test('settlementStatusFor: any outstanding amount stays PENDING_CAPTURE', () => {
  assert.equal(settlementStatusFor(1), 'PENDING_CAPTURE');
  assert.equal(settlementStatusFor(3200), 'PENDING_CAPTURE');
});

// --- Gross composition ---------------------------------------------------

test('grossAmountCents: final fare + promo + credits + tip', () => {
  assert.equal(grossAmountCents(2050, 500, 0, 400), 2950);
  assert.equal(grossAmountCents(0, 0, 0, 0), 0);
  assert.equal(grossAmountCents(0, 0, 1000, 400), 1400);
});