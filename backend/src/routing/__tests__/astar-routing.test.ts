// backend/src/routing/__tests__/astar-routing.test.ts
//
// Unit tests for the A* routing engine components.
// Tests graph building, geometry encoding, ETA calculation, caching,
// and road snapping.

import test from 'node:test';
import assert from 'node:assert/strict';
import { encodePolyline, decodePolyline, simplifyPolyline, haversineMeters, polylineDistance } from '../utils/geometry';
import { calculateETA, simpleETA } from '../utils/eta';
import { LRUCache, RouteCache } from '../utils/cache';
import { RoadClass, ROAD_CLASS_SPEEDS } from '../graph/types';

// ---- Polyline Encoding/Decoding ------------------------------------------

test('encodePolyline produces a non-empty string', () => {
  const coords: Array<[number, number]> = [
    [34.0522, -118.2437],
    [34.0523, -118.2438],
  ];
  const encoded = encodePolyline(coords);
  assert.ok(typeof encoded === 'string' && encoded.length > 0);
});

test('decodePolyline reverses encodePolyline', () => {
  const original: Array<[number, number]> = [
    [34.0522, -118.2437],
    [34.0907, -118.2740],
    [34.0195, -118.4912],
  ];
  const decoded = decodePolyline(encodePolyline(original));
  assert.equal(decoded.length, original.length);
  for (let i = 0; i < original.length; i++) {
    assert.ok(Math.abs(decoded[i][0] - original[i][0]) < 0.0001);
    assert.ok(Math.abs(decoded[i][1] - original[i][1]) < 0.0001);
  }
});

test('decodePolyline handles empty string', () => {
  const decoded = decodePolyline('');
  assert.equal(decoded.length, 0);
});

test('simplifyPolyline reduces point count', () => {
  const coords: Array<[number, number]> = [
    [34.05, -118.24],
    [34.05001, -118.24001],
    [34.06, -118.25],
    [34.07, -118.26],
  ];
  const simplified = simplifyPolyline(coords);
  assert.ok(simplified.length <= coords.length);
});

// ---- Haversine Distance --------------------------------------------------

test('haversineMeters returns correct distance', () => {
  const d = haversineMeters([34.0522, -118.2437], [34.0907, -118.2740]);
  assert.ok(d > 3000 && d < 6000);
});

test('haversineMeters returns 0 for same point', () => {
  const d = haversineMeters([34.0522, -118.2437], [34.0522, -118.2437]);
  assert.equal(d, 0);
});

test('haversineMeters is symmetric', () => {
  const a: [number, number] = [34.0522, -118.2437];
  const b: [number, number] = [34.0907, -118.2740];
  assert.ok(Math.abs(haversineMeters(a, b) - haversineMeters(b, a)) < 1);
});

test('polylineDistance sums segment distances', () => {
  const coords: Array<[number, number]> = [
    [34.0522, -118.2437],
    [34.06, -118.25],
    [34.07, -118.26],
  ];
  const total = polylineDistance(coords);
  assert.ok(total > 0);
});

// ---- ETA Calculation -----------------------------------------------------

test('calculateETA returns reasonable duration', () => {
  const result = calculateETA({
    distanceMeters: 5000,
    roadClass: RoadClass.SECONDARY,
  });
  assert.ok(result.durationSeconds > 60 && result.durationSeconds < 600);
  assert.ok(result.averageSpeedMph > 5 && result.averageSpeedMph < 100);
});

test('calculateETA applies congestion factor', () => {
  const rushHour = calculateETA({
    distanceMeters: 5000,
    roadClass: RoadClass.PRIMARY,
    timeOfDay: 8,
    dayOfWeek: 3,
  });
  const freeFlow = calculateETA({
    distanceMeters: 5000,
    roadClass: RoadClass.PRIMARY,
    timeOfDay: 3,
    dayOfWeek: 3,
  });
  assert.ok(rushHour.durationSeconds > freeFlow.durationSeconds);
});

