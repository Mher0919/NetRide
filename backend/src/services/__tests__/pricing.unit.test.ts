// backend/src/services/__tests__/pricing.unit.test.ts
//
// Unit tests for the central pricing engine. Pure functions only — no
// network, no Redis, no DB — so they run in CI in milliseconds.

import test from 'node:test';
import assert from 'node:assert/strict';

import { computeFare, DEFAULT_PRICING_CONFIG } from '../pricing.service';

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

const PEAK_MARKET = {
  ...NEUTRAL_MARKET,
  demandMultiplier: 1.5,
  timeMultiplier: 1.25,
  reasons: ['High demand', 'Peak time'],
};

test('computeFare is deterministic and itemized at neutral multiplier', () => {
  const fare = computeFare(
    { distanceMeters: 5000, durationSeconds: 600 },
    DEFAULT_PRICING_CONFIG,
    NEUTRAL_MARKET,
  );
  // base 3.50 + distance 5km*1.50=7.50 + time 10min*0.35=3.50 = 14.50
  // + booking 1.50 = 16.00; service 10% = 1.60; taxes 8.75% of 17.60 = 1.54
  // total = 19.14
  assert.ok(Math.abs(fare.totalFare - 19.14) < 0.02, `total=${fare.totalFare}`);
  assert.equal(fare.surgeMultiplier, 1.0);
  assert.equal(fare.currency, 'USD');
});

test('computeFare applies the combined demand × time multiplier', () => {
  const base = computeFare({ distanceMeters: 10000, durationSeconds: 1200 }, DEFAULT_PRICING_CONFIG, NEUTRAL_MARKET);
  const peak = computeFare({ distanceMeters: 10000, durationSeconds: 1200 }, DEFAULT_PRICING_CONFIG, PEAK_MARKET);
  assert.ok(peak.totalFare > base.totalFare, 'peak fare must exceed neutral fare');
  assert.ok(Math.abs(peak.surgeMultiplier - 1.875) < 0.01, `surge=${peak.surgeMultiplier}`);
});

test('computeFare clamps the multiplier to max_demand_multiplier', () => {
  const extreme = {
    ...PEAK_MARKET,
    demandMultiplier: 2.0,
    timeMultiplier: 2.0,
  };
  const fare = computeFare({ distanceMeters: 10000, durationSeconds: 1200 }, DEFAULT_PRICING_CONFIG, extreme);
  assert.equal(fare.surgeMultiplier, DEFAULT_PRICING_CONFIG.max_demand_multiplier);
});

test('computeFare respects the minimum fare', () => {
  const fare = computeFare({ distanceMeters: 10, durationSeconds: 5 }, DEFAULT_PRICING_CONFIG, NEUTRAL_MARKET);
  assert.ok(fare.totalFare >= DEFAULT_PRICING_CONFIG.minimum_fare);
});

test('computeFare carries explainable multiplier reasons', () => {
  const fare = computeFare({ distanceMeters: 3000, durationSeconds: 300 }, DEFAULT_PRICING_CONFIG, PEAK_MARKET);
  assert.ok(fare.multiplierBreakdown.reasons.length > 0);
  assert.equal(fare.multiplierBreakdown.demandMultiplier, 1.5);
  assert.equal(fare.multiplierBreakdown.timeMultiplier, 1.25);
});

test('computeFare respects custom configuration', () => {
  const config = {
    ...DEFAULT_PRICING_CONFIG,
    base_fare: 5.00,
    per_km_rate: 2.00,
    minimum_fare: 10.00,
  };
  const fare = computeFare({ distanceMeters: 1000, durationSeconds: 60 }, config, NEUTRAL_MARKET);
  assert.equal(fare.baseFare, 5.00);
  assert.equal(fare.distanceFare, 2.00);
  assert.equal(fare.timeFare, 0.35);
});

test('computeFare runs in microseconds (no I/O)', () => {
  const start = process.hrtime.bigint();
  for (let i = 0; i < 1000; i++) {
    computeFare({ distanceMeters: 3000, durationSeconds: 300 }, DEFAULT_PRICING_CONFIG, NEUTRAL_MARKET);
  }
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(ms < 50, `1000 fares took ${ms.toFixed(2)}ms`);
});
