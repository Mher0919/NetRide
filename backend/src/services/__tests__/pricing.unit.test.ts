// backend/src/services/__tests__/pricing.unit.test.ts
//
// Unit tests for the central pricing engine + revenue allocation. Pure
// functions only — no network, no Redis, no DB — so they run in CI in
// milliseconds. Registered in run-tests.cjs.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeFare,
  computeRevenueSplit,
  DEFAULT_PRICING_CONFIG,
  DEFAULT_REVENUE_CONFIG,
} from '../pricing.service';

const NEUTRAL_MARKET = {
  demandRatio: 1.0,
  onlineDrivers: 10,
  activeRequests: 10,
  hourOfDay: 12,
  demandMultiplier: 1.0,
  timeMultiplier: 1.0,
  reasons: ['Neutral test market'],
  computedAt: 0,
};

// --- Flat fare formula (production spec) -------------------------------

test('computeFare: flat formula base + $2.50/mile + $0.40/min', () => {
  // 2.5 miles × $2.50 = $6.25, 12 min × $0.40 = $4.80, base $4.00 → $15.05
  const fare = computeFare(
    { distanceMeters: 2.5 * 1609.344, durationSeconds: 720 },
    DEFAULT_PRICING_CONFIG,
    NEUTRAL_MARKET,
  );
  assert.equal(fare.baseFare, 4.00);
  assert.equal(fare.distanceFare, 6.25);
  assert.equal(fare.timeFare, 4.80);
  assert.equal(fare.bookingFee, 0);
  assert.equal(fare.serviceFee, 0);
  assert.equal(fare.taxes, 0);
  assert.equal(fare.totalFare, 15.05);
});

test('computeFare: $10.00 minimum applies to short rides', () => {
  const fare = computeFare(
    { distanceMeters: 100, durationSeconds: 60 },
    DEFAULT_PRICING_CONFIG,
    NEUTRAL_MARKET,
  );
  assert.equal(fare.totalFare, DEFAULT_PRICING_CONFIG.minimum_fare);
});

test('computeFare: surge is disabled in the live flat profile', () => {
  const peak = { ...NEUTRAL_MARKET, demandMultiplier: 2.0, timeMultiplier: 2.0 };
  const flat = computeFare(
    { distanceMeters: 5000, durationSeconds: 600 },
    DEFAULT_PRICING_CONFIG,
    NEUTRAL_MARKET,
  );
  const surged = computeFare(
    { distanceMeters: 5000, durationSeconds: 600 },
    DEFAULT_PRICING_CONFIG,
    peak,
  );
  assert.equal(flat.surgeMultiplier, 1.0);
  assert.equal(surged.surgeMultiplier, 1.0);
  assert.equal(flat.totalFare, surged.totalFare);
});

test('computeFare: flat profile ignores LIVE market DISCOUNTS (no $10 floor collisions)', () => {
  // Regression (2026-08): the live market could dip to ×0.90 demand / ×0.95
  // off-peak. With the flat profile (max_demand_multiplier pinned to 1.00)
  // those discounts forced short rides below the raw fare and every
  // estimate collided with the minimum — "everything is $10".
  const discounted = { ...NEUTRAL_MARKET, demandMultiplier: 0.9, timeMultiplier: 0.95 };
  // 2.12 mi × 2.50 + 3.93 min × 0.40 + 4.00 = 10.87 — must NOT be floored.
  const fare = computeFare(
    { distanceMeters: 3407, durationSeconds: 236 },
    DEFAULT_PRICING_CONFIG,
    discounted,
  );
  assert.equal(fare.surgeMultiplier, 1.0, 'flat profile must ignore market discounts');
  assert.equal(fare.totalFare, 10.87);
});

test('computeFare: market multipliers apply when a profile opts OUT of flat', () => {
  const config = {
    ...DEFAULT_PRICING_CONFIG,
    max_demand_multiplier: 2.0,
  };
  const discounted = { ...NEUTRAL_MARKET, demandMultiplier: 0.9, timeMultiplier: 0.95 };
  const fare = computeFare(
    { distanceMeters: 3407, durationSeconds: 236 },
    config,
    discounted,
  );
  assert.ok(fare.surgeMultiplier < 1.0, 'market discounts must apply when surge is enabled');
});

test('computeFare: deterministic and itemized (spec $100 scenario shape)', () => {
  const fare = computeFare(
    { distanceMeters: 30 * 1609.344, durationSeconds: 20 * 60 },
    DEFAULT_PRICING_CONFIG,
    NEUTRAL_MARKET,
  );
  // 4.00 + 75.00 + 8.00 = 87.00
  assert.equal(fare.totalFare, 87.00);
  assert.equal(fare.currency, 'USD');
  assert.ok(Number.isFinite(fare.distanceMiles) && Number.isFinite(fare.durationMinutes));
});

test('computeFare respects custom configuration', () => {
  const config = {
    ...DEFAULT_PRICING_CONFIG,
    base_fare: 5.00,
    per_mile_rate: 2.00,
    minimum_fare: 12.00,
  };
  const fare = computeFare(
    { distanceMeters: 1609.344, durationSeconds: 60 },
    config,
    NEUTRAL_MARKET,
  );
  assert.equal(fare.baseFare, 5.00);
  assert.equal(fare.distanceFare, 2.00);
  assert.equal(fare.timeFare, 0.40);
  assert.equal(fare.totalFare, 12.00);
});

