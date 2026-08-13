// backend/src/modules/reporting/__tests__/report-reasons.unit.test.ts
import { strict as assert } from 'assert';
import {
  CANCELLATION_REASONS,
  REPORT_REASONS,
  isCancellationReasonValid,
  isReportReasonValid,
  cancellationReasonLabel,
  reportReasonLabel,
  ReasonOption,
} from '../report.reasons';

const { test } = require('node:test');

function codes(list: ReasonOption[]): string[] {
  return list.map((o) => o.code);
}

test('cancellation reasons exist for both roles with unique codes', () => {
  for (const role of ['RIDER', 'DRIVER'] as const) {
    const list = CANCELLATION_REASONS[role];
    assert.ok(list.length >= 5, `${role} should offer at least 5 cancellation reasons`);
    assert.equal(new Set(codes(list)).size, list.length, `${role} codes must be unique`);
    for (const o of list) {
      assert.ok(o.code.length > 0);
      assert.ok(o.label.length > 0);
    }
  }
});

test('report reasons exist for both roles with unique codes', () => {
  for (const role of ['RIDER', 'DRIVER'] as const) {
    const list = REPORT_REASONS[role];
    assert.ok(list.length >= 5, `${role} should offer at least 5 report reasons`);
    assert.equal(new Set(codes(list)).size, list.length, `${role} codes must be unique`);
    for (const o of list) {
      assert.ok(o.code.length > 0);
      assert.ok(o.label.length > 0);
    }
  }
});

test('isCancellationReasonValid accepts known codes and rejects unknown/foreign codes', () => {
  assert.ok(isCancellationReasonValid('RIDER', 'changed_plans'));
  assert.ok(isCancellationReasonValid('DRIVER', 'vehicle_issue'));
  assert.ok(!isCancellationReasonValid('RIDER', 'vehicle_issue'), 'driver code is not valid for riders');
  assert.ok(!isCancellationReasonValid('DRIVER', 'changed_plans'), 'rider code is not valid for drivers');
  assert.ok(!isCancellationReasonValid('RIDER', 'made_up_code'));
});

test('isReportReasonValid is role-scoped', () => {
  assert.ok(isReportReasonValid('RIDER', 'unsafe_driving'), 'rider can report unsafe driving');
  assert.ok(isReportReasonValid('DRIVER', 'damage_to_vehicle'), 'driver can report vehicle damage');
  assert.ok(!isReportReasonValid('RIDER', 'damage_to_vehicle'), 'rider cannot use driver-scoped code');
  assert.ok(!isReportReasonValid('DRIVER', 'unsafe_driving'), 'driver cannot use rider-scoped code');
  assert.ok(!isReportReasonValid('RIDER', 'nonsense'));
});

test('labels fall back to the raw code for unknown values', () => {
  assert.equal(cancellationReasonLabel('RIDER', 'changed_plans'), 'I changed my plans');
  assert.equal(cancellationReasonLabel('RIDER', 'unknown_code'), 'unknown_code');
  assert.equal(reportReasonLabel('DRIVER', 'damage_to_vehicle'), 'Damage to the vehicle');
  assert.equal(reportReasonLabel('RIDER', 'unknown_code'), 'unknown_code');
});
