// backend/src/services/__tests__/ride-rejection.unit.test.ts
//
// Unit tests for the driver ride-request rejection rule:
//
//   DRIVER REJECTED ride R  →  R never offered to that driver again
//   (while R stays offerable to every other eligible driver)
//
// The dispatch pipeline applies the rule through ONE pure helper
// (RideRejectionService.excludeRejected) so every path — the exclusive
// offer engine, the legacy fan-out job, and per-offer re-validation —
// shares the same exclusion semantics. DB-backed persistence (idempotent
// upsert on the (ride_id, driver_id) pair) is asserted as a SQL contract
// so the "double decline collapses to one record" guarantee cannot regress.
//
// Registered in backend/run-tests.cjs.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RideRejectionService,
  REJECTION_STATUS,
  RECORD_REJECTION_SQL,
  REJECTED_DRIVER_IDS_SQL,
  HAS_REJECTED_SQL,
} from '../ride-rejection.service';

// --- Pure exclusion rule (used by filterEligible + dispatchOffer) ----------

test('excludeRejected: rejected driver is never re-offered the ride', () => {
  const candidates = [
    { id: 'driver-a', score: 1 },
    { id: 'driver-b', score: 2 },
    { id: 'driver-c', score: 3 },
  ];
  const rejected = new Set(['driver-b']);

  const result = RideRejectionService.excludeRejected(candidates, rejected);

  assert.deepEqual(result.map(d => d.id), ['driver-a', 'driver-c']);
});

test('excludeRejected: other drivers stay in the pool after a rejection', () => {
  // R1 rejected by A and B → A and B excluded, C still eligible.
  const candidates = [
    { id: 'A' },
    { id: 'B' },
    { id: 'C' },
  ];
  const rejected = new Set(['A', 'B']);

  const result = RideRejectionService.excludeRejected(candidates, rejected);
  assert.deepEqual(result.map(d => d.id), ['C']);
});

test('excludeRejected: no rejections → candidate pool untouched', () => {
  const candidates = [{ id: 'A' }, { id: 'B' }];
  const result = RideRejectionService.excludeRejected(candidates, new Set());
  assert.equal(result.length, 2);
});

test('excludeRejected: every driver rejected → empty pool', () => {
  const candidates = [{ id: 'A' }, { id: 'B' }];
  const result = RideRejectionService.excludeRejected(candidates, new Set(['A', 'B']));
  assert.equal(result.length, 0);
});

test('excludeRejected: empty candidate list → empty result', () => {
  const result = RideRejectionService.excludeRejected([], new Set(['A']));
  assert.equal(result.length, 0);
});

// --- Persistence contract ---------------------------------------------------

test('recordRejection: idempotent upsert keyed on (ride_id, driver_id)', () => {
  // The (ride_id, driver_id) pair IS the primary key of the table (migration
  // 20260816), so a conflict means "this driver already rejected this ride" —
  // and the upsert must collapse into that same row instead of duplicating.
  assert.ok(
    RECORD_REJECTION_SQL.replace(/\s+/g, ' ')
      .trim()
      .startsWith('INSERT INTO ride_driver_rejections (ride_id, driver_id, status, rejected_at)'),
  );
  assert.ok(RECORD_REJECTION_SQL.includes('ON CONFLICT (ride_id, driver_id)'));
  assert.ok(RECORD_REJECTION_SQL.includes('DO UPDATE'));
  // Recording always stamps the REJECTED status (the single driver-specific
  // state; ride-wide cancellation is a separate terminal ride state).
  assert.equal(REJECTION_STATUS, 'REJECTED');
  assert.ok(RECORD_REJECTION_SQL.includes(`VALUES ($1, $2, $3, NOW())`));
});

test('rejectedDriverIds / hasRejected: scoped strictly to the (ride, driver) pair', () => {
  // Both lookups must filter by ride_id so one ride's rejections never
  // bleed into another ride's candidate pool.
  assert.ok(/WHERE ride_id = \$\d+/.test(REJECTED_DRIVER_IDS_SQL));
  assert.ok(/WHERE ride_id = \$\d+ AND driver_id = \$\d+/.test(HAS_REJECTED_SQL));
  // Sanity: the reversal test above cannot silently pass on a stale constant.
  assert.ok(!/driver = \$\d+ AND ride_id = \$\d+/.test(HAS_REJECTED_SQL));
});
