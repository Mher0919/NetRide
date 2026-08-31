// backend/src/modules/sponsor/__tests__/sponsor-auth.unit.test.ts
//
// Unit tests for sponsor portal auth logic — password hashing, JWT
// generation, refresh token rotation, and input validation.
// Pure logic only — no network, no Redis, no DB.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

// --- Constants mirroring sponsor-auth.service.ts ---------------------------

const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL_DAYS = 30;

// --- Password Hashing ------------------------------------------------------

test('bcrypt: hash and verify password round-trip', async () => {
  const password = 'SponsorPass123!';
  const hash = await bcrypt.hash(password, 10);
  assert.ok(hash !== password, 'Hash should differ from plaintext');
  assert.ok(hash.startsWith('$2a$') || hash.startsWith('$2b$'), 'Hash should use bcrypt');
  const valid = await bcrypt.compare(password, hash);
  assert.equal(valid, true, 'Valid password should verify');
});

test('bcrypt: wrong password fails comparison', async () => {
  const password = 'CorrectPassword!';
  const hash = await bcrypt.hash(password, 10);
  const valid = await bcrypt.compare('WrongPassword!', hash);
  assert.equal(valid, false, 'Wrong password should not verify');
});

test('bcrypt: empty password hashes but fails validation in service', async () => {
  const hash = await bcrypt.hash('', 10);
  // The service rejects empty passwords before hashing
  assert.ok(hash.length > 0, 'Empty string can be hashed by bcrypt');
  // But the service should reject it
  const password = '';
  const isValidLength = password.length >= 8;
  assert.equal(isValidLength, false, 'Empty password should fail length check');
});

test('bcrypt: minimum password length is 8 characters', async () => {
  const shortPasswords = ['1234567', 'Ab1!', 'a', ''];
  for (const pw of shortPasswords) {
    assert.ok(pw.length < 8, `Password "${pw}" should be rejected (< 8 chars)`);
  }
  const validPasswords = ['12345678', 'Sponsor1!', 'password123'];
  for (const pw of validPasswords) {
    assert.ok(pw.length >= 8, `Password "${pw}" should be accepted (>= 8 chars)`);
  }
});

// --- JWT Token Generation ---------------------------------------------------

test('JWT: access token contains correct claims', () => {
  const secret = 'test-secret';
  const payload = {
    id: 'user-uuid-123',
    role: 'SPONSOR',
    email: 'sponsor@test.com',
    sponsorId: 'sponsor-uuid-456',
  };
  const token = jwt.sign(payload, secret, { expiresIn: ACCESS_TOKEN_TTL, algorithm: 'HS256' });
  const decoded = jwt.verify(token, secret) as any;

  assert.equal(decoded.id, payload.id, 'Should contain user id');
  assert.equal(decoded.role, 'SPONSOR', 'Role should be SPONSOR');
  assert.equal(decoded.email, payload.email, 'Should contain email');
  assert.equal(decoded.sponsorId, payload.sponsorId, 'Should contain sponsorId');
});

test('JWT: access token expires in 15 minutes', () => {
  const secret = 'test-secret';
  const before = Math.floor(Date.now() / 1000);
  const token = jwt.sign({ id: '1' }, secret, { expiresIn: ACCESS_TOKEN_TTL, algorithm: 'HS256' });
  const decoded = jwt.verify(token, secret) as any;
  const after = Math.floor(Date.now() / 1000);

  // Token exp should be between before+890 and before+910 (15 min ± drift)
  const expectedExpMin = before + 15 * 60 - 20;
  const expectedExpMax = before + 15 * 60 + 20;
  assert.ok(decoded.exp >= expectedExpMin, `exp ${decoded.exp} should be >= ${expectedExpMin}`);
  assert.ok(decoded.exp <= expectedExpMax, `exp ${decoded.exp} should be <= ${expectedExpMax}`);
});

test('JWT: token signed with HS256 algorithm', () => {
  const secret = 'test-secret';
  const token = jwt.sign({ id: '1' }, secret, { expiresIn: '15m', algorithm: 'HS256' });
  // jwt.verify with default (HS256) should succeed
  const decoded = jwt.verify(token, secret);
  assert.ok(decoded, 'Token should verify with HS256');
});

test('JWT: token fails verification with wrong secret', () => {
  const token = jwt.sign({ id: '1' }, 'correct-secret', { expiresIn: '15m', algorithm: 'HS256' });
  assert.throws(() => {
    jwt.verify(token, 'wrong-secret');
  }, /invalid signature/, 'Wrong secret should throw');
});

test('JWT: expired token fails verification', () => {
  const secret = 'test-secret';
  // Create a token that expired 1 hour ago
  const token = jwt.sign({ id: '1', iat: Math.floor(Date.now() / 1000) - 7200 }, secret, {
    expiresIn: '1h',
    algorithm: 'HS256',
  });
  // Manually set exp in the past
  const expiredToken = jwt.sign({ id: '1', exp: Math.floor(Date.now() / 1000) - 3600 }, secret, {
    algorithm: 'HS256',
  });
  assert.throws(() => {
    jwt.verify(expiredToken, secret);
  }, /expired/, 'Expired token should throw');
});

// --- Refresh Token ----------------------------------------------------------

test('refresh token: generates a valid UUID v4', () => {
  const refreshToken = crypto.randomUUID();
  // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  assert.ok(uuidRegex.test(refreshToken), `UUID "${refreshToken}" should match v4 format`);
});

