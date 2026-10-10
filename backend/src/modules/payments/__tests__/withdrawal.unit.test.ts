// backend/src/modules/payments/__tests__/withdrawal.unit.test.ts
//
// Weekly manual-withdrawal rule (drivers + sponsors share it):
//   * one withdrawal per calendar week;
//   * the window opens every Monday 00:00 UTC — a withdrawal on ANY day of
//     the week makes the next opportunity the following Monday;
//   * accounts that never withdrew are immediately eligible.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  startOfWeekUtc,
  nextMondayUtc,
  withdrawalStateFor,
} from '../withdrawal.service';

test('week start: Monday 00:00 UTC for every day of the week', () => {
  // 2026-05-04 is a Monday, 2026-05-10 is the following Sunday.
  for (let offset = 0; offset < 7; offset++) {
    const d = new Date(Date.UTC(2026, 4, 4 + offset, 12, 34, 9));
    const start = startOfWeekUtc(d);
    assert.equal(start.toISOString(), new Date(Date.UTC(2026, 4, 4)).toISOString(), `offset ${offset}`);
  }
});

test('week start: Monday rolls back across month boundaries', () => {
  // 2026-06-01 is a Monday. A Sunday (2026-05-31) belongs to a week whose
  // Monday is 2026-05-25? No: 2026-05-25 is a Monday, 2026-05-31 Sunday → start 05-25.
  const sun = new Date(Date.UTC(2026, 4, 31, 20));
  const start = startOfWeekUtc(sun);
  assert.equal(start.toISOString(), new Date(Date.UTC(2026, 4, 25)).toISOString());
  // ...and a Tuesday 2026-06-02 rolls back to Monday 2026-06-01.
  const tue = new Date(Date.UTC(2026, 5, 2, 1));
  assert.equal(startOfWeekUtc(tue).toISOString(), new Date(Date.UTC(2026, 5, 1)).toISOString());
});

test('next Monday: strictly after the given day, 00:00 UTC', () => {
  const withdrawnWed = new Date(Date.UTC(2026, 4, 6, 13, 15));
  const next = nextMondayUtc(withdrawnWed);
  assert.equal(next.toISOString(), new Date(Date.UTC(2026, 4, 11)).toISOString());
  // Withdrawing ON Monday morning → next Monday.
  const withdrawnMonday = new Date(Date.UTC(2026, 4, 4, 9));
  assert.equal(nextMondayUtc(withdrawnMonday).toISOString(), new Date(Date.UTC(2026, 4, 11)).toISOString());
});

test('rule: never withdrew → eligible immediately', () => {
  const state = withdrawalStateFor(null, new Date(Date.UTC(2026, 4, 6, 9)));
  assert.equal(state.eligible, true);
});

test('rule: withdrew THIS week (Wednesday) → blocked until next Monday', () => {
  const now = new Date(Date.UTC(2026, 4, 6, 21)); // Wednesday
  const state = withdrawalStateFor(new Date(Date.UTC(2026, 4, 4, 9)), now); // Monday same week
  assert.equal(state.eligible, false);
  assert.equal(state.nextAvailableAt.toISOString(), new Date(Date.UTC(2026, 4, 11)).toISOString());
});

test('rule: withdrew just before a Monday (Sunday night) → available Monday 00:00', () => {
  const state = withdrawalStateFor(
    new Date(Date.UTC(2026, 4, 10, 23, 59)), // Sunday night (week of 05-04)
    new Date(Date.UTC(2026, 4, 11, 0, 1)), // Monday 00:01 next week
  );
  assert.equal(state.eligible, true);
});

test('rule: last withdrawal in a PREVIOUS week → eligible now (Mondays reset)', () => {
  const state = withdrawalStateFor(
    new Date(Date.UTC(2026, 4, 11, 9)), // previous Monday
    new Date(Date.UTC(2026, 4, 18, 9)), // this Monday
  );
  assert.equal(state.eligible, true);
});

test('rule: the next window is the following Monday no matter WHEN they withdrew mid-week', () => {
  // Wednesday 4:00 vs Friday 23:00 in the same week → same next Monday.
  const wed = withdrawalStateFor(new Date(Date.UTC(2026, 4, 6, 4)), new Date(Date.UTC(2026, 4, 6, 5)));
  const fri = withdrawalStateFor(new Date(Date.UTC(2026, 4, 8, 23)), new Date(Date.UTC(2026, 4, 8, 23, 30)));
  assert.equal(wed.nextAvailableAt.toISOString(), fri.nextAvailableAt.toISOString());
  assert.equal(wed.nextAvailableAt.toISOString(), new Date(Date.UTC(2026, 4, 11)).toISOString());
});

test('rule: garage dates never produce invalid states', () => {
  const weird = withdrawalStateFor(new Date(0), new Date());
  assert.equal(weird.eligible, true);
});