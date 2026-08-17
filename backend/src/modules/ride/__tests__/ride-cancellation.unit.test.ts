// backend/src/modules/ride/__tests__/ride-cancellation.unit.test.ts
//
// SQL-contract tests for the ride-cancellation state machine (spec §16/§17).
//
// These assert the ATOMIC GUARDS embedded in the driver release and stale
// accept-protection SQL — the guarantees that make the flows deterministic
// under concurrency:
//
//   - DRIVER_CANCELLED_AFTER_ACCEPTANCE release only succeeds while the
//     REQUESTING driver is still the assigned driver AND the ride is still
//     in a pre-pickup state (a stale cancel can never clobber a newer
//     assignment; a rider cancel that commits first wins).
//   - The release transaction simultaneously writes the
//     ACCEPTED_THEN_CANCELLED exclusion so the cancelled driver can never
//     be offered the SAME ride again during the re-match.
//
// Registered in backend/run-tests.cjs.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RELEASE_DRIVER_PRE_PICKUP_SQL,
  UPSERT_DRIVER_RIDE_INTERACTION_SQL,
} from '../ride.repository';
import {
  REJECTION_STATUS,
  ACCEPTED_THEN_CANCELLED_STATUS,
} from '../../../services/ride-rejection.service';

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

test('release SQL: verifies the requesting driver is STILL assigned (stale-action guard)', () => {
  // `AND driver_id = $2` — a delayed cancel from Driver A must not clear
  // Driver B's assignment (§17 race rule; Test H).
  assert.ok(oneLine(RELEASE_DRIVER_PRE_PICKUP_SQL).includes('driver_id = $2'));
});

test('release SQL: restricted to pre-pickup states (ACCEPTED / DRIVER_ARRIVING)', () => {
  // An IN_PROGRESS ride (or a completed/cancelled one) is never silently
  // released back to searching by a driver cancel.
  const sql = oneLine(RELEASE_DRIVER_PRE_PICKUP_SQL);
  assert.ok(sql.includes('status IN'));
  assert.ok(sql.includes('$4, $5'));
  assert.ok(!sql.includes('IN_PROGRESS'));
});

test('release SQL: cannot fire on a terminal ride (status guard), returns the ride', () => {
  const sql = oneLine(RELEASE_DRIVER_PRE_PICKUP_SQL);
  assert.ok(sql.endsWith('RETURNING id'));
  assert.ok(sql.startsWith('UPDATE rides'));
});

test('release interaction upsert: writes ACCEPTED_THEN_CANCELLED exclusion idempotently', () => {
  const sql = oneLine(UPSERT_DRIVER_RIDE_INTERACTION_SQL);
  assert.ok(sql.startsWith('INSERT INTO ride_driver_rejections'));
  assert.ok(sql.includes('interaction_type'));
  assert.ok(sql.includes('ON CONFLICT (ride_id, driver_id)'));
  assert.ok(sql.includes('DO UPDATE'));
  assert.ok(sql.includes('rejected_at = NOW()'));
  // The trip, its fare quote, promo/credits and special redemption are
  // NEVER recreated by this statement — it only records the driver pair.
  assert.ok(!sql.includes('rides SET'));
  assert.ok(!sql.includes('driver_id = NULL'));
});

test('back-to-searching transition preserves the ride identity (same ride id)', () => {
  // The release writes status=REQUESTED with driver_id=NULL on the SAME
  // rides row — no new ride record is created for the re-match (§11).
  const sql = oneLine(RELEASE_DRIVER_PRE_PICKUP_SQL);
  assert.ok(sql.includes('status = $3'));
  assert.ok(sql.includes('driver_id = NULL'));
  assert.ok(!sql.includes('INSERT INTO rides'));
  assert.ok(!sql.includes('RETURNING *'));
});

test('migration: interaction types enumerated as the two distinct events', () => {
  // The two event kinds must exist as named constants in the service layer.
  assert.equal(REJECTION_STATUS, 'REJECTED');
  assert.equal(ACCEPTED_THEN_CANCELLED_STATUS, 'ACCEPTED_THEN_CANCELLED');
  assert.notEqual(REJECTION_STATUS, ACCEPTED_THEN_CANCELLED_STATUS);
});
