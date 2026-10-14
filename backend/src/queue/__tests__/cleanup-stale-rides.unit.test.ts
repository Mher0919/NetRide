// backend/src/queue/__tests__/cleanup-stale-rides.unit.test.ts
//
// Watchdog scope tests. Regression target: the REQUESTED sweep previously
// had no `is_scheduled` exclusion, so any future scheduled ride older than
// 10 minutes was cancelled on the next tick. The predicates are pure so
// the exact scope — including the scheduled exclusion and the journey-only
// anchor — is pinned here.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildStaleRequestedWhere,
  buildNeverStartedWhere,
  buildOverdueWhere,
} from '../jobs/cleanupStaleRides';

const CUTOFF = new Date('2026-10-13T12:00:00.000Z');

test('REQUESTED sweep: excludes rides that are neither scheduled nor stale-by-schedule', () => {
  const where = buildStaleRequestedWhere(CUTOFF);
  assert.equal(where.status, 'REQUESTED');
  assert.deepEqual(where.created_at, { lt: CUTOFF });
  assert.ok(Array.isArray(where.OR));
  const or = where.OR as any[];
  // Non-scheduled rides (false / null) are always candidates…
  assert.ok(or.some((c) => c.is_scheduled === false));
  assert.ok(or.some((c) => c.is_scheduled === null));
  // …but a scheduled ride is only a candidate once its pickup time has
  // passed the same cutoff.
  assert.ok(or.some((c) => c.scheduled_at && c.scheduled_at.lt === CUTOFF));
});

test('never-started sweep: only ACCEPTED/DRIVER_ARRIVING with no started_at', () => {
  const where = buildNeverStartedWhere(CUTOFF);
  assert.deepEqual(where.status.in, ['ACCEPTED', 'DRIVER_ARRIVING']);
  assert.equal(where.started_at, null);
  assert.deepEqual(where.accepted_at, { lt: CUTOFF });
});

test('overdue sweep: anchors on started_at only (never accepted_at)', () => {
  const where = buildOverdueWhere(CUTOFF);
  assert.deepEqual(where.status.in, ['DRIVER_ARRIVING', 'IN_PROGRESS']);
  assert.deepEqual(where.started_at, { lt: CUTOFF });
  // A long but legitimate pre-pickup wait must be handled by the
  // never-started sweep; anchoring here on accepted_at could cancel an
  // in-progress journey.
  assert.equal((where as any).accepted_at, undefined);
  assert.equal((where as any).OR, undefined);
});

test('overdue sweep: empty statuses cannot match terminal rides', () => {
  const where = buildOverdueWhere(CUTOFF);
  for (const s of where.status.in) {
    assert.ok(s !== 'COMPLETED' && s !== 'CANCELLED');
  }
});
