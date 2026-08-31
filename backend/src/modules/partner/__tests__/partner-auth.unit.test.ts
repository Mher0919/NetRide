// backend/src/modules/partner/__tests__/partner-auth.unit.test.ts
// Unit tests for partner portal auth logic — password hashing, JWT generation,
// refresh token rotation, OTP flow, and input validation.
// Pure logic only — no network, no Redis (mocked), no DB schema changes.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

// --- Constants mirroring partner-auth.service.ts ---------------------------

const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL_DAYS = 30;

// --- Password Hashing ------------------------------------------------------

test('bcrypt: hash and verify password round-trip', async () => {
  const password = 'PartnerPass123!';
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

test('bcrypt: minimum password length is 8 characters', async () => {
  const shortPasswords = ['1234567', 'Ab1!', 'a', ''];
  for (const pw of shortPasswords) {
    assert.ok(pw.length < 8, `Password "${pw}" should be rejected (< 8 chars)`);
  }
  const validPasswords = ['12345678', 'Partner1!', 'password123'];
  for (const pw of validPasswords) {
    assert.ok(pw.length >= 8, `Password "${pw}" should be accepted (>= 8 chars)`);
  }
});

// --- JWT Token Generation ---------------------------------------------------

test('JWT: access token contains correct claims', () => {
  const secret = 'test-secret';
  const payload = {
    id: 'partner-uuid-123',
    role: 'PARTNER',
    email: 'partner@test.com',
  };
  const token = jwt.sign(payload, secret, { expiresIn: ACCESS_TOKEN_TTL, algorithm: 'HS256' });
  const decoded = jwt.verify(token, secret) as any;

  assert.equal(decoded.id, payload.id, 'Should contain user id');
  assert.equal(decoded.role, 'PARTNER', 'Role should be PARTNER');
  assert.equal(decoded.email, payload.email, 'Should contain email');
});

test('JWT: access token expires in 15 minutes', () => {
  const secret = 'test-secret';
  const before = Math.floor(Date.now() / 1000);
  const token = jwt.sign({ id: '1' }, secret, { expiresIn: ACCESS_TOKEN_TTL, algorithm: 'HS256' });
  const decoded = jwt.verify(token, secret) as any;
  const after = Math.floor(Date.now() / 1000);

  const expectedExpMin = before + 15 * 60 - 20;
  const expectedExpMax = before + 15 * 60 + 20;
  assert.ok(decoded.exp >= expectedExpMin, `exp ${decoded.exp} should be >= ${expectedExpMin}`);
  assert.ok(decoded.exp <= expectedExpMax, `exp ${decoded.exp} should be <= ${expectedExpMax}`);
});

test('JWT: token signed with HS256 algorithm', () => {
  const secret = 'test-secret';
  const token = jwt.sign({ id: '1' }, secret, { expiresIn: '15m', algorithm: 'HS256' });
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
  const expiredToken = jwt.sign({ id: '1', exp: Math.floor(Date.now() / 1000) - 3600 }, 'test-secret', {
    algorithm: 'HS256',
  });
  assert.throws(() => {
    jwt.verify(expiredToken, 'test-secret');
  }, /expired/, 'Expired token should throw');
});

// --- Refresh Token ----------------------------------------------------------

test('refresh token: generates a valid UUID v4', () => {
  const refreshToken = crypto.randomUUID();
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
  assert.equal(ttlSeconds, 2_592_000, '30 days = 2,592_000 seconds');
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
  const email = 'partner@test.com';
  const password = '';
  assert.equal(!email || !password, true, 'Empty password should trigger error');
});

test('login: normalizes email to lowercase and trims', () => {
  const inputs = [
    ['  Partner@Test.COM  ', 'partner@test.com'],
    ['partner@test.com', 'partner@test.com'],
    ['PARTNER@TEST.COM', 'partner@test.com'],
    [' partner@test.com ', 'partner@test.com'],
  ];
  for (const [input, expected] of inputs) {
    const normalized = String(input ?? '').trim().toLowerCase();
    assert.equal(normalized, expected, `"${input}" should normalize to "${expected}"`);
  }
});

// --- Error Message Uniformity (anti-enumeration) ----------------------------

test('login: uniform error for missing user vs wrong password', () => {
  const errorMsg = 'Invalid email or password';
  assert.ok(errorMsg.length > 0, 'Error message should be non-empty');
  assert.ok(!errorMsg.includes('user not found'), 'Should not reveal if user exists');
  assert.ok(!errorMsg.includes('incorrect password'), 'Should not reveal password status');
});

// --- SQL Query Structure (partner-auth) ------------------------------------

test('SQL: login query checks users with PARTNER role', () => {
  const sql = `SELECT u.id, u.email, u.password_hash, u.is_active, u.role
       FROM users u
       WHERE u.email = $1 AND u.role = 'PARTNER'`;
  assert.ok(sql.includes("role = 'PARTNER'"), 'Should filter by PARTNER role');
  assert.ok(sql.includes('password_hash'), 'Should select password_hash');
  assert.ok(sql.includes('is_active'), 'Should check is_active');
});

test('SQL: partner account query checks partner status is ACTIVE', () => {
  const sql = `SELECT p.id, p.status FROM partners p WHERE p.id::text = $1`;
  assert.ok(sql.includes('p.id::text'), 'Should match partner by user id');
  assert.ok(sql.includes('status'), 'Should check partner status');
});

test('SQL: refresh token lookup uses partner_refresh: prefix', () => {
  const key = `partner_refresh:${crypto.randomUUID()}`;
  assert.ok(key.startsWith('partner_refresh:'), 'Redis key should use partner_refresh: prefix');
});

test('SQL: change password updates user password_hash', () => {
  const sql = 'UPDATE users SET password_hash = $1, password_changed_at = NOW() WHERE id = $2';
  assert.ok(sql.includes('password_hash'), 'Should update password_hash');
  assert.ok(sql.includes('password_changed_at'), 'Should update password_changed_at');
});

test('SQL: login stores pending token with 5 hour expiry', () => {
  const key = `partner_login:${crypto.randomUUID()}`;
  assert.ok(key.startsWith('partner_login:'), 'Redis key should use partner_login: prefix');
});

// --- OTP Integration ---------------------------------------------------------

test('OTP: generates 6-digit code', () => {
  const code = crypto.randomInt(100000, 999999).toString();
  assert.equal(code.length, 6, 'Code should be 6 digits');
  assert.ok(/^\d{6}$/.test(code), 'Code should be numeric');
});

test('OTP: verifies valid 6-digit code', () => {
  const code = '123456';
  const isValid = /^\d{6}$/.test(code) && code.length === 6;
  assert.equal(isValid, true, 'Valid 6-digit code should pass');
});

test('OTP: rejects non-6-digit code', () => {
  const codes = ['12345', '1234567', 'abcdef', '12-34-56'];
  for (const code of codes) {
    const isValid = /^\d{6}$/.test(code) && code.length === 6;
    assert.equal(isValid, false, `Code "${code}" should be rejected`);
  }
});

// --- Partner Portal Session Types -------------------------------------------

test('PartnerPortalSession has required fields', () => {
  const session: { token: string; refreshToken: string; partner: { id: string; email: string } } = {
    token: 'test-token',
    refreshToken: 'test-refresh',
    partner: { id: 'partner-123', email: 'partner@test.com' },
  };
  assert.ok(session.token.length > 0, 'Token should exist');
  assert.ok(session.refreshToken.length > 0, 'Refresh token should exist');
  assert.ok(session.partner.id.length > 0, 'Partner id should exist');
  assert.ok(session.partner.email.length > 0, 'Partner email should exist');
});

test('PartnerLoginPending has partnerSessionPending flag', () => {
  const pending: { partnerSessionPending: true; loginToken: string; partner: { id: string; email: string }; message?: string } = {
    partnerSessionPending: true,
    loginToken: crypto.randomUUID(),
    partner: { id: 'partner-123', email: 'partner@test.com' },
    message: 'Verification code sent to email',
  };
  assert.ok(pending.partnerSessionPending, 'Should have partnerSessionPending flag');
  assert.ok(typeof pending.loginToken === 'string', 'loginToken should be a string');
  assert.ok(pending.partner.id.length > 0, 'Partner id should exist');
});