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
import { computeEstimate } from '../../../services/pricing.service';
import { GoogleRoutesEngine } from '../google-routes.engine';
import { RouteStoreService } from '../../../services/route-store.service';

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

test('computeEstimate is deterministic and itemized', () => {
  const fare = computeEstimate({
    distanceMeters: 5000,
    durationSeconds: 600,
  });
  assert.equal(fare.currency, 'USD');
  // base 3.50 + distance 5km*1.50=7.50 + time 10min*0.35=3.50 + booking 1.50
  // = 16.00; service 10% = 1.60; taxable = 17.60; taxes 8.75% = 1.54
  // total = 17.60 + 1.54 = 19.14
  assert.ok(Math.abs(fare.totalFare - 19.14) < 0.02, `total=${fare.totalFare}`);
  assert.ok(fare.baseFare > 0 && fare.distanceFare > 0 && fare.timeFare > 0);
});

test('computeEstimate respects the minimum fare', () => {
  const fare = computeEstimate({ distanceMeters: 10, durationSeconds: 5 });
  assert.ok(fare.totalFare >= 7.0);
});

test('computeEstimate runs in microseconds (no I/O)', () => {
  const start = process.hrtime.bigint();
  for (let i = 0; i < 1000; i++) {
    computeEstimate({ distanceMeters: 3000, durationSeconds: 300 });
  }
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  // 1000 fares in well under the 5ms budget per single fare x 1000.
  assert.ok(ms < 50, `1000 fares took ${ms.toFixed(2)}ms`);
});

// ---- Synthetic fallback is road-shaped (never a straight 2-point line) --

test('synthetic fallback returns a multi-point road-shaped geometry', async () => {
  // Force the synthetic path: the engine fails and the OD cache is empty.
  const svc = RoutingService as any;
  const origRoute = GoogleRoutesEngine.route;
  const origLookup = RouteStoreService.findOdcache;
  const origSave = RouteStoreService.saveOdcache;
  GoogleRoutesEngine.route = async () => { throw new Error('offline'); };
  RouteStoreService.findOdcache = async () => null;
  RouteStoreService.saveOdcache = async () => {};
  try {
    const plan = await RoutingService.plan({
      origin: [34.05, -118.25],
      destination: [34.10, -118.30],
    });
    assert.equal(plan.engine, 'Synthetic');
    assert.ok(plan.geometry.coordinates.length >= 3, 'synthetic must bend, not be a 2-point straight line');
    assert.equal(plan.confidence, 0.4);
    assert.ok(plan.fare.totalFare > 0);
  } finally {
    GoogleRoutesEngine.route = origRoute;
    RouteStoreService.findOdcache = origLookup;
    RouteStoreService.saveOdcache = origSave;
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
  // Empty OD cache + failing engine so the test runs with no network/DB.
  const origLookup = RouteStoreService.findOdcache;
  const origRoute = GoogleRoutesEngine.route;
  const origSave = RouteStoreService.saveOdcache;
  RouteStoreService.findOdcache = async () => null;
  GoogleRoutesEngine.route = async () => { throw new Error('offline'); };
  RouteStoreService.saveOdcache = async () => {};
  try {
    const [a, b] = await Promise.all([
      RoutingService.plan({ origin: [34.0, -118.2], destination: [34.1, -118.3] }),
      RoutingService.plan({ origin: [34.0, -118.2], destination: [34.1, -118.3] }),
    ]);
    assert.deepEqual(a.geometry, b.geometry);
    assert.ok(computeCount <= 1, `expected <=1 engine computations, got ${computeCount}`);
  } finally {
    svc.computeRoute = origCompute;
    RouteStoreService.findOdcache = origLookup;
    GoogleRoutesEngine.route = origRoute;
    RouteStoreService.saveOdcache = origSave;
  }
});
