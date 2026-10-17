// tests/unit/backend/security/ride-transition-guards.unit.test.ts
//
// Regression suite for the ride state-machine hardening (business-logic /
// access-control findings): RideRepository.updateStatus must
//   * only accept known target statuses,
//   * constrain the source statuses per target (no COMPLETED → CANCELLED
//     regressions, no silent no-op writes),
//   * honor caller-narrowed `expectedStatuses` atomically, and
//   * reserve history deletion for terminal rides.
//
// Runs the REAL repository with an injected pool (require.cache).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const BACKEND = path.resolve(__dirname, '..', '..', '..', '..', 'backend');

interface QueryCall { sql: string; params: any[] }

function buildRepo(rowCount = 1) {
  const queries: QueryCall[] = [];
  const pool = {
    query: (sql: string, params: any[] = []) => {
      queries.push({ sql, params });
      if (sql.startsWith('UPDATE')) return Promise.resolve({ rows: [], rowCount });
      return Promise.resolve({ rows: [{ id: 'ride-1', status: 'X', pickup_lat: 1, pickup_lng: 2 }], rowCount: 1 });
    },
  };

  const dbPath = require.resolve(path.join(BACKEND, 'src', 'config', 'database.ts'));
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true, exports: { pool, default: pool }, children: [], paths: [],
  } as any;

  const repoPath = require.resolve(path.join(BACKEND, 'src', 'modules', 'ride', 'ride.repository.ts'));
  delete require.cache[repoPath];
  const { RideRepository } = require(repoPath);
  return { RideRepository, queries };
}

test('ride repository: COMPLETED transition only accepts active source states', async () => {
  const { RideRepository, queries } = buildRepo(1);
  await RideRepository.updateStatus('ride-1', 'COMPLETED');
  const update = queries.find((q) => q.sql.startsWith('UPDATE'))!;
  const sources = update.params.slice(2); // [$1] target status, [$2] id
  assert.ok(update.sql.includes("status IN ("), 'source-status predicate present');
  for (const source of ['ACCEPTED', 'DRIVER_ARRIVING', 'IN_PROGRESS']) {
    assert.ok(sources.includes(source), `COMPLETED may come from ${source}`);
  }
  assert.ok(!sources.includes('REQUESTED'), 'REQUESTED cannot complete');
  assert.ok(!sources.includes('CANCELLED'), 'CANCELLED cannot complete');
});

test('ride repository: CANCELLED can never come from a terminal state', async () => {
  const { RideRepository, queries } = buildRepo(1);
  await RideRepository.updateStatus('ride-1', 'CANCELLED');
  const update = queries.find((q) => q.sql.startsWith('UPDATE'))!;
  const sources = update.params.slice(2); // [$1] target status, [$2] id
  assert.ok(!sources.includes('COMPLETED'), 'COMPLETED must not regress to CANCELLED');
  assert.ok(!sources.includes('CANCELLED'), 'CANCELLED cannot re-cancel');
});

test('ride repository: expectedStatuses narrows the guard atomically', async () => {
  const { RideRepository, queries } = buildRepo(1);
  await RideRepository.updateStatus('ride-1', 'CANCELLED', { expectedStatuses: ['REQUESTED'] });
  const update = queries.find((q) => q.sql.startsWith('UPDATE'))!;
  const sourceParams = update.params.filter((p) => typeof p === 'string' && p === p.toUpperCase());
  assert.ok(sourceParams.includes('REQUESTED'));
  assert.ok(!sourceParams.includes('ACCEPTED'), 'accept race must not be cancellable');
  assert.ok(!sourceParams.includes('IN_PROGRESS'));
});

test('ride repository: zero-row updates throw instead of silently succeeding', async () => {
  const { RideRepository } = buildRepo(0);
  await assert.rejects(
    () => RideRepository.updateStatus('ride-1', 'IN_PROGRESS'),
    /cannot be updated to IN_PROGRESS/,
  );
});

test('ride repository: unknown/disallowed target status throws before any write', async () => {
  const { RideRepository, queries } = buildRepo(1);
  await assert.rejects(
    () => RideRepository.updateStatus('ride-1', 'FOO_STATUS' as any),
    /Unsupported or disallowed/,
  );
  assert.equal(queries.filter((q) => q.sql.startsWith('UPDATE')).length, 0);
});

test('ride repository: history deletion is terminal-only and participant-scoped', async () => {
  const { RideRepository, queries } = buildRepo(1);
  await RideRepository.delete('ride-1', 'user-1');
  const del = queries.find((q) => q.sql.startsWith('DELETE'))!;
  assert.ok(del.sql.includes("status IN ('COMPLETED', 'CANCELLED')"), 'active rides cannot be deleted');
  assert.ok(del.sql.includes('rider_id = $2 OR driver_id = $2'), 'participant scope enforced');
  assert.deepEqual(del.params, ['ride-1', 'user-1']);
});
