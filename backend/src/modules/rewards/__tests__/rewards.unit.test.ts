// backend/src/modules/rewards/__tests__/rewards.unit.test.ts
//
// Unit tests for the rewards ecosystem's PURE logic — discount math and
// referral QR crypto. These run with NO network and NO database, so they
// execute in CI / pre-commit in milliseconds.
//
// DB-dependent guarantees (idempotency keys, FOR UPDATE locks, UNIQUE
// constraints, referral state machine) are enforced by schema + service
// code that requires a live Postgres — covered by the migration DDL and
// the E2E smoke script instead.

import test from 'node:test';
import assert from 'node:assert/strict';

import { computePromoDiscount } from '../../promo/promo.service';
import {
  signReferralPayload,
  verifyReferralPayload,
  generateReferralCode,
  hmacFor,
} from '../../../services/qr-signature.service';

// ---- Promo discount math --------------------------------------------------

test('computePromoDiscount: FIXED discount is exact', () => {
  const d = computePromoDiscount(
    { discount_type: 'FIXED', discount_value: '3.50', max_discount_cents: 0 },
    2000,
  );
  assert.equal(d, 350);
});

test('computePromoDiscount: FIXED discount never exceeds the fare', () => {
  const d = computePromoDiscount(
    { discount_type: 'FIXED', discount_value: '20.00', max_discount_cents: 0 },
    750,
  );
  assert.equal(d, 750);
});

test('computePromoDiscount: PERCENTAGE math rounds to cents', () => {
  const d = computePromoDiscount(
    { discount_type: 'PERCENTAGE', discount_value: '15', max_discount_cents: 0 },
    3333,
  );
  assert.equal(d, 500); // 3333 * 0.15 = 499.95 → 500
});

test('computePromoDiscount: PERCENTAGE respects max_discount_cents cap', () => {
  const d = computePromoDiscount(
    { discount_type: 'PERCENTAGE', discount_value: '50', max_discount_cents: 1000 },
    5000,
  );
  assert.equal(d, 1000); // 50% would be 2500, but capped at 1000
});

test('computePromoDiscount: cap below fare yields the cap', () => {
  const d = computePromoDiscount(
    { discount_type: 'FIXED', discount_value: '10.00', max_discount_cents: 400 },
    900,
  );
  assert.equal(d, 400);
});

test('computePromoDiscount: zero fare yields zero discount', () => {
  const d = computePromoDiscount(
    { discount_type: 'PERCENTAGE', discount_value: '25', max_discount_cents: 0 },
    0,
  );
  assert.equal(d, 0);
});

test('computePromoDiscount: percentage above 100 is clamped to the fare', () => {
  const d = computePromoDiscount(
    { discount_type: 'PERCENTAGE', discount_value: '300', max_discount_cents: 0 },
    1200,
  );
  assert.equal(d, 1200);
});

test('computePromoDiscount: negative discount_value yields zero', () => {
  const d = computePromoDiscount(
    { discount_type: 'FIXED', discount_value: '-5', max_discount_cents: 0 },
    2000,
  );
  assert.equal(d, 0);
});

// ---- Referral QR signing / verification -----------------------------------

test('signReferralPayload: round-trips and verifies', () => {
  const exp = new Date(Date.now() + 86_400_000);
  const payload = signReferralPayload('user-123', 'ABC2345678', exp);
  const res = verifyReferralPayload(payload);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.payload.userId, 'user-123');
  assert.equal(res.payload.code, 'ABC2345678');
  assert.equal(res.payload.expiresAt.getTime(), Math.floor(exp.getTime() / 1000) * 1000);
});

test('verifyReferralPayload: rejects tampered signature', () => {
  const exp = new Date(Date.now() + 86_400_000);
  const payload = signReferralPayload('user-123', 'ABC2345678', exp);
  const tampered = payload.slice(0, -1) + (payload.endsWith('a') ? 'b' : 'a');
  const res = verifyReferralPayload(tampered);
  assert.equal(res.ok, false);
});

test('verifyReferralPayload: rejects tampered user id (ownership binding)', () => {
  const exp = new Date(Date.now() + 86_400_000);
  const payload = signReferralPayload('user-123', 'ABC2345678', exp);
  const forged = payload.replace('user-123', 'user-999');
  const res = verifyReferralPayload(forged);
  assert.equal(res.ok, false);
});

test('verifyReferralPayload: rejects expired payloads', () => {
  const exp = new Date(Date.now() - 1000);
  const payload = signReferralPayload('user-123', 'ABC2345678', exp);
  const res = verifyReferralPayload(payload);
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.reason, /expired/i);
});

test('verifyReferralPayload: rejects unsupported version / malformed shapes', () => {
  const res = verifyReferralPayload('v2.user.code.123.deadbeef');
  assert.equal(res.ok, false);
  assert.equal(verifyReferralPayload('garbage').ok, false);
  assert.equal(verifyReferralPayload('').ok, false);
  assert.equal(verifyReferralPayload('a.b.c').ok, false);
});

test('verifyReferralPayload: rejects payload signed with a different secret', () => {
  const body = `v1.user-123.ABC2345678.${Math.floor(Date.now() / 1000) + 1000}`;
  const badSig = Buffer.from('00'.repeat(32)).toString('hex');
  const forged = `${body}.${badSig}`;
  const res = verifyReferralPayload(forged);
  assert.equal(res.ok, false);
});

test('hmacFor is deterministic for the same body', () => {
  assert.equal(hmacFor('v1.u.c.123'), hmacFor('v1.u.c.123'));
  assert.notEqual(hmacFor('v1.u.c.123'), hmacFor('v1.u.c.124'));
});

// ---- Referral code generation ---------------------------------------------

test('generateReferralCode: always 10 chars from the safe alphabet', () => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let i = 0; i < 50; i++) {
    const code = generateReferralCode();
    assert.equal(code.length, 10);
    for (const ch of code) {
      assert.ok(alphabet.includes(ch), `unexpected char ${ch}`);
    }
  }
});

test('generateReferralCode: no ambiguous characters (I/O/0/1)', () => {
  for (let i = 0; i < 200; i++) {
    const code = generateReferralCode();
    assert.doesNotMatch(code, /[IO01]/);
  }
});

test('generateReferralCode: generates distinct codes', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) seen.add(generateReferralCode());
  assert.equal(seen.size, 2000);
});
