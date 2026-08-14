// backend/src/modules/heatmap/__tests__/demand.unit.test.ts
//
// Pure unit tests for the demand heatmap aggregation + scoring model.
// No network, no DB, no Redis — just the math that turns real rider
// activity into driver-facing zones.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_DEMAND_CONFIG,
  DemandConfig,
  ActivityRow,
  decayWeight,
  eventAgeMinutes,
  aggregateCells,
  mergeCells,
  buildZones,
  haversineMeters,
} from '../../../services/demand.model';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = new Date('2026-08-11T12:00:00Z');

function row(over: Partial<ActivityRow> & { rider_id: string; lat: number; lng: number }): ActivityRow {
  return {
    trip_id: null,
    activity_type: 'APP_OPEN',
    cell_h3: 'c0',
    created_at: NOW,
    ...over,
  };
}

function cell(cell: string): DemandConfig {
  return { ...DEFAULT_DEMAND_CONFIG, h3Resolution: 7 };
}

// ---------------------------------------------------------------------------
// decayWeight — piecewise-linear time decay
// ---------------------------------------------------------------------------

test('decayWeight: newest events score full weight', () => {
  assert.equal(decayWeight(0), 1.0);
  assert.equal(decayWeight(2), 1.0);
});

test('decayWeight: interpolates linearly between buckets', () => {
  // 5m → 1.0, 15m → 0.75: at 10m expect 0.875
  assert.equal(decayWeight(10), 0.875);
  // 15m → 0.75, 30m → 0.45: at 22.5m expect 0.60
  assert.equal(decayWeight(22.5), 0.60);
});

test('decayWeight: hits the bucket anchors exactly', () => {
  assert.equal(decayWeight(5), 1.0);
  assert.equal(decayWeight(15), 0.75);
  assert.equal(decayWeight(30), 0.45);
  assert.equal(decayWeight(60), 0.0);
});

test('decayWeight: past the window decays to zero', () => {
  assert.equal(decayWeight(61), 0.0);
  assert.equal(decayWeight(600), 0.0);
});

test('decayWeight: negative age clamps to zero (defensive)', () => {
  assert.equal(decayWeight(-5), 0.0);
});

test('eventAgeMinutes: computes age and clamps below zero', () => {
  assert.equal(eventAgeMinutes(new Date(NOW.getTime() - 10 * 60_000), NOW), 10);
  assert.equal(eventAgeMinutes(new Date(NOW.getTime() + 5 * 60_000), NOW), 0);
});

// ---------------------------------------------------------------------------
// aggregateCells — per-rider max in cell, weighted by type × decay
// ---------------------------------------------------------------------------

test('aggregateCells: one rider one event → cell weight = weight(type) × decay', () => {
  const cells = aggregateCells([
    row({ rider_id: 'u1', activity_type: 'RIDE_REQUESTED', cell_h3: 'A', lat: 1, lng: 1 }),
  ], cell('A'), NOW);
  assert.equal(cells.length, 1);
  assert.equal(cells[0].weight, 1.6); // RIDE_REQUESTED weight
  assert.equal(cells[0].riders, 1);
});

test('aggregateCells: same rider geysering events counts only their max', () => {
  const cells = aggregateCells([
    row({ rider_id: 'u1', activity_type: 'APP_OPEN', cell_h3: 'A', lat: 1, lng: 1 }),
    row({ rider_id: 'u1', activity_type: 'APP_OPEN', cell_h3: 'A', lat: 1, lng: 1 }),
    row({ rider_id: 'u1', activity_type: 'APP_OPEN', cell_h3: 'A', lat: 1, lng: 1 }),
  ], cell('A'), NOW);
  assert.equal(cells[0].riders, 1);
  assert.equal(cells[0].weight, 0.6); // max, not 1.8
});

