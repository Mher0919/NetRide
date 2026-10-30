// tests/unit/backend/security/token-purpose.unit.test.ts
//
// A valid HS256 signature is not enough to treat a JWT as a session token:
// trusted-device and file-access tokens are signed with the same secret but
// have a narrower purpose. These tests pin the discriminator.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SESSION_TOKEN_TYPE,
  isSessionAccessToken,
} from '../../../../backend/src/security/token-purpose';

test('session token: current access tokens are accepted', () => {
  assert.equal(isSessionAccessToken({ id: 'u1', role: 'RIDER', t: SESSION_TOKEN_TYPE }), true);
});

test('session token: legacy tokens without a purpose claim remain valid', () => {
  assert.equal(isSessionAccessToken({ id: 'u1', role: 'RIDER' }), true);
});

test('session token: trusted-device tokens are rejected', () => {
  assert.equal(isSessionAccessToken({ id: 'admin', role: 'ADMIN', t: 'trusted-device' }), false);
});

test('session token: file-access tokens are rejected', () => {
  assert.equal(isSessionAccessToken({ fid: 'f1', uid: 'u1', t: 'file-access' }), false);
});

test('session token: arbitrary/missing payloads are rejected', () => {
  assert.equal(isSessionAccessToken(null), false);
  assert.equal(isSessionAccessToken(undefined), false);
  assert.equal(isSessionAccessToken('token'), false);
  assert.equal(isSessionAccessToken({ id: 'u1', t: 'portal-access' }), false);
});