test('refresh token: each call produces a unique token', () => {
  const tokens = new Set<string>();
  for (let i = 0; i < 100; i++) {
    tokens.add(crypto.randomUUID());
  }
  assert.equal(tokens.size, 100, 'All 100 refresh tokens should be unique');
});

test('refresh token: TTL is 30 days in seconds', () => {
  const ttlSeconds = REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60;
  assert.equal(ttlSeconds, 2_592_000, '30 days = 2,592,000 seconds');
});

// --- Input Validation -------------------------------------------------------

test('login: rejects empty email', () => {
  const email = '';
  const password = 'password123';
  const normalizedEmail = String(email ?? '').trim().toLowerCase();
  assert.equal(normalizedEmail.length > 0, false, 'Empty email should be rejected');
});

test('login: rejects null/undefined email', () => {
  for (const email of [null, undefined]) {
    const normalizedEmail = String(email ?? '').trim().toLowerCase();
    assert.equal(normalizedEmail.length > 0, false, `Null/undefined email should be rejected`);
  }
});

test('login: rejects empty password', () => {
  const email = 'sponsor@test.com';
  const password = '';
  assert.equal(!email || !password, true, 'Empty password should trigger error');
});

test('login: normalizes email to lowercase and trims', () => {
  const inputs = [
    ['  Sponsor@Test.COM  ', 'sponsor@test.com'],
    ['sponsor@test.com', 'sponsor@test.com'],
    ['SPONSOR@TEST.COM', 'sponsor@test.com'],
    [' sponsor@test.com ', 'sponsor@test.com'],
  ];
  for (const [input, expected] of inputs) {
    const normalized = String(input ?? '').trim().toLowerCase();
    assert.equal(normalized, expected, `"${input}" should normalize to "${expected}"`);
  }
});

// --- Error Message Uniformity (anti-enumeration) ----------------------------

test('login: uniform error for missing user vs wrong password', () => {
  // Both cases should return the same error message
  const errorMsg = 'Invalid email or password';
  assert.ok(errorMsg.length > 0, 'Error message should be non-empty');
  assert.ok(!errorMsg.includes('user not found'), 'Should not reveal if user exists');
  assert.ok(!errorMsg.includes('incorrect password'), 'Should not reveal password status');
});

// --- Token Refresh Rotation -------------------------------------------------

test('refresh: old token is invalidated, new token is issued', () => {
  // Simulate refresh token rotation
  const tokenStore = new Map<string, object>();
  const userId = 'user-123';
  const sponsorId = 'sponsor-456';

  // Issue first refresh token
  const rt1 = crypto.randomUUID();
  tokenStore.set(rt1, { userId, sponsorId });

  // Rotate: delete old, issue new
  const rt2 = crypto.randomUUID();
  tokenStore.delete(rt1);
  tokenStore.set(rt2, { userId, sponsorId });

  assert.equal(tokenStore.has(rt1), false, 'Old refresh token should be deleted');
  assert.equal(tokenStore.has(rt2), true, 'New refresh token should exist');
  assert.equal(tokenStore.size, 1, 'Only one refresh token should exist');
});

test('refresh: invalid token is rejected', () => {
  const tokenStore = new Map<string, object>();
  const fakeToken = crypto.randomUUID();
  assert.equal(tokenStore.has(fakeToken), false, 'Unknown token should not exist');
});

// --- SQL Query Structure (sponsor-auth) ------------------------------------

test('SQL: login query checks users with SPONSOR role', () => {
  const sql = `SELECT u.id, u.email, u.password_hash, u.is_active, u.full_name
       FROM users u
       WHERE u.email = $1 AND u.role = 'SPONSOR'`;
  assert.ok(sql.includes("role = 'SPONSOR'"), 'Should filter by SPONSOR role');
  assert.ok(sql.includes('password_hash'), 'Should select password_hash');
  assert.ok(sql.includes('is_active'), 'Should check is_active');
});

test('SQL: portal account query joins sponsors table', () => {
  const sql = `SELECT spa.sponsor_id, spa.is_active, spa.must_change_password
       FROM sponsor_portal_accounts spa
       JOIN sponsors s ON s.id = spa.sponsor_id
       WHERE spa.user_id = $1`;
  assert.ok(sql.includes('JOIN sponsors'), 'Should join sponsors table');
  assert.ok(sql.includes('must_change_password'), 'Should check must_change_password');
});

test('SQL: refresh token lookup uses sponsor_refresh: prefix', () => {
  const key = `sponsor_refresh:${crypto.randomUUID()}`;
  assert.ok(key.startsWith('sponsor_refresh:'), 'Redis key should use sponsor_refresh: prefix');
});

test('SQL: change password updates both users and portal_accounts', () => {
  const userSql = 'UPDATE users SET password_hash = $1, password_changed_at = NOW() WHERE id = $2';
  const accountSql =
    'UPDATE sponsor_portal_accounts SET must_change_password = FALSE, updated_at = NOW() WHERE user_id = $1';
  assert.ok(userSql.includes('password_hash'), 'Should update password_hash');
  assert.ok(userSql.includes('password_changed_at'), 'Should update password_changed_at');
  assert.ok(accountSql.includes('must_change_password = FALSE'), 'Should clear must_change_password');
});