test('aggregateCells: two riders in one cell sum their maxima', () => {
  const cells = aggregateCells([
    row({ rider_id: 'u1', activity_type: 'RIDE_REQUESTED', cell_h3: 'A', lat: 1, lng: 1 }),
    row({ rider_id: 'u2', activity_type: 'APP_OPEN', cell_h3: 'A', lat: 1, lng: 1 }),
    row({ rider_id: 'u2', activity_type: 'APP_OPEN', cell_h3: 'A', lat: 1, lng: 1 }),
  ], cell('A'), NOW);
  assert.equal(cells.length, 1);
  assert.equal(cells[0].riders, 2);
  assert.equal(cells[0].weight, 1.6 + 0.6);
});

test('aggregateCells: stale events (past window) are excluded', () => {
  const cells = aggregateCells([
    row({
      rider_id: 'u1',
      activity_type: 'RIDE_REQUESTED',
      cell_h3: 'A',
      lat: 1,
      lng: 1,
      created_at: new Date(NOW.getTime() - 90 * 60_000),
    }),
  ], cell('A'), NOW);
  assert.equal(cells.length, 0);
});

test('aggregateCells: distinct cells are not merged by aggregation', () => {
  const cells = aggregateCells([
    row({ rider_id: 'u1', activity_type: 'APP_OPEN', cell_h3: 'A', lat: 1, lng: 1 }),
    row({ rider_id: 'u2', activity_type: 'APP_OPEN', cell_h3: 'B', lat: 2, lng: 2 }),
  ], cell('A'), NOW);
  assert.equal(cells.length, 2);
});

test('aggregateCells: one rider across two cells counts once (moved rider → one heat point)', () => {
  const cells = aggregateCells([
    row({
      rider_id: 'u1',
      activity_type: 'APP_OPEN',
      cell_h3: 'A',
      lat: 1,
      lng: 1,
      created_at: new Date(NOW.getTime() - 20 * 60_000),
    }),
    row({
      rider_id: 'u1',
      activity_type: 'APP_OPEN',
      cell_h3: 'B',
      lat: 2,
      lng: 2,
      created_at: NOW,
    }),
  ], cell('A'), NOW);
  // Newer (fresher = stronger weight) cell wins; the rider never splits.
  assert.equal(cells.length, 1);
  assert.equal(cells[0].cell, 'B');
  assert.equal(cells[0].riders, 1);
});

test('aggregateCells: same-weight cells tie-break to the NEWEST location', () => {
  const cells = aggregateCells([
    row({ rider_id: 'u1', activity_type: 'APP_OPEN', cell_h3: 'A', lat: 1, lng: 1 }),
    row({
      rider_id: 'u1',
      activity_type: 'APP_OPEN',
      cell_h3: 'B',
      lat: 2,
      lng: 2,
      created_at: new Date(NOW.getTime() + 5 * 60_000),
    }),
  ], cell('A'), NOW);
  assert.equal(cells.length, 1);
  assert.equal(cells[0].cell, 'B');
});

test('aggregateCells: centroid is weighted toward stronger points', () => {
  const cells = aggregateCells([
    row({ rider_id: 'u1', activity_type: 'APP_OPEN', cell_h3: 'A', lat: 10, lng: 10 }),
    row({ rider_id: 'u2', activity_type: 'RIDE_REQUESTED', cell_h3: 'A', lat: 11, lng: 11 }),
  ], cell('A'), NOW);
  // Weighted centroid pulls toward the 1.6-weighted point at (11,11).
  const centroidLat = (10 * 0.6 + 11 * 1.6) / 2.2;
  assert.ok(Math.abs(cells[0].lat - centroidLat) < 1e-9);
});

// ---------------------------------------------------------------------------
// mergeCells — greedy nearest-pair merging with weighted centroids
// ---------------------------------------------------------------------------

test('mergeCells: no-op when under the cap', () => {
  const cells = [1, 2, 3].map((i) => ({
    cell: `c${i}`, lat: i, lng: i, weight: 1, riders: 1, pointCount: 1,
  }));
  const merged = mergeCells(cells, 10);
  assert.equal(merged.length, 3);
});

