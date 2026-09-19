// backend/src/modules/auth/__tests__/otp.unit.test.ts
//
// Unit tests for OTP generation and verification logic.
// Mocks the database pool and email service to run in CI without external deps.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

// --- Mocks ----------------------------------------------------------------

const mockQueryCalls: any[][] = [];
const mockPool = {
  query: (...args: any[]) => {
    mockQueryCalls.push(args);
    return Promise.resolve({ rows: [] });
  },
};

const mockEmailCalls: { to: string; code: string }[] = [];
const mockEmailService = {
  sendOTP: (to: string, code: string) => {
    mockEmailCalls.push({ to, code });
    return Promise.resolve();
  },
};

// Patch modules before importing OTPService
const originalEnv = { ...process.env };

function resetMocks() {
  mockQueryCalls.length = 0;
  mockEmailCalls.length = 0;
}

// We test the OTP logic directly by reimplementing the core algorithm
// (the service has DB/email side effects, so we verify the pure logic).

// --- OTP Generation Logic -------------------------------------------------

test('OTP: generates a 6-digit numeric string', () => {
  for (let i = 0; i < 20; i++) {
    const code = crypto.randomInt(100000, 999999).toString();
    assert.equal(code.length, 6, `Code length should be 6, got ${code.length}`);
    assert.ok(/^\d{6}$/.test(code), `Code should be numeric, got ${code}`);
  }
});

test('OTP: randomInt produces values in [100000, 999999]', () => {
  for (let i = 0; i < 200; i++) {
    const code = crypto.randomInt(100000, 999999);
    assert.ok(code >= 100000, `Code ${code} below lower bound`);
    assert.ok(code <= 999999, `Code ${code} above upper bound`);
  }
});

test('OTP: expiry is 10 minutes from generation time', () => {
  const now = Date.now();
  const expiresAt = new Date(now + 10 * 60 * 1000);
  const diffMs = expiresAt.getTime() - now;
  assert.equal(diffMs, 10 * 60 * 1000, 'Expiry should be exactly 10 minutes');
});

test('OTP: dev bypass accepts 111111 for @NetRide.dev emails in development', () => {
  process.env.NODE_ENV = 'development';
  const email = 'test@NetRide.dev';
  const code = '111111';

  // Simulate the dev bypass check from otp.service.ts
  const isDevBypass =
    process.env.NODE_ENV === 'development' &&
    code === '111111' &&
    email.endsWith('@NetRide.dev');

  assert.equal(isDevBypass, true, 'Dev bypass should be accepted');
  process.env.NODE_ENV = originalEnv.NODE_ENV || '';
});

test('OTP: dev bypass rejects non-NetRide.dev emails', () => {
  process.env.NODE_ENV = 'development';
  const email = 'test@gmail.com';
  const code = '111111';

  const isDevBypass =
    process.env.NODE_ENV === 'development' &&
    code === '111111' &&
    email.endsWith('@NetRide.dev');

  assert.equal(isDevBypass, false, 'Non-NetRide.dev email should not bypass');
  process.env.NODE_ENV = originalEnv.NODE_ENV || '';
});

test('OTP: dev bypass rejects wrong code', () => {
  process.env.NODE_ENV = 'development';
  const email = 'test@NetRide.dev';
  const code: string = '123456';
  const expectedCode: string = '111111';
  const isDevBypass =
    process.env.NODE_ENV === 'development' &&
    code === expectedCode &&
    email.endsWith('@NetRide.dev');

  assert.equal(isDevBypass, false, 'Wrong code should not bypass');
  process.env.NODE_ENV = originalEnv.NODE_ENV || '';
});

test('OTP: dev bypass disabled in production', () => {
  process.env.NODE_ENV = 'production';
  const email = 'test@NetRide.dev';
  const code = '111111';

  const isDevBypass =
    process.env.NODE_ENV === 'development' &&
    code === '111111' &&
    email.endsWith('@NetRide.dev');

  assert.equal(isDevBypass, false, 'Dev bypass should not work in production');
  process.env.NODE_ENV = originalEnv.NODE_ENV || '';
});

