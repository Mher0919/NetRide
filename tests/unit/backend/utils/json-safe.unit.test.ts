// tests/unit/backend/utils/json-safe.unit.test.ts
//
// Regression suite for the admin response serializer. The ride/user list
// endpoints previously returned Prisma rows straight into res.json, which
// threw `TypeError: Do not know how to serialize a BigInt` (HTTP 500) and a
// naive deep-clone destroyed Dates ({}) and Prisma Decimals ({s,e,d}).

import test from 'node:test';
import assert from 'node:assert/strict';

import { jsonSafe } from '../../../../backend/src/utils/json-safe';

/** Minimal duck-typed Prisma Decimal (decimal.js API surface). */
class FakeDecimal {
  constructor(private readonly value: string) {}
  toFixed(dp?: number) {
    return Number(this.value).toFixed(dp ?? 2);
  }
  toNumber() {
    return Number(this.value);
  }
  toString() {
    return this.value;
  }
}

test('json-safe: BigInt (BIGINT cents) becomes a number, not a 500', () => {
  const input = { final_payment_cents: 1350n, wallet_payment_cents: 0n };
  const safe = jsonSafe(input);
  assert.equal(typeof safe.final_payment_cents, 'number');
  assert.equal(safe.final_payment_cents, 1350);
  assert.equal(safe.wallet_payment_cents, 0);
  // The exact operation Express performs — must not throw.
  assert.doesNotThrow(() => JSON.stringify(safe));
});

test('json-safe: Dates survive as dates (serialize to ISO, never {})', () => {
  const when = new Date('2026-10-09T04:58:28.550Z');
  const safe = jsonSafe({ created_at: when, nested: { completed_at: when } });
  assert.ok(safe.created_at instanceof Date);
  assert.ok(safe.nested.completed_at instanceof Date);
  const json = JSON.parse(JSON.stringify(safe));
  assert.equal(json.created_at, '2026-10-09T04:58:28.550Z');
  assert.notDeepEqual(json.created_at, {});
});

test('json-safe: Prisma Decimal becomes a number (no internal {s,e,d} leak)', () => {
  const safe = jsonSafe({ fare_amount: new FakeDecimal('10.00') });
  assert.equal(safe.fare_amount, 10);
  assert.equal(typeof safe.fare_amount, 'number');
});

test('json-safe: arrays and nested objects are converted recursively', () => {
  const safe = jsonSafe({
    rides: [{
      id: 'r1',
      final_payment_cents: 500n,
      created_at: new Date('2026-01-02T03:04:05.000Z'),
      rider: { email: 'a@b.c', tip: 25n },
    }],
  });
  assert.equal(safe.rides[0].final_payment_cents, 500);
  assert.equal(safe.rides[0].rider.tip, 25);
  assert.ok(safe.rides[0].created_at instanceof Date);
  assert.doesNotThrow(() => JSON.stringify(safe));
});

test('json-safe: null/undefined/primitives pass through; functions are dropped', () => {
  const safe = jsonSafe({
    a: null,
    b: undefined,
    c: 'x',
    d: 1.5,
    e: true,
    f: () => 1,
  });
  assert.equal(safe.a, null);
  assert.ok(!('b' in safe));
  assert.equal(safe.c, 'x');
  assert.equal(safe.d, 1.5);
  assert.equal(safe.e, true);
  assert.ok(!('f' in safe));
});

test('json-safe: nullish top-level input is returned unchanged', () => {
  assert.equal(jsonSafe(null), null);
  assert.equal(jsonSafe(undefined), undefined);
});
