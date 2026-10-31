import test from 'node:test';
import assert from 'node:assert/strict';

import {
  dedupePickupStops,
  matrixKey,
  optimizeStopOrder,
  type MatrixCell,
} from '../../../../../backend/src/modules/groups/group-route.optimizer';

function buildMatrix(
  ids: string[],
  values: Record<string, number>,
  distanceFactor = 100,
): Map<string, MatrixCell> {
  const matrix = new Map<string, MatrixCell>();
  for (const from of ids) {
    for (const to of ids) {
      if (from === to) continue;
      const minutes = values[`${from}>${to}`] ?? 100;
      matrix.set(matrixKey(from, to), {
        durationSeconds: minutes * 60,
        distanceMeters: minutes * distanceFactor,
      });
    }
  }
  return matrix;
}

test('optimizer evaluates the COMPLETE journey, not nearest-next pickup', () => {
  const ids = ['S', 'A', 'B', 'C', 'D'];
  const matrix = buildMatrix(ids, {
    'S>A': 1,
    'A>B': 10,
    'B>C': 10,
    'C>D': 10,
    'S>B': 5,
    'B>A': 1,
    'A>C': 1,
    'B>D': 10,
    'S>C': 20,
    'C>A': 1,
    'A>D': 10,
  });
  const result = optimizeStopOrder({
    startId: 'S',
    destinationId: 'D',
    stops: [
      { key: 'A', passengerIds: ['a'] },
      { key: 'B', passengerIds: ['b'] },
      { key: 'C', passengerIds: ['c'] },
    ],
    matrix,
  });
  assert.ok(result);
  assert.deepEqual(result!.orderedStopKeys, ['B', 'A', 'C']);
  assert.ok(result!.totalDurationSeconds < 31 * 60);
});

test('optimizer keeps the destination fixed as the last stop', () => {
  const ids = ['S', 'A', 'B', 'D'];
  const matrix = buildMatrix(ids, {
    'S>A': 1,
    'A>B': 1,
    'B>D': 1,
    'S>B': 50,
    'B>A': 50,
    'A>D': 50,
  });
  const result = optimizeStopOrder({
    startId: 'S',
    destinationId: 'D',
    stops: [
      { key: 'A', passengerIds: ['a'] },
      { key: 'B', passengerIds: ['b'] },
    ],
    matrix,
  });
  assert.ok(result);
  assert.deepEqual(result!.orderedStopKeys, ['A', 'B']);
  assert.equal(result!.legDurationsSeconds.length, 3);
});

test('optimizer refuses an incomplete matrix instead of inventing a route', () => {
  const matrix = new Map<string, MatrixCell>();
  matrix.set(matrixKey('S', 'A'), { durationSeconds: 60, distanceMeters: 100 });
  const result = optimizeStopOrder({
    startId: 'S',
    destinationId: 'D',
    stops: [{ key: 'A', passengerIds: ['a'] }],
    matrix,
  });
  assert.equal(result, null);
});

test('direct route without pickup stops is supported', () => {
  const matrix = buildMatrix(['S', 'D'], { 'S>D': 7 });
  const result = optimizeStopOrder({
    startId: 'S',
    destinationId: 'D',
    stops: [],
    matrix,
  });
  assert.ok(result);
  assert.deepEqual(result!.orderedStopKeys, []);
  assert.equal(result!.totalDurationSeconds, 7 * 60);
});

test('duplicate pickups merge into one physical stop and keep all passengers', () => {
  const deduped = dedupePickupStops([
    { passengerId: 'a', lat: 34.052211, lng: -118.243711 },
    { passengerId: 'b', lat: 34.052214, lng: -118.243709 },
    { passengerId: 'c', lat: 34.060000, lng: -118.250000 },
  ]);
  assert.equal(deduped.length, 2);
  const first = deduped.find((d) => d.passengerIds.includes('a'))!;
  assert.deepEqual(first.passengerIds.sort(), ['a', 'b']);
});

test('place ids merge even when coordinates differ slightly', () => {
  const deduped = dedupePickupStops([
    { passengerId: 'a', lat: 34.0, lng: -118.0, placeId: 'place-1' },
    { passengerId: 'b', lat: 34.1, lng: -118.1, placeId: 'place-1' },
  ]);
  assert.equal(deduped.length, 1);
  assert.deepEqual(deduped[0].passengerIds.sort(), ['a', 'b']);
});
