// tests/unit/backend/security/security.unit.test.ts
//
// Security regression suite for the file-access, role-resolution and
// tip-bounds policies. Pure logic + JWT signing — no DB, no HTTP server.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canAccessFile,
  canManageFile,
  cacheControlForVisibility,
  classifyFileVisibility,
  sanitizeUploadFileType,
  validateUploadMime,
} from '../../../../backend/src/security/file-policy';
import { signFileAccessToken, verifyFileAccessToken } from '../../../../backend/src/security/file-tokens';
import { sanitizeUser } from '../../../../backend/src/security/user-sanitize';
import {
  resolveSessionRole,
  assertPublicSignupRole,
} from '../../../../backend/src/modules/auth/role-resolution';
import { maxTipDollarsForFare, validateTipAmount } from '../../../../backend/src/security/tip-policy';

// ---------------------------------------------------------------------------
// 1. File access matrix — deny by default
// ---------------------------------------------------------------------------

const publicFile = { id: 'f-public', user_id: 'driver-1', visibility: 'public' };
const privateFile = { id: 'f-private', user_id: 'driver-1', visibility: 'private' };

test('files: public profile photo readable anonymously', () => {
  assert.equal(canAccessFile(publicFile, null), true);
  assert.equal(canAccessFile(publicFile, { id: 'random-user', role: 'RIDER' }), true);
});

test('files: anonymous visitor CANNOT read a government document', () => {
  assert.equal(canAccessFile(privateFile, null), false);
  assert.equal(canAccessFile(privateFile, { id: null, role: null }), false);
});

test('files: an unrelated authenticated user cannot read another user document', () => {
  assert.equal(canAccessFile(privateFile, { id: 'rider-2', role: 'RIDER' }), false);
  assert.equal(canAccessFile(privateFile, { id: 'driver-9', role: 'DRIVER' }), false);
});

test('files: the owner can read their own document', () => {
  assert.equal(canAccessFile(privateFile, { id: 'driver-1', role: 'DRIVER' }), true);
});

test('files: an administrator can read a document for review', () => {
  assert.equal(canAccessFile(privateFile, { id: 'admin-1', role: 'ADMIN' }), true);
  // Role match is case-insensitive but never hinted.
  assert.equal(canAccessFile(privateFile, { id: 'admin-1', role: 'admin' }), true);
});

test('files: an admin-like non-admin role does not grant admin access', () => {
  assert.equal(canAccessFile(privateFile, { id: 'rider-2', role: 'ADMIN-RIDER' }), false);
});

test('files: a null-owner orphan document is admin-only', () => {
  const orphan = { id: 'f-orphan', user_id: null, visibility: 'private' };
  assert.equal(canAccessFile(orphan, null), false);
  assert.equal(canAccessFile(orphan, { id: 'someone', role: 'RIDER' }), false);
  assert.equal(canAccessFile(orphan, { id: 'admin', role: 'ADMIN' }), true);
});

test('files: manage (delete) requires owner or admin', () => {
  assert.equal(canManageFile(privateFile, { id: 'driver-1', role: 'DRIVER' }), true);
  assert.equal(canManageFile(privateFile, { id: 'driver-2', role: 'DRIVER' }), false);
  assert.equal(canManageFile(privateFile, null), false);
  assert.equal(canManageFile(privateFile, { id: 'admin', role: 'ADMIN' }), true);
});

test('files: private files are never publicly cacheable', () => {
  assert.equal(cacheControlForVisibility('private'), 'private, no-store');
  assert.ok(cacheControlForVisibility('public').startsWith('public'));
});

// ---------------------------------------------------------------------------
// 2. Visibility classification — only profile photos are public
// ---------------------------------------------------------------------------

test('classification: only profile/avatar uploads are public', () => {
  for (const t of ['profile', 'PROFILE', ' avatar ']) {
    assert.equal(classifyFileVisibility(t), 'public', `${t} must be public`);
  }
  for (const t of [
    'id_photo', 'license', 'license_back', 'insurance', 'registration',
    'inspection', 'vehicle', 'face', 'general', '', null, undefined,
  ]) {
    assert.equal(classifyFileVisibility(t), 'private', `${String(t)} must be private`);
  }
});

test('classification: unknown/legacy file types degrade to private and sanitized path segment', () => {
  assert.equal(sanitizeUploadFileType('../../etc/passwd'), 'general');
  assert.equal(sanitizeUploadFileType('id photo'), 'general');
  assert.equal(sanitizeUploadFileType('profile'), 'profile');
  assert.equal(sanitizeUploadFileType('ID_PHOTO'), 'id_photo');
});

// ---------------------------------------------------------------------------
// 3. Upload MIME allowlist
// ---------------------------------------------------------------------------

test('mime: only image formats are accepted, html/svg/js rejected', () => {
  assert.equal(validateUploadMime('image/jpeg'), 'image/jpeg');
  assert.equal(validateUploadMime('image/png'), 'image/png');
  assert.equal(validateUploadMime('image/heic'), 'image/heic');
  assert.equal(validateUploadMime('text/html'), null);
  assert.equal(validateUploadMime('image/svg+xml'), null);
  assert.equal(validateUploadMime('application/pdf'), null);
  assert.equal(validateUploadMime(42), null);
});

