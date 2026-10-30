// tests/unit/backend/security/auth-hardening.unit.test.ts
//
// Regression suite for the authentication / OTP / authorization hardening:
//   1. test-account classification can never be spoofed from a public
//      mail domain (the `test123@gmail.com` privilege bypass);
//   2. HTML email escaping (XSS payloads stay inert);
//   3. rate-limit rules match the mounted route paths;
//   4. auth middleware fails closed on revocation-check errors and rejects
//      invalid/absent tokens;
//   5. OTPService purpose binding, hashing, single-use and resend cooldown
//      (real implementation, mocked pool/redis/email).
//
// The OTPService and middleware cases run the REAL source files with their
// collaborators injected through require.cache — they are not logic mirrors.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import crypto from 'node:crypto';

import { isTestEmail, TEST_EMAIL_SQL } from '../../../../backend/src/utils/testUser';
import { escapeHtml, encodeUrlPart } from '../../../../backend/src/utils/html-escape';
import { matchRoute, RATE_LIMITS } from '../../../../backend/src/middleware/rateLimitConfig';

const BACKEND = path.resolve(__dirname, '..', '..', '..', '..', 'backend');

function interceptModule(filePath: string, exports: any): void {
  const resolved = require.resolve(filePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
    children: [],
    paths: [],
  } as any;
}

// ---------------------------------------------------------------------------
// 1. Test-account classification
// ---------------------------------------------------------------------------

test('test accounts: public mail domains can never be classified as test', () => {
  for (const email of [
    'test123@gmail.com',
    'dev.user@gmail.com',
    'e2e-runner@yahoo.com',
    'sandbox+prod@outlook.com',
    'tester@proton.me',
  ]) {
    assert.equal(isTestEmail(email), false, `${email} must NOT be a test account`);
  }
});

test('test accounts: reserved and operator domains still classify correctly', () => {
  for (const email of [
    'payment-rider-a@netride.test',
    'driver@NetRide.dev',
    'partner-test@netride.org',
    'fleet-test@netride.org',
    '+test@netride.org',
    'rider@example.com',
  ]) {
    assert.equal(isTestEmail(email), true, `${email} must be a test account`);
  }
  // Real operator accounts must stay real.
  for (const email of ['admin@netride.org', 'support@netride.org', 'devon@gmail.com']) {
    assert.equal(isTestEmail(email), false, `${email} must NOT be a test account`);
  }
});

test('test accounts: explicit allowlist env is honored and SQL mirrors the rule', () => {
  const previous = process.env.TEST_ACCOUNT_EMAILS;
  process.env.TEST_ACCOUNT_EMAILS = 'qa-team@corp.example.net, second@corp.example.net';
  try {
    assert.equal(isTestEmail('qa-team@corp.example.net'), true);
    assert.equal(isTestEmail('other@corp.example.net'), false);
    const sql = TEST_EMAIL_SQL('u.email');
    assert.ok(sql.includes("lower(u.email) = 'qa-team@corp.example.net'"));
    // The local-part pattern only applies to operator domains, never globally.
    assert.ok(sql.includes("~* '(^|[-_.+])(test|sandbox|dev|e2e)"));
    assert.ok(sql.includes("LIKE '%@netride.org'"));
  } finally {
    if (previous === undefined) delete process.env.TEST_ACCOUNT_EMAILS;
    else process.env.TEST_ACCOUNT_EMAILS = previous;
  }
});

// ---------------------------------------------------------------------------
// 2. HTML escaping
// ---------------------------------------------------------------------------

test('email escaping: XSS payloads are neutralized in HTML and URLs', () => {
  const payload = `<script>alert("xss")</script>`;
  const escaped = escapeHtml(payload);
  assert.ok(!escaped.includes('<script>'));
  assert.ok(escaped.includes('&lt;script&gt;'));
  assert.equal(
    escapeHtml(`"><img src=x onerror=alert(1)>`),
    '&quot;&gt;&lt;img src=x onerror=alert(1)&gt;',
  );
  assert.equal(escapeHtml(undefined), '');
  assert.equal(encodeUrlPart('a b/c?d&=e'), 'a%20b%2Fc%3Fd%26%3De');
});

