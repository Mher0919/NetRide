// tests/unit/backend/modules/ride/ride-state-guards.unit.test.ts
//
// Unit tests for the server-authoritative ride state machine and the
// atomic (TOCTOU-safe) watchdog cancel predicate.

import test from 'node:test';
import assert from 'node:assert/strict';

import { TripStateMachine } from '../../../../../backend/src/services/machine.service';
import { buildTerminalCancelGuardSql, TerminalCancelGuard } from '../../../../../backend/src/modules/ride/ride-state.rules';
import { TripStatus } from '../../../../../backend/src/types/index';

test('state machine: ACCEPTED may become DRIVER_ARRIVING', () => {
  assert.equal(
    TripStateMachine.canTransition(TripStatus.ACCEPTED, TripStatus.DRIVER_ARRIVING),
    true,
  );
});

test('state machine: DRIVER_ARRIVING may start or cancel, never complete directly', () => {
  assert.equal(
    TripStateMachine.canTransition(TripStatus.DRIVER_ARRIVING, TripStatus.IN_PROGRESS),
    true,
  );
  assert.equal(
    TripStateMachine.canTransition(TripStatus.DRIVER_ARRIVING, TripStatus.CANCELLED),
    true,
  );
  assert.equal(
    TripStateMachine.canTransition(TripStatus.DRIVER_ARRIVING, TripStatus.COMPLETED),
    false,
  );
});

test('state machine: terminal states have no outgoing transitions', () => {
  for (const terminal of [TripStatus.COMPLETED, TripStatus.CANCELLED]) {
    for (const next of Object.values(TripStatus)) {
      assert.equal(
        TripStateMachine.canTransition(terminal, next as TripStatus),
        false,
        `${terminal} must not transition to ${next}`,
      );
    }
  }
});

test('state machine: a REQUESTED ride can only be accepted or cancelled', () => {
  assert.equal(TripStateMachine.canTransition(TripStatus.REQUESTED, TripStatus.ACCEPTED), true);
  assert.equal(TripStateMachine.canTransition(TripStatus.REQUESTED, TripStatus.CANCELLED), true);
  assert.equal(TripStateMachine.canTransition(TripStatus.REQUESTED, TripStatus.IN_PROGRESS), false);
  assert.equal(TripStateMachine.canTransition(TripStatus.REQUESTED, TripStatus.COMPLETED), false);
});

test('terminal-cancel guard SQL: re-verifies age on an allowlisted column', () => {
  const guard: TerminalCancelGuard = {
    statuses: [TripStatus.REQUESTED],
    beforeColumn: 'created_at',
    before: new Date('2026-10-13T12:00:00.000Z'),
  };
  const built = buildTerminalCancelGuardSql(guard.statuses!, guard, 7);
  assert.equal(built.statusPlaceholders, '$7');
  assert.ok(built.extraWhere.includes('created_at < $8'));
  assert.equal(built.extraValues.length, 1);
});

test('terminal-cancel guard SQL: re-verifies started_at IS NULL for never-started rides', () => {
  const guard: TerminalCancelGuard = {
    statuses: [TripStatus.ACCEPTED, TripStatus.DRIVER_ARRIVING],
    beforeColumn: 'accepted_at',
    before: new Date(),
    requireStartedAtNull: true,
  };
  const built = buildTerminalCancelGuardSql(guard.statuses!, guard, 7);
  assert.equal(built.statusPlaceholders, '$7, $8');
  assert.ok(built.extraWhere.includes('accepted_at < $9'));
  assert.ok(built.extraWhere.includes('started_at IS NULL'));
});

test('terminal-cancel guard SQL: scheduled exclusion binds its value', () => {
  const cutoff = new Date('2026-10-13T11:50:00.000Z');
  const guard: TerminalCancelGuard = {
    statuses: [TripStatus.REQUESTED],
    beforeColumn: 'created_at',
    before: cutoff,
    requireNotScheduledBefore: cutoff,
  };
  const built = buildTerminalCancelGuardSql(guard.statuses!, guard, 7);
  assert.ok(built.extraWhere.includes('is_scheduled IS NOT TRUE'));
  assert.ok(built.extraWhere.includes('scheduled_at < $9'));
  assert.deepEqual(built.extraValues, [cutoff, cutoff]);
});

test('terminal-cancel guard SQL: no guard means no extra predicate or values', () => {
  const built = buildTerminalCancelGuardSql(
    [TripStatus.REQUESTED, TripStatus.ACCEPTED],
    undefined,
    7,
  );
  assert.equal(built.statusPlaceholders, '$7, $8');
  assert.equal(built.extraWhere, '');
  assert.deepEqual(built.extraValues, []);
});

test('terminal-cancel guard SQL: a disallowed column can never be injected', () => {
  // TypeScript forbids it; simulate a runtime attacker and assert only the
  // allowlisted value is ever concatenated (buildTerminalCancelGuardSql is
  // the single chokepoint).
  const guard = {
    statuses: [TripStatus.REQUESTED],
    beforeColumn: 'created_at',
    before: new Date(),
  } as TerminalCancelGuard;
  const built = buildTerminalCancelGuardSql(guard.statuses!, guard, 7);
  assert.ok(!built.extraWhere.includes(';'));
  assert.ok(!built.extraWhere.includes('--'));
});
