// backend/src/modules/location/__tests__/location-freshness.unit.test.ts
//
// Unit tests for the location freshness model. Stale positions must never
// be treated as live: the previous system inferred freshness from the
// heartbeat TTL, so an old coordinate was gated into pickup/complete
// proximity checks and ETAs as if it were current.

import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateLocationFreshness } from '../locations.service';

const NOW = 1_700_000_000_000; // fixed epoch ms

test('freshness: a just-recorded fix is fresh', () => {
  const r = evaluateLocationFreshness(NOW, NOW, 60);
  assert.equal(r.fresh, true);
  assert.equal(r.ageSeconds, 0);
});

test('freshness: a fix exactly at the threshold is still fresh', () => {
  const r = evaluateLocationFreshness(NOW - 60_000, NOW, 60);
  assert.equal(r.fresh, true);
  assert.equal(r.ageSeconds, 60);
});

test('freshness: one millisecond past the threshold is stale', () => {
  const r = evaluateLocationFreshness(NOW - 60_001, NOW, 60);
  assert.equal(r.fresh, false);
  assert.equal(r.ageSeconds, 60.001);
});

test('freshness: missing / zero / invalid timestamps are never fresh', () => {
  for (const ts of [null, undefined, 0, -1, NaN, Infinity]) {
    const r = evaluateLocationFreshness(ts as any, NOW, 60);
    assert.equal(r.fresh, false, `timestamp ${String(ts)} must not be fresh`);
    assert.equal(r.ageSeconds, null);
  }
});

test('freshness: a future timestamp (clock skew) is treated as age 0', () => {
  const r = evaluateLocationFreshness(NOW + 5_000, NOW, 60);
  assert.equal(r.fresh, true);
  assert.equal(r.ageSeconds, 0);
});

test('freshness: a 10-minute-old fix is stale for a 60s budget', () => {
  const r = evaluateLocationFreshness(NOW - 600_000, NOW, 60);
  assert.equal(r.fresh, false);
  assert.equal(r.ageSeconds, 600);
});
