// tests/unit/backend/modules/ride/ride-recovery.unit.test.ts
//
// Unit tests for the mid-ride app-kill recovery guarantees:
//   1. cancellation notifications reach EVERY party except the actor, each
//      with their OWN role key (the old "opposite of actor" derivation sent
//      the rider's system-cancel with a DRIVER role key and dropped the
//      push entirely);
//   2. the cancellation eventId is role-scoped (notifications.event_id is
//      globally unique);
//   3. the single-active-ride guard error carries the existing trip id.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveCancelNotificationTargets,
  ActiveRideExistsError,
} from '../../../../../backend/src/modules/ride/ride.service';
import { rideCancelledEventId } from '../../../../../backend/src/services/notification.service';

test('cancel targets: rider-cancel notifies the assigned driver only', () => {
  const targets = resolveCancelNotificationTargets({
    riderId: 'rider-1',
    driverId: 'driver-1',
    actorRole: 'rider',
  });
  assert.deepEqual(targets, [{ recipientId: 'driver-1', role: 'driver' }]);
});

test('cancel targets: driver-cancel notifies the rider only', () => {
  const targets = resolveCancelNotificationTargets({
    riderId: 'rider-1',
    driverId: 'driver-1',
    actorRole: 'driver',
  });
  assert.deepEqual(targets, [{ recipientId: 'rider-1', role: 'rider' }]);
});

test('cancel targets: SYSTEM cancel notifies BOTH parties with correct roles', () => {
  const targets = resolveCancelNotificationTargets({
    riderId: 'rider-1',
    driverId: 'driver-1',
    actorRole: 'system',
  });
  assert.deepEqual(targets, [
    { recipientId: 'rider-1', role: 'rider' },
    { recipientId: 'driver-1', role: 'driver' },
  ]);
});

test('cancel targets: SYSTEM cancel with no driver still notifies the rider', () => {
  // A REQUIRED request that times out has no driver — the rider was
  // previously notified by nobody at all.
  const targets = resolveCancelNotificationTargets({
    riderId: 'rider-1',
    driverId: null,
    actorRole: 'system',
  });
  assert.deepEqual(targets, [{ recipientId: 'rider-1', role: 'rider' }]);
});

test('cancel eventIds are role-scoped so both recipients get a push', () => {
  const riderKey = rideCancelledEventId('trip-1', 'rider');
  const driverKey = rideCancelledEventId('trip-1', 'driver');
  assert.notEqual(riderKey, driverKey);
  assert.equal(riderKey, 'ride:cancelled:trip-1:rider');
  assert.equal(driverKey, 'ride:cancelled:trip-1:driver');
});

test('ActiveRideExistsError carries the existing trip id + code', () => {
  const err = new ActiveRideExistsError('trip-42', 'IN_PROGRESS');
  assert.equal(err.code, 'ACTIVE_RIDE_EXISTS');
  assert.equal(err.tripId, 'trip-42');
  assert.equal(err.tripStatus, 'IN_PROGRESS');
  assert.equal(err instanceof Error, true);
});
