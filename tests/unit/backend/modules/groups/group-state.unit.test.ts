import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canTransitionGroup,
  canTransitionMember,
  canTransitionPayment,
  isConfigurable,
  isRideActive,
  occupiesSeat,
} from '../../../../../backend/src/modules/groups/group-state.rules';
import {
  buildGroupInviteLink,
  buildGroupInviteSms,
  generateInviteToken,
  hashInviteToken,
  normalizePhone,
} from '../../../../../backend/src/modules/groups/group-invite.util';

test('group lifecycle: valid transitions only', () => {
  assert.equal(canTransitionGroup('CONFIGURING', 'AWAITING_PAYMENT'), true);
  assert.equal(canTransitionGroup('AWAITING_PAYMENT', 'READY_TO_REQUEST'), true);
  assert.equal(canTransitionGroup('READY_TO_REQUEST', 'RIDE_REQUESTED'), true);
  assert.equal(canTransitionGroup('DRIVER_ASSIGNED', 'IN_PROGRESS'), true);
  assert.equal(canTransitionGroup('IN_PROGRESS', 'COMPLETED'), true);
  assert.equal(canTransitionGroup('COMPLETED', 'IN_PROGRESS'), false);
  assert.equal(canTransitionGroup('CANCELLED', 'READY_TO_REQUEST'), false);
  assert.equal(canTransitionGroup('RIDE_REQUESTED', 'CONFIGURING'), false);
});

test('member lifecycle: cannot resurrect a removed member', () => {
  assert.equal(canTransitionMember('JOINED', 'PICKED_UP'), true);
  assert.equal(canTransitionMember('PICKED_UP', 'COMPLETED'), true);
  assert.equal(canTransitionMember('REMOVED', 'JOINED'), false);
  assert.equal(canTransitionMember('COMPLETED', 'JOINED'), false);
});

test('payment lifecycle: a refund is terminal', () => {
  assert.equal(canTransitionPayment('PENDING', 'SUCCEEDED'), true);
  assert.equal(canTransitionPayment('SUCCEEDED', 'REFUNDED'), true);
  assert.equal(canTransitionPayment('REFUNDED', 'SUCCEEDED'), false);
  assert.equal(canTransitionPayment('FAILED', 'PENDING'), true);
});

test('configurable vs active ride phases are distinct', () => {
  assert.equal(isConfigurable('CONFIGURING'), true);
  assert.equal(isConfigurable('RIDE_REQUESTED'), false);
  assert.equal(isRideActive('DRIVER_ASSIGNED'), true);
  assert.equal(isRideActive('COMPLETED'), false);
});

test('seat accounting excludes left/removed members', () => {
  assert.equal(occupiesSeat('JOINED'), true);
  assert.equal(occupiesSeat('PICKUP_CONFIRMED'), true);
  assert.equal(occupiesSeat('LEFT'), false);
  assert.equal(occupiesSeat('REMOVED'), false);
});

test('phone normalization: US E.164 and invalid input', () => {
  assert.equal(normalizePhone('(555) 123-4567'), '+15551234567');
  assert.equal(normalizePhone('1 555 123 4567'), '+15551234567');
  assert.equal(normalizePhone('12345'), null);
  assert.equal(normalizePhone(null), null);
});

test('invite tokens are unguessable and only hashes are stable', () => {
  const a = generateInviteToken();
  const b = generateInviteToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= 32);
  assert.equal(hashInviteToken(a), hashInviteToken(a));
  assert.notEqual(hashInviteToken(a), a);
  assert.notEqual(hashInviteToken(a), hashInviteToken(b));
});

test('invite SMS carries group context and a join link', () => {
  const token = generateInviteToken();
  const link = buildGroupInviteLink(token);
  const sms = buildGroupInviteSms({
    inviterName: 'Alex',
    groupName: 'Saturday dinner',
    token,
  });
  assert.ok(sms.includes('Alex'));
  assert.ok(sms.includes('Saturday dinner'));
  assert.ok(sms.includes(link));
});