// ---------------------------------------------------------------------------
// 4. File access tokens — purpose-scoped, tamper-evident
// ---------------------------------------------------------------------------

test('tokens: valid token round-trips the file+user binding', () => {
  const token = signFileAccessToken('file-1', 'user-1');
  const parsed = verifyFileAccessToken(token);
  assert.deepEqual(parsed, { fileId: 'file-1', userId: 'user-1' });
});

test('tokens: tampered token is rejected', () => {
  const token = signFileAccessToken('file-1', 'user-1');
  const tampered = token.slice(0, -2) + (token.endsWith('a') ? 'bb' : 'aa');
  assert.equal(verifyFileAccessToken(tampered), null);
});

test('tokens: a regular JWT (no purpose claim) is not accepted as a file token', () => {
  // Structurally valid JWT without t=file-access.
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ fid: 'file-1', uid: 'user-1' })).toString('base64url');
  const jwtLike = `${header}.${payload}.invalid-signature`;
  assert.equal(verifyFileAccessToken(jwtLike), null);
  assert.equal(verifyFileAccessToken('not-a-jwt'), null);
  assert.equal(verifyFileAccessToken(''), null);
});

// ---------------------------------------------------------------------------
// 5. User row sanitization — secrets never leave the auth service
// ---------------------------------------------------------------------------

test('sanitize: password_hash/fcm_token/face_enrollment removed, safe fields retained', () => {
  const row = {
    id: 'u1',
    email: 'a@b.c',
    full_name: 'A',
    role: 'RIDER',
    password_hash: '$2a$10$secret',
    fcm_token: 'push-secret',
    face_enrollment_url: '/api/files/face',
  };
  const clean: any = sanitizeUser(row);
  assert.equal(clean.password_hash, undefined);
  assert.equal(clean.fcm_token, undefined);
  assert.equal(clean.face_enrollment_url, undefined);
  assert.equal(clean.id, 'u1');
  assert.equal(clean.email, 'a@b.c');
  assert.equal(clean.role, 'RIDER');
});

test('sanitize: null/undefined pass through', () => {
  assert.equal(sanitizeUser(null), null);
  assert.equal(sanitizeUser(undefined), undefined);
});

// ---------------------------------------------------------------------------
// 6. Session role resolution — no client-side ADMIN escalation
// ---------------------------------------------------------------------------

test('roles: ADMIN can only come from the database role', () => {
  assert.equal(resolveSessionRole('ADMIN', false, 'RIDER'), 'ADMIN');
  assert.equal(resolveSessionRole('ADMIN', false, undefined), 'ADMIN');
});

test('roles: a client ADMIN hint never elevates a rider or driver', () => {
  assert.equal(resolveSessionRole('RIDER', false, 'ADMIN'), 'RIDER');
  assert.equal(resolveSessionRole('RIDER', true, 'ADMIN'), 'RIDER');
  assert.equal(resolveSessionRole('DRIVER', true, 'ADMIN'), 'RIDER');
});

test('roles: DRIVER hint honored only when a driver profile exists', () => {
  assert.equal(resolveSessionRole('RIDER', true, 'DRIVER'), 'DRIVER');
  assert.equal(resolveSessionRole('RIDER', false, 'DRIVER'), 'RIDER');
});

test('roles: default resolution is RIDER', () => {
  assert.equal(resolveSessionRole('RIDER', false, undefined), 'RIDER');
  assert.equal(resolveSessionRole(null, false, null), 'RIDER');
});

test('roles: public signup only accepts RIDER/DRIVER', () => {
  assert.equal(assertPublicSignupRole('RIDER'), 'RIDER');
  assert.equal(assertPublicSignupRole('driver'), 'DRIVER');
  assert.throws(() => assertPublicSignupRole('ADMIN'));
  assert.throws(() => assertPublicSignupRole('PARTNER'));
  assert.throws(() => assertPublicSignupRole('FLEET'));
  assert.throws(() => assertPublicSignupRole('admin'));
});

// ---------------------------------------------------------------------------
// 7. Tip bounds — no unbounded wallet minting
// ---------------------------------------------------------------------------

test('tips: representable finite amounts within fare bound are accepted', () => {
  const r = validateTipAmount(5, 12);
  assert.equal(r.ok, true);
  assert.equal(r.amount, 5);
});

test('tips: NaN/Infinity/negative are rejected', () => {
  assert.equal(validateTipAmount('abc', 12).ok, false);
  assert.equal(validateTipAmount(Infinity, 12).ok, false);
  assert.equal(validateTipAmount(Number.POSITIVE_INFINITY, 12).ok, false);
  assert.equal(validateTipAmount(-1, 12).ok, false);
});

test('tips: cannot exceed the fare, and never the $100 hard cap', () => {
  assert.equal(validateTipAmount(50, 10).ok, false);       // > fare
  assert.equal(validateTipAmount(500, 1000).ok, false);    // > hard cap
  assert.equal(maxTipDollarsForFare(1000), 100);
  assert.equal(maxTipDollarsForFare(12.5), 13);
  assert.equal(maxTipDollarsForFare(0), 5);                // test rides keep a small allowance
  assert.equal(maxTipDollarsForFare(NaN), 5);
});