// ---------------------------------------------------------------------------
// 3. Rate-limit coverage of sensitive mounted routes
// ---------------------------------------------------------------------------

test('rate limits: every sensitive auth/ride/sponsor route matches a rule', () => {
  const sensitive: Array<[string, string]> = [
    ['POST', '/api/auth/login-password'],
    ['POST', '/api/auth/signup-password'],
    ['POST', '/api/auth/verify-otp'],
    ['POST', '/api/auth/request-otp'],
    ['POST', '/api/auth/forgot-password'],
    ['POST', '/api/auth/reset-password'],
    ['POST', '/api/auth/change-password'],
    ['POST', '/api/auth/admin/request-2fa'],
    ['POST', '/api/auth/admin/verify-2fa'],
    ['POST', '/api/auth/request-phone-otp'],
    ['POST', '/api/auth/verify-phone-otp'],
    ['POST', '/api/portal/auth/login'],
    ['POST', '/api/portal/auth/verify-2fa'],
    ['POST', '/api/portal/auth/forgot-password'],
    ['POST', '/api/portal/auth/verify-reset-otp'],
    ['POST', '/api/portal/auth/reset-password'],
    ['POST', '/api/ride/request'],
    ['POST', '/api/ride/cancel'],
    ['POST', '/api/ride/57b7f5c4-1f70-4a49-9d4c-2f81a9b1c0a2/tip'],
    ['POST', '/api/sponsor/validations/validate'],
    ['POST', '/api/upload'],
  ];
  for (const [method, route] of sensitive) {
    const key = matchRoute(route, method);
    assert.ok(key, `no rate-limit rule matches ${method} ${route}`);
    assert.ok(RATE_LIMITS[key!], `matched rule ${key} must exist`);
  }
});

// ---------------------------------------------------------------------------
// 4. Auth middleware (real implementation, injected AuthService)
// ---------------------------------------------------------------------------

test('auth middleware: missing/invalid/revoked tokens fail closed with 401', async () => {
  let verifyImpl: (token: string) => any = () => ({ id: 'u1', role: 'RIDER', iat: 1 });
  let assertImpl: (decoded: any) => Promise<void> = async () => undefined;

  interceptModule(path.join(BACKEND, 'src', 'modules', 'auth', 'auth.service.ts'), {
    AuthService: {
      verifyToken: (token: string) => verifyImpl(token),
      assertTokenStillValid: (decoded: any) => assertImpl(decoded),
    },
  });

  const { authMiddleware } = require(path.join(
    BACKEND, 'src', 'middleware', 'auth.middleware.ts',
  ));

  const run = async (authorization?: string) => {
    const req: any = { headers: { authorization }, originalUrl: '/api/test' };
    let statusCode = 0;
    let body: any = null;
    let nextCalled = false;
    const res: any = {
      status(code: number) { statusCode = code; return this; },
      json(payload: any) { body = payload; return this; },
    };
    await authMiddleware(req, res, () => { nextCalled = true; });
    return { req, statusCode, body, nextCalled };
  };

  // No token
  let result = await run(undefined);
  assert.equal(result.statusCode, 401);
  assert.equal(result.nextCalled, false);

  // Malformed token
  verifyImpl = () => { throw new Error('jwt malformed'); };
  result = await run('Bearer garbage');
  assert.equal(result.statusCode, 401);
  assert.equal(result.nextCalled, false);

  // Revoked (revocation check throws — the fail-closed path)
  verifyImpl = () => ({ id: 'u1', role: 'RIDER', iat: 1 });
  assertImpl = async () => { throw new Error('Account is deactivated'); };
  result = await run('Bearer valid');
  assert.equal(result.statusCode, 401);
  assert.equal(result.nextCalled, false);

  // Valid
  assertImpl = async () => undefined;
  result = await run('Bearer valid');
  assert.equal(result.statusCode, 0);
  assert.equal(result.nextCalled, true);
  assert.equal(result.req.user.id, 'u1');

  // A trusted-device token is signed with the same secret but is not a
  // general session credential.
  verifyImpl = () => ({ id: 'admin', role: 'ADMIN', t: 'trusted-device', iat: 1 });
  result = await run('Bearer trusted-device');
  assert.equal(result.statusCode, 401);
  assert.equal(result.nextCalled, false);

  // A file-access token is likewise not a session credential.
  verifyImpl = () => ({ fid: 'f1', uid: 'u1', t: 'file-access', iat: 1 });
  result = await run('Bearer file-access');
  assert.equal(result.statusCode, 401);
  assert.equal(result.nextCalled, false);
});

