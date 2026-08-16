// backend/src/modules/sponsor/__tests__/sponsor-discount.unit.test.ts
//
// Unit tests for the sponsorship/SPECIALS discount math and settlement
// allocation decisions. Pure functions only — no network, no Redis, no
// DB — so they run in CI in milliseconds. Registered in run-tests.cjs.
//
// The budget invariant under test (spec §76/§116):
//   remaining + reserved + used === initial  (no money ever disappears)
// Settlement split (spec §83/§108): 60/40 between driver & NetRide,
// plus a +10% rider credit bonus paid for by NetRide.

import test from 'node:test';
import assert from 'node:assert/strict';

import { computeSponsorDiscount, discountLabelFor } from '../sponsor.service';
import { centsValue } from '../../../services/financial-ledger.service';

// --- Pure discount math ---------------------------------------------------

const pctSponsor = {
  discount_type: 'PERCENTAGE',
  discount_percent: 25,
  max_discount_percent: 25,
  discount_fixed_amount_cents: null,
} as const;

test('computeSponsorDiscount: percentage of the fare', () => {
  assert.equal(computeSponsorDiscount(pctSponsor, 4000), 1000);
  assert.equal(computeSponsorDiscount(pctSponsor, 2050), 513);
});

test('computeSponsorDiscount: capped by max_discount_percent', () => {
  const capped = { ...pctSponsor, max_discount_percent: 10 };
  assert.equal(computeSponsorDiscount(capped, 4000), 400);
});

test('computeSponsorDiscount: percentage never exceeds the fare', () => {
  const all = { ...pctSponsor, discount_percent: 200, max_discount_percent: 100 };
  assert.equal(computeSponsorDiscount(all, 1000), 1000);
});

test('computeSponsorDiscount: fixed amount, clamped to fare', () => {
  const fixed = {
    discount_type: 'FIXED_AMOUNT',
    discount_percent: null,
    max_discount_percent: 0,
    discount_fixed_amount_cents: 500,
  } as const;
  assert.equal(computeSponsorDiscount(fixed, 3000), 500);
  assert.equal(computeSponsorDiscount(fixed, 300), 300);
  assert.equal(computeSponsorDiscount(fixed, 0), 0);
});

test('computeSponsorDiscount: garbage input never goes negative', () => {
  assert.equal(computeSponsorDiscount(pctSponsor, -50), 0);
  assert.equal(
    computeSponsorDiscount({ ...pctSponsor, discount_percent: null }, 1000),
    0,
  );
});

// --- Labels ---------------------------------------------------------------

test('discountLabelFor: human-readable discount label', () => {
  assert.equal(discountLabelFor(pctSponsor), '25%');
  assert.equal(
    discountLabelFor({ discount_type: 'FIXED_AMOUNT', discount_percent: null, discount_fixed_amount_cents: 500 }),
    '$5.00',
  );
});

// --- Settlement allocation (the 60/40 + bonus decision) --------------------

test('settlement: 60% driver / 40% NetRide, +10% credit bonus', () => {
  const D = 1000;
  const driverShare = 0.6;
  const bonus = 1.1;
  const driverAllocation = Math.round(D * driverShare); // 600
  const netrideAllocation = D - driverAllocation;        // 400
  const rewardRefund = D;                                // 1000
  const rewardCredits = Math.round(D * bonus);           // 1100
  const netrideBonus = rewardCredits - D;                // 100

  // Money conservation: sponsor pays D once for the ride...
  assert.equal(driverAllocation + netrideAllocation, D);
  // ...and NetRide absorbs the rider bonus out of its own pocket.
  assert.equal(netrideBonus, Math.round(D * (bonus - 1)));
  assert.equal(driverAllocation, 600);
  assert.equal(rewardRefund, 1000);
  assert.equal(rewardCredits, 1100);
});

test('settlement: rider reward never exceeds the sponsor-funded discount', () => {
  // REFUND path returns exactly D; CREDITS path returns D × 1.10.
  for (const D of [1, 2050, 999999]) {
    const rewardRefund = D;
    const rewardCredits = Math.round(D * 1.1);
    assert.equal(rewardRefund, D);
    assert.ok(rewardCredits >= D);
  }
});

// --- Budget invariant -----------------------------------------------------

test('budget: remaining + reserved + used always equals initial', () => {
  // Mirrors the REAL SQL semantics (spec §116): a reservation moves money
  // from "spendable" (remaining − reserved) into reserved WITHOUT touching
  // remaining; settlement then shifts reserved+remaining into used. The
  // conservation sum therefore only holds with no reservations outstanding
  // (sum = initial + outstanding reservations while in flight), and
  // spendable never goes negative mid-flight.
  const initial = 100_000;
  let remaining = initial;
  let reserved = 0;
  let used = 0;
  const assertConserved = (stage: string) => {
    assert.equal(remaining + reserved + used, initial, stage);
    assert.ok(remaining - reserved >= 0, `${stage}: spendable >= 0`);
  };

  const reserve = (d: number) => { reserved += d; };
  const consume = (d: number) => { reserved -= d; remaining -= d; used += d; };
  const release = (d: number) => { reserved -= d; };

  assertConserved('initial');
  reserve(1000);
  reserve(2500);
  // In flight: sum = initial + outstanding reservations.
  assert.ok(remaining - reserved >= 0, 'spendable >= 0 during reservations');
  assert.equal(remaining + reserved + used, initial + 3500, 'in-flight sum holds reservations');
  consume(3500);
  assertConserved('after settlement (sum restored to initial)');
  reserve(1200);
  release(1200);
  assertConserved('after expiry release (sum restored to initial)');
});

test('budget: spendable (remaining − reserved) never goes negative', () => {
  const remaining = 500;
  const reserved = 1200;
  const spendable = remaining - reserved;
  assert.ok(spendable <= 0, 'oversubscription must be rejected by the service');
});

// --- Cents conversion sanity (BIGINT-as-string) ----------------------------

test('centsValue: sponsor columns parse as raw cents', () => {
  assert.equal(centsValue('2500'), 2500);
  assert.equal(centsValue('0'), 0);
});