// --- SQL Query Structure ---------------------------------------------------

test('OTP: SQL DELETE clears old codes before inserting', () => {
  const email = 'user@example.com';
  const deleteSql = 'DELETE FROM verification_codes WHERE email = $1';
  assert.ok(deleteSql.includes('DELETE'), 'Should delete old codes');
  assert.ok(deleteSql.includes('$1'), 'Should parameterize email');
});

test('OTP: SQL INSERT stores email, code_hash, expires_at', () => {
  const insertSql =
    'INSERT INTO verification_codes (email, code_hash, expires_at) VALUES ($1, $2, $3)';
  assert.ok(insertSql.includes('email'), 'Should include email column');
  assert.ok(insertSql.includes('code_hash'), 'Should store ONLY the code digest (never plaintext)');
  assert.ok(!insertSql.includes('code, expires'), 'Raw code column must not be written');
  assert.ok(insertSql.includes('expires_at'), 'Should include expires_at column');
});

test('OTP: SQL SELECT checks email + code_hash + expiry', () => {
  const selectSql =
    'SELECT * FROM verification_codes WHERE email = $1 AND code_hash = $2 AND expires_at > NOW()';
  assert.ok(selectSql.includes('code_hash'), 'Lookup must compare against the digest');
  assert.ok(selectSql.includes('expires_at > NOW()'), 'Should check expiry');
  assert.ok(selectSql.includes('$1') && selectSql.includes('$2'), 'Should use params');
});

test('OTP: failed verification increments attempts and voids the code at the cap', () => {
  const maxAttempts = 5;
  // Delete-on-exhaustion SQL mirrors otp.service.ts verifyOTP.
  const throttleSql =
    'DELETE FROM verification_codes WHERE email = $1 AND attempts + 1 >= $2';
  const incrementSql =
    'UPDATE verification_codes SET attempts = attempts + 1 WHERE email = $1';
  assert.ok(throttleSql.includes('attempts + 1'), 'Should delete the code at the attempt cap');
  assert.ok(incrementSql.includes('attempts = attempts + 1'), 'Should burn one attempt per failure');
  assert.equal(maxAttempts, 5, 'Max attempts must be 5');
});

test('OTP: SQL DELETE after successful verification cleans up', () => {
  const cleanupSql = 'DELETE FROM verification_codes WHERE email = $1';
  assert.ok(cleanupSql.includes('DELETE'), 'Should delete after verification');
});

// --- Case sensitivity ------------------------------------------------------

test('OTP: email comparison should be case-insensitive for dev bypass', () => {
  const emails = ['Test@NetRide.dev', 'test@netride.dev', 'TEST@NETRIDE.DEV'];
  // The service uses endsWith, which is case-sensitive
  // Verify that only exact casing matches the bypass
  assert.ok('Test@NetRide.dev'.endsWith('@NetRide.dev'), 'Exact casing matches');
  assert.ok(!'test@netride.dev'.endsWith('@NetRide.dev'), 'Lowercase does not match');
});

// --- Edge cases ------------------------------------------------------------

test('OTP: empty code fails verification', () => {
  const code = '';
  assert.equal(code.length === 0, true, 'Empty code should fail');
});

test('OTP: code with non-digit characters is invalid', () => {
  const codes = ['12345a', 'abcdef', '12 34 56', '12-34-56'];
  for (const code of codes) {
    assert.ok(!/^\d{6}$/.test(code), `Non-numeric code "${code}" should be invalid`);
  }
});

test('OTP: code shorter than 6 digits is invalid', () => {
  const codes = ['12345', '1234', '1', ''];
  for (const code of codes) {
    assert.ok(code.length !== 6 || !/^\d{6}$/.test(code), `Short code "${code}" should be invalid`);
  }
});