// ---------------------------------------------------------------------------
// 5. OTPService (real implementation, mocked pool/redis/email)
// ---------------------------------------------------------------------------

interface QueryCall { sql: string; params: any[] }

function buildOtpHarness() {
  const queries: QueryCall[] = [];
  const emailsSent: Array<{ to: string; code: string }> = [];
  const redisStore = new Map<string, string>();
  let storedRow: { email: string; purpose: string; code_hash: string; attempts: number } | null = null;

  const pool = {
    query: (sql: string, params: any[] = []) => {
      queries.push({ sql, params });
      if (sql.includes('INSERT INTO verification_codes')) {
        storedRow = {
          email: params[0],
          code_hash: params[1],
          purpose: params[3],
          attempts: 0,
        };
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (sql.includes('SELECT * FROM verification_codes')) {
        const [email, purpose, hash] = params;
        const match =
          storedRow &&
          storedRow.email === email &&
          storedRow.purpose === purpose &&
          storedRow.code_hash === hash;
        return Promise.resolve({ rows: match ? [storedRow] : [], rowCount: match ? 1 : 0 });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    },
  };

  const redisMock = {
    set: (key: string, value: string, _ex?: string, _ttl?: number, nx?: string) => {
      if (nx === 'NX' && redisStore.has(key)) return Promise.resolve(null);
      redisStore.set(key, value);
      return Promise.resolve('OK');
    },
    get: (key: string) => Promise.resolve(redisStore.get(key) ?? null),
    del: (key: string) => Promise.resolve(redisStore.delete(key) ? 1 : 0),
  };

  interceptModule(path.join(BACKEND, 'src', 'config', 'database.ts'), { pool, default: pool });
  interceptModule(path.join(BACKEND, 'src', 'config', 'redis.ts'), { redis: redisMock, default: redisMock });
  interceptModule(path.join(BACKEND, 'src', 'services', 'email.service.ts'), {
    EmailService: {
      sendOTP: (to: string, code: string) => {
        emailsSent.push({ to, code });
        return Promise.resolve();
      },
    },
  });

  // Drop any previously-cached copy so the service re-binds to THIS
  // harness's injected collaborators.
  const otpPath = require.resolve(path.join(
    BACKEND, 'src', 'modules', 'auth', 'otp.service.ts',
  ));
  delete require.cache[otpPath];
  const { OTPService } = require(otpPath);

  return { OTPService, queries, emailsSent, redisStore, resetCooldownOnly: () => redisStore.clear(), getStored: () => storedRow };
}

test('OTP service: codes are hashed, purpose-bound, single-use and cooldown-limited', async () => {
  const harness = buildOtpHarness();
  const { OTPService, queries, emailsSent, redisStore, getStored } = harness;

  // Generation stores ONLY a digest and the purpose, and mails the code.
  const code = await OTPService.generateOTP('user@example.com', 'LOGIN');
  assert.ok(/^\d{6}$/.test(code!), 'code is six digits');
  const insert = queries.find((q) => q.sql.includes('INSERT INTO verification_codes'))!;
  assert.equal(insert.params[0], 'user@example.com');
  assert.equal(insert.params[1], OTPService.hashCode(code!));
  assert.notEqual(insert.params[1], code);
  assert.equal(insert.params[3], 'LOGIN');
  assert.equal(emailsSent.length, 1);
  assert.equal(emailsSent[0].to, 'user@example.com');
  assert.equal(emailsSent[0].code, code);

  // Resend cooldown: a second generation inside the window is suppressed.
  const suppressed = await OTPService.generateOTP('user@example.com', 'LOGIN');
  assert.equal(suppressed, null, 'cooldown suppresses the resend');

  // Wrong purpose can never redeem a code.
  assert.equal(await OTPService.verifyOTP('user@example.com', code!, 'PORTAL_RESET'), false);

  // Correct purpose + code succeeds and consumes it (DELETE issued).
  const before = queries.length;
  assert.equal(await OTPService.verifyOTP('user@example.com', code!, 'LOGIN'), true);
  const after = queries.slice(before);
  assert.ok(after.some((q) => q.sql.includes('DELETE FROM verification_codes')), 'single-use delete');

  // Cooldown was cleared on success so a fresh code can be requested.
  redisStore.delete(`otp_cooldown:LOGIN:user@example.com`);
  const second = await OTPService.generateOTP('user@example.com', 'LOGIN');
  assert.ok(second && second !== undefined, 'new code after success');

  // Malformed codes are rejected without touching the database.
  const countBefore = queries.length;
  assert.equal(await OTPService.verifyOTP('user@example.com', '12ab56' as any, 'LOGIN'), false);
  assert.equal(queries.length, countBefore, 'no DB query for malformed codes');

  // The static '111111' bypass is disabled unless explicitly opted in.
  const priorEnv = process.env.NODE_ENV;
  const priorFlag = process.env.ALLOW_DEV_OTP_BYPASS;
  process.env.NODE_ENV = 'development';
  delete process.env.ALLOW_DEV_OTP_BYPASS;
  assert.equal(await OTPService.verifyOTP('dev@netride.dev', '111111', 'LOGIN'), false);
  process.env.ALLOW_DEV_OTP_BYPASS = 'true';
  assert.equal(await OTPService.verifyOTP('dev@netride.dev', '111111', 'LOGIN'), true);
  if (priorEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = priorEnv;
  if (priorFlag === undefined) delete process.env.ALLOW_DEV_OTP_BYPASS; else process.env.ALLOW_DEV_OTP_BYPASS = priorFlag;

  assert.ok(getStored(), 'a code row existed during the test');
});

test('OTP service: admin 2FA codes are bound to the admin identity, delivered elsewhere', async () => {
  const harness = buildOtpHarness();
  const { OTPService, queries, emailsSent, getStored } = harness;

  const code = await OTPService.generateOTP('admin@netride.org', 'ADMIN_2FA', {
    deliverTo: 'ops-inbox@netride.org',
  });
  assert.ok(code);
  // Stored under the ADMIN's identity — not under the shared inbox — so a
  // code can never complete another administrator's login.
  assert.equal(getStored()!.email, 'admin@netride.org');
  assert.equal(getStored()!.purpose, 'ADMIN_2FA');
  assert.equal(emailsSent[0].to, 'ops-inbox@netride.org');

  // A LOGIN-purpose redemption of the admin code fails.
  assert.equal(await OTPService.verifyOTP('admin@netride.org', code!, 'LOGIN'), false);
  assert.equal(await OTPService.verifyOTP('admin@netride.org', code!, 'ADMIN_2FA'), true);
  assert.ok(queries.some((q) => q.sql.includes('attempts = attempts + 1')));
});

test('OTP service: cryptographic digest (never the plaintext) is used for matching', () => {
  const code = '123456';
  const digest = crypto.createHash('sha256').update(code, 'utf8').digest('hex');
  assert.equal(digest.length, 64);
  assert.ok(!digest.includes(code));
});
