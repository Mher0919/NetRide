// backend/src/modules/routing/__tests__/routing.unit.test.ts
//
// Unit tests for the isolated Routing Service. These run with NO network
// and NO Redis by stubbing the dependencies, so they execute in CI /
// pre-commit in milliseconds and assert the core correctness + perf
// contracts from the routing-redesign brief.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCoordinates,
  InvalidCoordinatesError,
  RoutingService,
} from '../routing.service';
import { fareService } from '../../../services/fare.service';
import { VehicleClass } from '../../../types';

// ---- Coordinate validation ----------------------------------------------

test('parseCoordinates accepts a valid [lat,lng] tuple', () => {
  const c = parseCoordinates([34.05, -118.25], 'origin');
  assert.deepEqual(c, [34.05, -118.25]);
});

test('parseCoordinates rejects wrong arity', () => {
  assert.throws(() => parseCoordinates([1, 2, 3], 'origin'), InvalidCoordinatesError);
  assert.throws(() => parseCoordinates('nope', 'origin'), InvalidCoordinatesError);
});

test('parseCoordinates rejects out-of-range lat/lng', () => {
  assert.throws(() => parseCoordinates([91, 0], 'origin'), InvalidCoordinatesError);
  assert.throws(() => parseCoordinates([0, 200], 'origin'), InvalidCoordinatesError);
  assert.throws(() => parseCoordinates([NaN, 0], 'origin'), InvalidCoordinatesError);
});

// ---- Fast fare computation ----------------------------------------------

test('computeFare is deterministic and itemized', () => {
  const fare = fareService.computeFare({
    distanceMeters: 5000,
    durationSeconds: 600,
    vehicleClass: VehicleClass.CORE,
  });
  assert.equal(fare.currency, 'USD');
  // base 3.50 + distance 5km*1.50=7.50 + time 10min*0.35=3.50 + booking 1.50
  // = 16.00; service 10% = 1.60; taxable = 17.60; taxes 8.75% = 1.54
  // total = 17.60 + 1.54 = 19.14
  assert.ok(Math.abs(fare.totalFare - 19.14) < 0.02, `total=${fare.totalFare}`);
  assert.ok(fare.baseFare > 0 && fare.distanceFare > 0 && fare.timeFare > 0);
});

test('computeFare scales by vehicle class', () => {
  const base = fareService.computeFare({ distanceMeters: 10000, durationSeconds: 1200, vehicleClass: VehicleClass.CORE });
  const elite = fareService.computeFare({ distanceMeters: 10000, durationSeconds: 1200, vehicleClass: VehicleClass.ELITE });
  const prestige = fareService.computeFare({ distanceMeters: 10000, durationSeconds: 1200, vehicleClass: VehicleClass.PRESTIGE });
  assert.ok(elite.totalFare > base.totalFare);
  assert.ok(prestige.totalFare > elite.totalFare);
});

test('computeFare respects the minimum fare', () => {
  const fare = fareService.computeFare({ distanceMeters: 10, durationSeconds: 5, vehicleClass: VehicleClass.CORE });
  assert.ok(fare.totalFare >= 7.0);
});

test('computeFare runs in microseconds (no I/O)', () => {
  const start = process.hrtime.bigint();
  for (let i = 0; i < 1000; i++) {
    fareService.computeFare({ distanceMeters: 3000, durationSeconds: 300, vehicleClass: VehicleClass.CORE });
  }
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  // 1000 fares in well under the 5ms budget per single fare x 1000.
  assert.ok(ms < 50, `1000 fares took ${ms.toFixed(2)}ms`);
});

// ---- Synthetic fallback is road-shaped (never a straight 2-point line) --

test('synthetic fallback returns a multi-point road-shaped geometry', async () => {
  // Force the synthetic path by stubbing selectEngine to return a failing
  // engine and disabling cache so the test runs with no network/Redis.
  const svc = RoutingService as any;
  const origSelect = svc.selectEngine;
  const origWrite = svc.withRedisTimeout;
  const origLookup = svc.lookupCache;
  svc.selectEngine = () => ({
    name: 'TestFail',
    route: async () => { throw new Error('offline'); },
  });
  svc.withRedisTimeout = async () => null;
  svc.lookupCache = async () => null;
  try {
    const plan = await RoutingService.plan({
      origin: [34.05, -118.25],
      destination: [34.10, -118.30],
      vehicleClass: VehicleClass.CORE,
    });
    assert.equal(plan.engine, 'Synthetic');
    assert.ok(plan.geometry.coordinates.length >= 3, 'synthetic must bend, not be a 2-point straight line');
    assert.equal(plan.confidence, 0.4);
    assert.ok(plan.fare.totalFare > 0);
  } finally {
    svc.selectEngine = origSelect;
    svc.withRedisTimeout = origWrite;
    svc.lookupCache = origLookup;
  }
});

// ---- In-flight dedupe ----------------------------------------------------

test('identical concurrent plans share one computation', async () => {
  const svc = RoutingService as any;
  let computeCount = 0;
  const origCompute = svc.computeRoute;
  svc.computeRoute = async (...args: any[]) => {
    computeCount++;
    // simulate engine latency so the two calls overlap
    await new Promise((r) => setTimeout(r, 30));
    return origCompute.apply(svc, args);
  };
  // Make cache a no-op so the test isolates the in-flight dedup logic.
  const origLookup = svc.lookupCache;
  svc.lookupCache = async () => null;
  const origWrite = svc.withRedisTimeout;
  svc.withRedisTimeout = async () => null;
  try {
    const [a, b] = await Promise.all([
      RoutingService.plan({ origin: [34.0, -118.2], destination: [34.1, -118.3], vehicleClass: VehicleClass.CORE }),
      RoutingService.plan({ origin: [34.0, -118.2], destination: [34.1, -118.3], vehicleClass: VehicleClass.CORE }),
    ]);
    assert.deepEqual(a.geometry, b.geometry);
    assert.ok(computeCount <= 1, `expected <=1 engine computations, got ${computeCount}`);
  } finally {
    svc.computeRoute = origCompute;
    svc.lookupCache = origLookup;
    svc.withRedisTimeout = origWrite;
  }
});
