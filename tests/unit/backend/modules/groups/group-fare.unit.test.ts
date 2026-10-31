import test from 'node:test';
import assert from 'node:assert/strict';

import {
  allocateDistance,
  allocateEqual,
  allocateHostPays,
  computeGroupShares,
  sumShares,
  validateCustomShares,
} from '../../../../../backend/src/modules/groups/group-fare.service';

const ids = ['u1', 'u2', 'u3', 'u4'];

test('equal split: divides exactly and handles remaining cents deterministically', () => {
  const shares = allocateEqual(10000, ids);
  assert.equal(sumShares(shares), 10000);
  assert.deepEqual(
    shares.map((s) => s.amountCents),
    [2500, 2500, 2500, 2500],
  );

  const odd = allocateEqual(10001, ids);
  assert.equal(sumShares(odd), 10001);
  assert.equal(odd[0].amountCents, 2501);
  assert.equal(odd[1].amountCents, 2500);

  const three = allocateEqual(10000, ['b', 'a', 'c']);
  assert.equal(sumShares(three), 10000);
  assert.deepEqual(
    three.map((s) => ({ id: s.userId, cents: s.amountCents })),
    [
      { id: 'a', cents: 3334 },
      { id: 'b', cents: 3333 },
      { id: 'c', cents: 3333 },
    ],
  );
});

test('distance split: uses road distances and reconciles exactly', () => {
  // The spec example: $60 over 10 / 6 / 4 miles → $30 / $18 / $12.
  const shares = allocateDistance(6000, [
    { userId: 'alex', distanceMeters: 16093 },
    { userId: 'sarah', distanceMeters: 9656 },
    { userId: 'michael', distanceMeters: 6437 },
  ]);
  assert.equal(sumShares(shares), 6000);
  const byId = Object.fromEntries(shares.map((s) => [s.userId, s.amountCents]));
  assert.equal(byId.alex, 3000);
  assert.equal(byId.sarah, 1800);
  assert.equal(byId.michael, 1200);
});

test('distance split: zero total distance is rejected', () => {
  assert.throws(
    () => allocateDistance(1000, ids.map((userId) => ({ userId, distanceMeters: 0 }))),
    /road distance/,
  );
});

test('distance split: deterministically assigns odd cents', () => {
  const shares = allocateDistance(100, [
    { userId: 'a', distanceMeters: 1 },
    { userId: 'b', distanceMeters: 1 },
    { userId: 'c', distanceMeters: 1 },
  ]);
  assert.equal(sumShares(shares), 100);
  assert.deepEqual(shares.map((s) => s.amountCents), [34, 33, 33]);
});

test('host pays: host owes the full total, friends owe nothing', () => {
  const shares = allocateHostPays(8500, 'host', ids);
  assert.equal(sumShares(shares), 8500);
  assert.equal(shares.find((s) => s.userId === 'host')!.amountCents, 8500);
  for (const id of ['u1', 'u2', 'u3', 'u4']) {
    assert.equal(shares.find((s) => s.userId === id)!.amountCents, 0);
  }
});

test('custom split: must be complete, non-negative and exact', () => {
  const ok = validateCustomShares(6000, ids, {
    u1: 1500,
    u2: 1500,
    u3: 1500,
    u4: 1500,
  });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(sumShares(ok.shares), 6000);

  assert.equal(validateCustomShares(6000, ids, { u1: 6000 }).ok, false);
  assert.equal(
    validateCustomShares(6000, ids, { u1: -1, u2: 6001, u3: 0, u4: 0 }).ok,
    false,
  );
  assert.equal(
    validateCustomShares(6000, ids, { u1: 6000, u2: 0, u3: 0, u4: 1 }).ok,
    false,
  );
});

test('computeGroupShares: defaults cannot silently equal-split', () => {
  const host = computeGroupShares({
    totalCents: 4000,
    method: 'HOST_PAYS',
    hostId: 'u1',
    participants: ids.map((userId) => ({ userId, distanceMeters: 1000 })),
  });
  assert.equal(host.ok, true);
  if (host.ok) {
    assert.equal(host.shares.find((s) => s.userId === 'u1')!.amountCents, 4000);
    assert.equal(host.shares.find((s) => s.userId === 'u2')!.required, false);
  }
});

test('computeGroupShares: rejects group sizes beyond the hard cap', () => {
  const six = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'];
  const result = computeGroupShares({
    totalCents: 6000,
    method: 'EQUAL',
    hostId: 'u1',
    participants: six.map((userId) => ({ userId })),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'GROUP_FULL');
});

test('discounted total is allocated, never re-discounted per participant', () => {
  // The caller passes the ALREADY discounted payable total. Every cent must
  // reconcile; there is no second promo application in this module.
  const discounted = 4800;
  const result = computeGroupShares({
    totalCents: discounted,
    method: 'DISTANCE',
    hostId: 'host',
    participants: [
      { userId: 'host', distanceMeters: 10000 },
      { userId: 'a', distanceMeters: 5000 },
      { userId: 'b', distanceMeters: 5000 },
    ],
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(sumShares(result.shares), discounted);
});