test('computeFare runs in microseconds (no I/O)', () => {
  const start = process.hrtime.bigint();
  for (let i = 0; i < 1000; i++) {
    computeFare({ distanceMeters: 3000, durationSeconds: 300 }, DEFAULT_PRICING_CONFIG, NEUTRAL_MARKET);
  }
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(ms < 50, `1000 fares took ${ms.toFixed(2)}ms`);
});

// --- Revenue split: 60/40 driver/platform (production spec) -----------

const FLEET_A = { id: 'fleet-a', name: 'Fleet A', platformSharePercent: 50, isActive: true };
const FLEET_B = { id: 'fleet-b', name: 'Fleet B', platformSharePercent: 30, isActive: true };
const FLEET_OFF = { id: 'fleet-off', name: 'Fleet Off', platformSharePercent: 80, isActive: false };

test('revenue: $100 fare → driver $60, platform $40', () => {
  const split = computeRevenueSplit(10000, null, DEFAULT_REVENUE_CONFIG, []);
  assert.equal(split.driverShareCents, 6000);
  assert.equal(split.platformShareCents, 4000);
  assert.equal(split.netrideShareCents, 4000);
  assert.deepEqual(split.fleetShares, []);
});

test('revenue: fleet split of the platform pool ($100 → $60/$20/$20)', () => {
  const split = computeRevenueSplit(10000, 'fleet-a', DEFAULT_REVENUE_CONFIG, [FLEET_A]);
  assert.equal(split.driverShareCents, 6000);
  assert.equal(split.fleetShares.length, 1);
  assert.equal(split.fleetShares[0].fleetId, 'fleet-a');
  assert.equal(split.fleetShares[0].cents, 2000);
  assert.equal(split.netrideShareCents, 2000);
  assert.equal(split.fleetAllocationMap['fleet-a'], 2000);
});

test('revenue: driver without a fleet → NetRide keeps the whole platform pool', () => {
  const split = computeRevenueSplit(10000, null, DEFAULT_REVENUE_CONFIG, [FLEET_A, FLEET_B]);
  assert.equal(split.driverShareCents, 6000);
  assert.deepEqual(split.fleetShares, []);
  assert.equal(split.netrideShareCents, 4000);
});

test('revenue: disabled fleet gets nothing (driver treated as platform-direct)', () => {
  const split = computeRevenueSplit(10000, 'fleet-off', DEFAULT_REVENUE_CONFIG, [FLEET_OFF, FLEET_A]);
  assert.deepEqual(split.fleetShares, []);
  assert.equal(split.netrideShareCents, 4000);
});

test('revenue: config with invalid sum falls back to the locked 60/40', () => {
  const bad = { driverSharePercent: 50, platformSharePercent: 45 };
  const split = computeRevenueSplit(10000, 'fleet-a', bad, [FLEET_A]);
  assert.equal(split.driverSharePercent, 60);
  assert.equal(split.platformSharePercent, 40);
  assert.equal(split.driverShareCents, 6000);
});

test('revenue: any config summing to 100 is honored (admin may rebalance)', () => {
  const rebalanced = { driverSharePercent: 50, platformSharePercent: 50 };
  const split = computeRevenueSplit(10000, null, rebalanced, []);
  assert.equal(split.driverSharePercent, 50);
  assert.equal(split.driverShareCents, 5000);
  assert.equal(split.netrideShareCents, 5000);
});

test('revenue: cent-exact invariant on odd amounts', () => {
  const fare = 1001; // $10.01
  const split = computeRevenueSplit(fare, 'fleet-a', DEFAULT_REVENUE_CONFIG, [FLEET_A]);
  // driver = round(1001×0.6) = 601; platform = 400; fleet = round(400×0.5) = 200; netride = 200
  assert.equal(split.driverShareCents, 601);
  assert.equal(split.platformShareCents, 400);
  assert.equal(split.fleetShares[0].cents, 200);
  assert.equal(split.netrideShareCents, 200);
  const sum = split.driverShareCents
    + split.fleetShares.reduce((a, f) => a + f.cents, 0)
    + split.netrideShareCents;
  assert.equal(sum, fare);
});

test('revenue: invariant holds across a sweep of fares and shares', () => {
  const fleets = [
    { id: 'a', name: 'A', platformSharePercent: 33.33, isActive: true },
    { id: 'b', name: 'B', platformSharePercent: 66.67, isActive: true },
  ];
  for (let fare = 1; fare <= 500; fare++) {
    const split = computeRevenueSplit(fare, 'a', DEFAULT_REVENUE_CONFIG, fleets);
    const sum = split.driverShareCents
      + split.fleetShares.reduce((acc, f) => acc + f.cents, 0)
      + split.netrideShareCents;
    assert.equal(sum, fare, `invariant broken at ${fare}¢`);
  }
});

test('revenue: deterministic — identical inputs yield identical outputs', () => {
  const a = computeRevenueSplit(12345, 'fleet-b', DEFAULT_REVENUE_CONFIG, [FLEET_A, FLEET_B]);
  const b = computeRevenueSplit(12345, 'fleet-b', DEFAULT_REVENUE_CONFIG, [FLEET_A, FLEET_B]);
  assert.deepEqual(a, b);
});
