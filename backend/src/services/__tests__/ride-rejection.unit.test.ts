// backend/src/services/__tests__/ride-rejection.unit.test.ts
//
// Unit tests for the driver ride-interaction exclusion rule:
//
//   DRIVER REJECTED ride R            →  R never offered to that driver again
//   DRIVER ACCEPTED-THEN-CANCELLED R  →  R never offered to that driver again
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
  ACCEPTED_THEN_CANCELLED_STATUS,
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

test('excludeRejected: every driver excluded → empty pool', () => {
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
  // 20260816), so a conflict means "this driver already interacted with this
  // ride" — and the upsert must collapse into that same row instead of
  // duplicating.
  assert.ok(
    RECORD_REJECTION_SQL.replace(/\s+/g, ' ')
      .trim()
      .startsWith('INSERT INTO ride_driver_rejections'),
  );
  assert.ok(RECORD_REJECTION_SQL.includes('ON CONFLICT (ride_id, driver_id)'));
  assert.ok(RECORD_REJECTION_SQL.includes('DO UPDATE'));
  // Recording always stamps the REJECTED interaction type (the single
  // driver-specific pre-accept state; ride-wide cancellation is a separate
  // terminal ride state). The status/interaction type are the PARAMETRIC
  // values $3/$4 — the same statement writes both event kinds.
  assert.equal(REJECTION_STATUS, 'REJECTED');
  assert.ok(RECORD_REJECTION_SQL.includes(`VALUES ($1, $2, $3, $4, $5, $6, NOW())`));
  assert.notEqual(REJECTION_STATUS, ACCEPTED_THEN_CANCELLED_STATUS);
});

test('recordCancelAfterAcceptance: ACCEPTED_THEN_CANCELLED preserved distinctly', () => {
  // Scenario B (§3.3): a driver who accepted then cancelled must be excluded
  // with the interaction type preserved for analytics — never collapsed into
  // the pre-accept rejection type.
  assert.equal(ACCEPTED_THEN_CANCELLED_STATUS, 'ACCEPTED_THEN_CANCELLED');
  assert.ok(RECORD_REJECTION_SQL.includes('ACCEPTED_THEN_CANCELLED') === false);
  // The upsert stores the interaction type as its own parameter so both
  // types flow through the SAME idempotent exclusion store.
  assert.ok(RECORD_REJECTION_SQL.includes('interaction_type') );
  // Reason fields ride along for the audit trail.
  assert.ok(RECORD_REJECTION_SQL.includes('reason_code'));
  assert.ok(RECORD_REJECTION_SQL.includes('reason_text'));
});

test('rejectedDriverIds / hasRejected: one exclusion set for BOTH interaction types', () => {
  // Both lookups must be scoped strictly to the (ride, driver) pair and must
  // NOT filter by interaction type — for matching purposes REJECTED and
  // ACCEPTED_THEN_CANCELLED are the same exclusion (§12).
  assert.ok(/WHERE ride_id = \$\d+$/.test(REJECTED_DRIVER_IDS_SQL.trim()));
  assert.ok(/WHERE ride_id = \$\d+ AND driver_id = \$\d+/.test(HAS_REJECTED_SQL));
  assert.ok(!HAS_REJECTED_SQL.includes('status'));
  assert.ok(!REJECTED_DRIVER_IDS_SQL.includes('status'));
});

test('excludeRejected: accepted-then-cancelled drivers are excluded like rejecters', () => {
  // Simulates the state rejectedDriverIds() returns for a ride where Driver
  // A cancelled after acceptance (ACCEPTED_THEN_CANCELLED) and Driver B
  // rejected earlier (REJECTED): both sets are identical for matching.
  const interactionDrivers = new Set(['A', 'B']);
  const candidates = [{ id: 'A' }, { id: 'B' }, { id: 'C' }];

  const result = RideRejectionService.excludeRejected(candidates, interactionDrivers);
  assert.deepEqual(result.map(d => d.id), ['C']);
});