test('mergeCells: merges down to the cap', () => {
  const cells = [1, 2, 3, 4, 5, 6].map((i) => ({
    cell: `c${i}`, lat: i, lng: i, weight: 1, riders: 1, pointCount: 1,
  }));
  const merged = mergeCells(cells, 3);
  assert.equal(merged.length, 3);
  // Weighted centroid of all six (equal weights) = mean.
  assert.ok(Math.abs(merged[0].lat - 3.5) < 1e-9 || merged.some((m) => Math.abs(m.lat - 3.5) < 1e-9));
});

test('mergeCells: weights accumulate across merges', () => {
  const cells = [
    { cell: 'a', lat: 0, lng: 0, weight: 3, riders: 3, pointCount: 3 },
    { cell: 'b', lat: 0.01, lng: 0.01, weight: 1, riders: 1, pointCount: 1 },
    { cell: 'c', lat: 50, lng: 50, weight: 1, riders: 1, pointCount: 1 },
  ];
  const merged = mergeCells(cells, 2);
  assert.equal(merged.length, 2);
  // a+b merged (nearest pair) → weight 4
  const ab = merged.find((m) => m.weight === 4);
  assert.ok(ab, 'merged cell keeps the summed weight');
  assert.equal(ab!.riders, 4);
});

// ---------------------------------------------------------------------------
// buildZones — normalization, radius clamping, score floor, sorting
// ---------------------------------------------------------------------------

test('buildZones: empty input → empty output', () => {
  assert.deepEqual(buildZones([]), []);
});

test('buildZones: relative scores normalized to the busiest cell = 1.0', () => {
  const cells = [
    { cell: 'A', lat: 0, lng: 0, weight: 8, riders: 5, pointCount: 5 },
    { cell: 'B', lat: 1, lng: 1, weight: 4, riders: 2, pointCount: 2 },
  ];
  const zones = buildZones(cells);
  assert.equal(zones.length, 2);
  assert.equal(zones[0].score, 1.0);
  assert.equal(zones[1].score, 0.5);
  assert.ok(zones[0].radiusM >= zones[1].radiusM, 'busier cell gets the bigger radius');
});

test('buildZones: radius clamped to [min, max]', () => {
  const cells = [
    { cell: 'A', lat: 0, lng: 0, weight: 100, riders: 10, pointCount: 10 },
    { cell: 'B', lat: 1, lng: 1, weight: 100, riders: 10, pointCount: 10 },
  ];
  const zones = buildZones(cells);
  for (const z of zones) {
    assert.ok(z.radiusM >= DEFAULT_DEMAND_CONFIG.minRadiusMeters);
    assert.ok(z.radiusM <= DEFAULT_DEMAND_CONFIG.maxRadiusMeters);
  }
  // Equal weights → identical radius; the busiest normalized score (1.0)
  // saturates the sqrt curve at maxRadiusMeters.
  assert.equal(zones[0].radiusM, zones[1].radiusM);
  assert.equal(zones[0].radiusM, DEFAULT_DEMAND_CONFIG.maxRadiusMeters);
});

test('buildZones: minZoneScore drops weak cells', () => {
  const cells = [
    { cell: 'A', lat: 0, lng: 0, weight: 10, riders: 6, pointCount: 6 },
    { cell: 'B', lat: 1, lng: 1, weight: 0.2, riders: 1, pointCount: 1 },
  ];
  const zones = buildZones(cells);
  assert.equal(zones.length, 1);
  assert.equal(zones[0].lat, 0);
  assert.equal(zones[0].lng, 0);
  assert.equal(zones[0].riders, 6);
});

test('buildZones: sorted busiest-first', () => {
  const cells = [5, 1, 3, 9].map((w, i) => ({
    cell: `c${i}`, lat: i, lng: i, weight: w, riders: w, pointCount: w,
  }));
  const zones = buildZones(cells);
  const scores = zones.map((z) => z.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
});

// ---------------------------------------------------------------------------
// Sanity: distance helper used by merge ordering
// ---------------------------------------------------------------------------

test('haversineMeters: known distance (1 degree lat ≈ 111 km)', () => {
  const d = haversineMeters(0, 0, 1, 0);
  assert.ok(Math.abs(d - 111195) < 500);
});