test('calculateETA applies turn penalties', () => {
  const noTurns = calculateETA({
    distanceMeters: 5000,
    roadClass: RoadClass.PRIMARY,
    turnCount: 0,
  });
  const withTurns = calculateETA({
    distanceMeters: 5000,
    roadClass: RoadClass.PRIMARY,
    turnCount: 5,
  });
  assert.ok(withTurns.durationSeconds > noTurns.durationSeconds);
});

test('simpleETA returns reasonable duration', () => {
  const seconds = simpleETA(5000, RoadClass.PRIMARY);
  assert.ok(seconds > 60 && seconds < 600);
});

test('motorway ETA is faster than residential for same distance', () => {
  const motorway = simpleETA(5000, RoadClass.MOTORWAY);
  const residential = simpleETA(5000, RoadClass.RESIDENTIAL);
  assert.ok(motorway < residential);
});

// ---- Cache ---------------------------------------------------------------

test('LRUCache stores and retrieves values', () => {
  const cache = new LRUCache<string>(100, 60);
  cache.set('key1', 'value1');
  assert.equal(cache.get('key1'), 'value1');
});

test('LRUCache evicts oldest when full', () => {
  const cache = new LRUCache<string>(2, 60);
  cache.set('a', '1');
  cache.set('b', '2');
  cache.set('c', '3');
  assert.equal(cache.get('a'), null);
  assert.equal(cache.get('b'), '2');
  assert.equal(cache.get('c'), '3');
});

test('LRUCache respects TTL', () => {
  const cache = new LRUCache<string>(100, 0);
  cache.set('key1', 'value1');
  assert.equal(cache.get('key1'), null);
});

test('LRUCache tracks size', () => {
  const cache = new LRUCache<string>(100, 60);
  assert.equal(cache.size, 0);
  cache.set('a', '1');
  assert.equal(cache.size, 1);
  cache.set('b', '2');
  assert.equal(cache.size, 2);
});

test('RouteCache stores and retrieves routes', () => {
  const cache = new RouteCache();
  cache.setRoute(34.05, -118.24, 34.09, -118.27, {
    distanceMeters: 5000, durationMs: 300000,
    geometry: [], steps: [], nodePath: [1, 2, 3],
  });
  const result = cache.getRoute(34.05, -118.24, 34.09, -118.27);
  assert.ok(result !== null);
  assert.equal(result!.distanceMeters, 5000);
});

test('RouteCache supports lightweight distance-only caching', () => {
  const cache = new RouteCache();
  cache.setLightweight(34.05, -118.24, 34.09, -118.27, {
    distanceMeters: 5000, durationSeconds: 300,
  });
  const result = cache.getLightweight(34.05, -118.24, 34.09, -118.27);
  assert.ok(result !== null);
  assert.equal(result!.distanceMeters, 5000);
});

test('RouteCache snap node caching works', () => {
  const cache = new RouteCache();
  cache.setSnapNode(34.0522, -118.2437, 42);
  assert.equal(cache.getSnapNode(34.0522, -118.2437), 42);
});

test('RouteCache stats returns correct structure', () => {
  const cache = new RouteCache();
  const stats = cache.stats();
  assert.ok(typeof stats.exact.size === 'number');
  assert.ok(typeof stats.nearby.size === 'number');
  assert.ok(typeof stats.snap.size === 'number');
});

// ---- Road Class Speeds ---------------------------------------------------

test('ROAD_CLASS_SPEEDS has entries for all classes', () => {
  for (let i = 0; i <= RoadClass.UNKNOWN; i++) {
    assert.ok(typeof ROAD_CLASS_SPEEDS[i as RoadClass] === 'number');
    assert.ok(ROAD_CLASS_SPEEDS[i as RoadClass] > 0);
  }
});

test('motorway is fastest, living_street is slowest', () => {
  assert.ok(ROAD_CLASS_SPEEDS[RoadClass.MOTORWAY] > ROAD_CLASS_SPEEDS[RoadClass.RESIDENTIAL]);
  assert.ok(ROAD_CLASS_SPEEDS[RoadClass.RESIDENTIAL] > ROAD_CLASS_SPEEDS[RoadClass.LIVING_STREET]);
});
