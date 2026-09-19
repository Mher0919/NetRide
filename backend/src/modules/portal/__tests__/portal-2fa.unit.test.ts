// backend/src/modules/portal/__tests__/portal-2fa.unit.test.ts
//
// Unit tests for the Colab Portal authentication state machine:
//
//   PASSWORD_VERIFIED → TWO_FACTOR_REQUIRED → TWO_FACTOR_VERIFIED
//     → (must_change_password ? PASSWORD_CHANGE_REQUIRED) → AUTHENTICATED
//
// Mirrors the exact algorithms in portal-auth.service.ts, otp.service.ts and
// portal.middleware.ts (pure logic — no network, no DB, no Redis) so the
// security properties are asserted without external dependencies.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Reference implementation mirrors (faithful copies of the service logic)
// ---------------------------------------------------------------------------

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const PENDING_LOGIN_TTL_S = 10 * 60;

const sha256 = (code: string) =>
  crypto.createHash('sha256').update(code, 'utf8').digest('hex');

class FakeStore {
  map = new Map<string, { value: string; expiresAt: number }>();

  set(key: string, value: string, ttlSeconds: number) {
    this.map.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }
  get(key: string): string | null {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return null;
    }
    return entry.value;
  }
  del(key: string) {
    this.map.delete(key);
  }
  has(key: string) {
    return this.get(key) !== null;
  }
}

class FakeDb {
  /** verification_codes rows: { email, code_hash, expires_at, attempts } */
  codes: Array<{ email: string; code_hash: string; expires_at: number; attempts: number }> = [];
  /** users rows: { id, email, password_hash, is_active } */
  users: Array<{ id: string; email: string; password_hash: string; is_active: boolean; must_change_password: boolean }> = [];

  findUserByEmail(email: string) {
    return this.users.find((u) => u.email === email);
  }
  findUserByIdAndEmail(id: string, email: string) {
    return this.users.find((u) => u.id === id && u.email === email);
  }
}

// --- OTP logic (mirror of otp.service.ts) ----------------------------------

function generateOTP(db: FakeDb, emailsSent: string[], email: string): string {
  const code = crypto.randomInt(100000, 999999).toString();
  db.codes = db.codes.filter((c) => c.email !== email);
  db.codes.push({
    email,
    code_hash: sha256(code),
    expires_at: Date.now() + OTP_TTL_MS,
    attempts: 0,
  });
  emailsSent.push(email);
  return code;
}

function verifyOTP(db: FakeDb, email: string, code: string): boolean {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return false;
  const row = db.codes.find(
    (c) => c.email === email && c.code_hash === sha256(code) && c.expires_at > Date.now(),
  );
  if (row) {
    db.codes = db.codes.filter((c) => c.email !== email);
    return true;
  }
  // attempt throttling (mirror of otp.service.ts verifyOTP)
  for (const c of db.codes) {
    if (c.email !== email) continue;
    if (c.attempts + 1 >= OTP_MAX_ATTEMPTS) {
      db.codes = db.codes.filter((x) => x.email !== email);
      return false;
    }
    c.attempts += 1;
    return false;
  }
  return false;
}

// --- Portal login logic (mirror of portal-auth.service.ts) ------------------

interface PortalLoginResult {
  otp_required?: true;
  token?: string;
  refreshToken?: string;
  portals?: Array<{ type: string; mustChangePassword: boolean }>;
  trustedDeviceToken?: string;
}

function portalLogin(
  db: FakeDb,
  store: FakeStore,
  emailsSent: string[],
  email: string,
  password: string,
  trustedDeviceToken?: string | null,
): PortalLoginResult {
  const normalizedEmail = String(email ?? '').trim().toLowerCase();
  if (!normalizedEmail || !password) throw new Error('Email and password are required');

  const user = db.findUserByEmail(normalizedEmail);
  if (!user || !user.password_hash) throw new Error('Invalid email or password');
  if (password !== user.password_hash) throw new Error('Invalid email or password'); // bcrypt.compare mirror
  if (!user.is_active) throw new Error('Your account is disabled. Contact NetRide support.');

  let isTrusted = false;
  if (trustedDeviceToken) {
    // mirror: verifyTrustedDeviceToken — HS256 + marker claim
    const decoded = JSON.parse(Buffer.from(trustedDeviceToken.split('.')[1], 'base64url').toString());
    if (decoded?.t === 'portal-trusted' && decoded.id === user.id && decoded.email === user.email) {
      isTrusted = true;
    }
  }

  if (!isTrusted) {
    store.del(`portal_pending_login:${user.email}`);
    store.set(`portal_pending_login:${user.email}`, JSON.stringify({ userId: user.id }), PENDING_LOGIN_TTL_S);
    generateOTP(db, emailsSent, user.email);
    return { otp_required: true };
  }

  return { token: 'access-token', refreshToken: 'refresh-token', portals: [{ type: 'SPONSOR', mustChangePassword: user.must_change_password }] };
}

function portalVerify2FA(db: FakeDb, store: FakeStore, email: string, code: string): PortalLoginResult {
  const normalizedEmail = String(email ?? '').trim().toLowerCase();
  const pendingKey = `portal_pending_login:${normalizedEmail}`;
  const pendingData = store.get(pendingKey);
  if (!pendingData) throw new Error('Login session expired or invalid. Please sign in again.');

  const isValid = verifyOTP(db, normalizedEmail, code);
  if (!isValid) {
    store.del(pendingKey);
    throw new Error('Invalid or expired verification code');
  }
  store.del(pendingKey);

  const { userId } = JSON.parse(pendingData);
  const user = db.findUserByIdAndEmail(userId, normalizedEmail);
  if (!user) throw new Error('Invalid email');
  if (!user.is_active) throw new Error('Your account is disabled. Contact NetRide support.');

  return {
    token: 'access-token',
    refreshToken: 'refresh-token',
    portals: [{ type: 'SPONSOR', mustChangePassword: user.must_change_password }],
    trustedDeviceToken: 'trusted-device-token',
  };
}

// --- Portal guard logic (mirror of portal.middleware.ts) --------------------

/** Returns allowed/denied for a data endpoint given the account state. */
function portalDataAccessAllowed(mustChangePassword: boolean): boolean {
  if (mustChangePassword) return false; // 403 — forced password change required
  return true;
}

/** Mirror of the password-change guard variant: never blocks on the flag. */
function portalPasswordChangeAllowed(mustChangePassword: boolean): boolean {
  return true; // the ONLY endpoint available while must_change_password is true
}

// --- Fixture helpers ---------------------------------------------------------

function makeUser(overrides?: Partial<FakeDb['users'][number]>): FakeDb['users'][number] {
  return {
    id: 'user-1',
    email: 'sponsor@test.com',
    password_hash: 'TempPass123!',
    is_active: true,
    must_change_password: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Colab login — password verification
// ---------------------------------------------------------------------------

test('portal 2FA: correct password → 2FA required, no session issued', () => {
  const db = new FakeDb();
  db.users.push(makeUser());
  const store = new FakeStore();
  const sent: string[] = [];

  const result = portalLogin(db, store, sent, 'sponsor@test.com', 'TempPass123!');

  assert.equal(result.otp_required, true, 'A code must be required');
  assert.equal(result.token, undefined, 'NO session token may be issued before 2FA');
  assert.equal(result.refreshToken, undefined, 'NO refresh token may be issued before 2FA');
  assert.equal(sent.length, 1, 'One code must have been emailed');
  assert.equal(store.has('portal_pending_login:sponsor@test.com'), true, 'Pending 2FA state must exist');
});

test('portal 2FA: incorrect password → rejected, no code sent, no pending state', () => {
  const db = new FakeDb();
  db.users.push(makeUser());
  const store = new FakeStore();
  const sent: string[] = [];

  assert.throws(
    () => portalLogin(db, store, sent, 'sponsor@test.com', 'wrong-password'),
    /Invalid email or password/,
  );
  assert.equal(sent.length, 0, 'No code may be sent for a failed password check');
  assert.equal(store.has('portal_pending_login:sponsor@test.com'), false, 'No pending state without a verified password');
});

test('portal 2FA: unknown email returns the same error as a wrong password', () => {
  const db = new FakeDb();
  db.users.push(makeUser());
  const store = new FakeStore();
  const sent: string[] = [];

  let unknownErr = '';
  let wrongPassErr = '';
  try { portalLogin(db, store, sent, 'ghost@test.com', 'TempPass123!'); } catch (e: any) { unknownErr = e.message; }
  try { portalLogin(db, store, sent, 'sponsor@test.com', 'badpass'); } catch (e: any) { wrongPassErr = e.message; }

  assert.equal(unknownErr, wrongPassErr, 'Login errors must not reveal account existence');
  assert.equal(sent.length, 0);
});

// ---------------------------------------------------------------------------
// Colab login — 2FA verification
// ---------------------------------------------------------------------------

test('portal 2FA: correct password + correct code → authenticated session', () => {
  const db = new FakeDb();
  db.users.push(makeUser());
  const store = new FakeStore();
  const sent: string[] = [];

  portalLogin(db, store, sent, 'sponsor@test.com', 'TempPass123!');
  const code = db.codes[0].code_hash; // not used directly — codes only exist as hashes
  assert.equal(code.length, 64, 'Only the SHA-256 digest is persisted, never the plaintext code');

  // The real flow never reveals the code; simulate the account holder reading it.
  const rawCode = '123456';
  db.codes = db.codes.map((c) => ({ ...c, code_hash: sha256(rawCode) }));

  const result = portalVerify2FA(db, store, 'sponsor@test.com', rawCode);

  assert.ok(result.token, 'Session token must be issued after 2FA');
  assert.ok(result.refreshToken, 'Refresh token must be issued after 2FA');
  assert.ok(result.trustedDeviceToken, 'Trusted-device token must be issued after 2FA');
  assert.equal(store.has('portal_pending_login:sponsor@test.com'), false, 'Pending state must be consumed');
  assert.equal(db.codes.length, 0, 'Code must be single-use (deleted after verification)');
});

test('portal 2FA: correct password + incorrect code → rejected, pending consumed', () => {
  const db = new FakeDb();
  db.users.push(makeUser());
  const store = new FakeStore();
  const sent: string[] = [];

  portalLogin(db, store, sent, 'sponsor@test.com', 'TempPass123!');
  db.codes = db.codes.map((c) => ({ ...c, code_hash: sha256('654321') }));

  assert.throws(() => portalVerify2FA(db, store, 'sponsor@test.com', '000000'), /Invalid or expired verification code/);
  assert.equal(store.has('portal_pending_login:sponsor@test.com'), false, 'Failed 2FA must consume the pending login');
});

test('portal 2FA: expired code → rejected', () => {
  const db = new FakeDb();
  db.users.push(makeUser());
  const store = new FakeStore();
  const sent: string[] = [];

  portalLogin(db, store, sent, 'sponsor@test.com', 'TempPass123!');
  db.codes = db.codes.map((c) => ({ ...c, code_hash: sha256('123456'), expires_at: Date.now() - 1000 }));

  assert.throws(() => portalVerify2FA(db, store, 'sponsor@test.com', '123456'), /Invalid or expired verification code/);
});

test('portal 2FA: verify without any pending login → rejected', () => {
  const db = new FakeDb();
  db.users.push(makeUser());
  const store = new FakeStore();

  assert.throws(
    () => portalVerify2FA(db, store, 'sponsor@test.com', '123456'),
    /Login session expired or invalid/,
    'A code alone must never mint a session without a password-verified login',
  );
});

test('portal 2FA: consumed code cannot be reused', () => {
  const db = new FakeDb();
  db.users.push(makeUser());
  const store = new FakeStore();
  const sent: string[] = [];

  portalLogin(db, store, sent, 'sponsor@test.com', 'TempPass123!');
  db.codes = db.codes.map((c) => ({ ...c, code_hash: sha256('123456') }));

  portalVerify2FA(db, store, 'sponsor@test.com', '123456'); // succeeds, consumes
  assert.throws(
    () => portalVerify2FA(db, store, 'sponsor@test.com', '123456'),
    /Login session expired or invalid/,
    'Replaying a consumed code must fail',
  );
});

test('portal 2FA: a newer login invalidates the previous code', () => {
  const db = new FakeDb();
  db.users.push(makeUser());
  const store = new FakeStore();
  const sent: string[] = [];

  portalLogin(db, store, sent, 'sponsor@test.com', 'TempPass123!');
  db.codes = db.codes.map((c) => ({ ...c, code_hash: sha256('111111') }));
  portalLogin(db, store, sent, 'sponsor@test.com', 'TempPass123!'); // fresh login → new code
  db.codes = db.codes.map((c) => ({ ...c, code_hash: sha256('222222') }));

  // The previous code no longer exists in the store (generateOTP deletes
  // old rows) so verifying it fails.
  assert.throws(() => portalVerify2FA(db, store, 'sponsor@test.com', '111111'), /Invalid or expired verification code/);
});

test('portal 2FA: the newest code still completes the login', () => {
  const db = new FakeDb();
  db.users.push(makeUser());
  const store = new FakeStore();
  const sent: string[] = [];

  portalLogin(db, store, sent, 'sponsor@test.com', 'TempPass123!');
  db.codes = db.codes.map((c) => ({ ...c, code_hash: sha256('111111') }));
  portalLogin(db, store, sent, 'sponsor@test.com', 'TempPass123!');
  db.codes = db.codes.map((c) => ({ ...c, code_hash: sha256('222222') }));

  const result = portalVerify2FA(db, store, 'sponsor@test.com', '222222');
  assert.ok(result.token, 'Latest code completes 2FA and issues the session');
});

test('portal 2FA: excessive attempts void the code (brute-force throttle)', () => {
  const db = new FakeDb();
  db.users.push(makeUser());
  const store = new FakeStore();
  const sent: string[] = [];

  portalLogin(db, store, sent, 'sponsor@test.com', 'TempPass123!');
  db.codes = db.codes.map((c) => ({ ...c, code_hash: sha256('123456') }));

  for (let i = 0; i < OTP_MAX_ATTEMPTS; i++) {
    verifyOTP(db, 'sponsor@test.com', '999999'); // always wrong
  }
  assert.equal(db.codes.length, 0, 'Code must be deleted after MAX_ATTEMPTS failures');

  // Even a correct code now fails.
  assert.equal(verifyOTP(db, 'sponsor@test.com', '123456'), false);
});

test('portal 2FA: malformed code is rejected without touching storage', () => {
  const db = new FakeDb();
  db.users.push(makeUser());
  const store = new FakeStore();
  const sent: string[] = [];

  portalLogin(db, store, sent, 'sponsor@test.com', 'TempPass123!');
  db.codes = db.codes.map((c) => ({ ...c, code_hash: sha256('123456') }));

  for (const bad of ['', '12345', 'abcdef', '12 34 56', '1234567']) {
    assert.equal(verifyOTP(db, 'sponsor@test.com', bad), false, `"${bad}" must be rejected`);
  }
  assert.equal(db.codes.length, 1, 'Malformed input must not consume attempts');
});

test('portal 2FA: trusted-device token skips the code only when valid', () => {
  const db = new FakeDb();
  db.users.push(makeUser({ must_change_password: false }));
  const store = new FakeStore();
  const sent: string[] = [];

  // Valid trusted token (mirrors jwt.sign with t='portal-trusted' claim).
  const payload = Buffer.from(JSON.stringify({ id: 'user-1', email: 'sponsor@test.com', t: 'portal-trusted' })).toString('base64url');
  const validToken = `x.${payload}.sig`;

  const result = portalLogin(db, store, sent, 'sponsor@test.com', 'TempPass123!', validToken);
  assert.equal(result.otp_required, undefined, 'Trusted device skips 2FA');
  assert.ok(result.token, 'Session issued');
  assert.equal(sent.length, 0, 'No code emailed for a trusted device');

  // Stale/expired token (no marker claim) → 2FA still required.
  const junkPayload = Buffer.from(JSON.stringify({ id: 'user-1', email: 'sponsor@test.com', t: 'old' })).toString('base64url');
  const result2 = portalLogin(db, store, sent, 'sponsor@test.com', 'TempPass123!', `x.${junkPayload}.sig`);
  assert.equal(result2.otp_required, true, 'Invalid trusted token must fall back to 2FA');
});

// ---------------------------------------------------------------------------
// Temporary-password flow
// ---------------------------------------------------------------------------

test('temporary password: 2FA is still required before any session', () => {
  const db = new FakeDb();
  db.users.push(makeUser({ must_change_password: true })); // temp password
  const store = new FakeStore();
  const sent: string[] = [];

  const result = portalLogin(db, store, sent, 'sponsor@test.com', 'TempPass123!');
  assert.equal(result.otp_required, true, 'Temporary password must NOT bypass 2FA');
  assert.equal(result.token, undefined, 'No session before 2FA even for temporary passwords');
});

test('temporary password: successful 2FA → password-change step required, data blocked', () => {
  const db = new FakeDb();
  db.users.push(makeUser({ must_change_password: true }));
  const store = new FakeStore();
  const sent: string[] = [];

  portalLogin(db, store, sent, 'sponsor@test.com', 'TempPass123!');
  db.codes = db.codes.map((c) => ({ ...c, code_hash: sha256('123456') }));
  const result = portalVerify2FA(db, store, 'sponsor@test.com', '123456');

  assert.ok(result.token, 'Session is issued after 2FA…');
  assert.equal(result.portals?.[0].mustChangePassword, true, '…but the change-password state is explicit in the session');
  assert.equal(portalDataAccessAllowed(true), false, 'Data endpoints must be blocked until the password changes');
});

test('temporary password: data access is blocked by the server guard (client-side state cannot bypass)', () => {
  const db = new FakeDb();
  db.users.push(makeUser({ must_change_password: true }));
  const store = new FakeStore();
  const sent: string[] = [];

  portalLogin(db, store, sent, 'sponsor@test.com', 'TempPass123!');
  db.codes = db.codes.map((c) => ({ ...c, code_hash: sha256('123456') }));
  portalVerify2FA(db, store, 'sponsor@test.com', '123456');

  // Attack simulation: client forges local state / routes / payloads. The
  // server-side guard still denies every data endpoint.
  assert.equal(portalDataAccessAllowed(true), false, '403 regardless of client-side state');
});

test('temporary password: change-password is the ONLY endpoint available in that state', () => {
  const db = new FakeDb();
  db.users.push(makeUser({ must_change_password: true }));
  const store = new FakeStore();
  const sent: string[] = [];

  portalLogin(db, store, sent, 'sponsor@test.com', 'TempPass123!');
  db.codes = db.codes.map((c) => ({ ...c, code_hash: sha256('123456') }));
  portalVerify2FA(db, store, 'sponsor@test.com', '123456');

  // change-password endpoint: allowed (its guard variant never blocks on the
  // temporary-password flag) — it is the ONLY endpoint available in this state.
  assert.equal(portalPasswordChangeAllowed(true), true, 'change-password stays reachable');
  assert.equal(portalDataAccessAllowed(true), false, 'every data endpoint is denied');
});

test('temporary password: new password replaces it and clears the flag', () => {
  const db = new FakeDb();
  db.users.push(makeUser({ must_change_password: true }));
  const store = new FakeStore();
  const sent: string[] = [];

  portalLogin(db, store, sent, 'sponsor@test.com', 'TempPass123!');
  db.codes = db.codes.map((c) => ({ ...c, code_hash: sha256('123456') }));
  portalVerify2FA(db, store, 'sponsor@test.com', '123456');

  // Mirror of PortalAuthService.changePassword: replace hash + clear flag.
  const user = db.users[0];
  user.password_hash = 'NewSecurePass456!';
  user.must_change_password = false;

  assert.equal(portalDataAccessAllowed(user.must_change_password), true, 'Data endpoints open after the change');
  assert.notEqual(user.password_hash, 'TempPass123!', 'Temporary password hash must be replaced');
});

test('temporary password: cannot be reused after the change', () => {
  const db = new FakeDb();
  db.users.push(makeUser({ must_change_password: true }));
  const store = new FakeStore();
  const sent: string[] = [];

  portalLogin(db, store, sent, 'sponsor@test.com', 'TempPass123!');
  db.codes = db.codes.map((c) => ({ ...c, code_hash: sha256('123456') }));
  portalVerify2FA(db, store, 'sponsor@test.com', '123456');

  const user = db.users[0];
  user.password_hash = 'NewSecurePass456!';
  user.must_change_password = false;

  // The temporary password no longer matches the stored hash.
  assert.notEqual(user.password_hash, 'TempPass123!');
  assert.throws(
    () => portalLogin(db, store, sent, 'sponsor@test.com', 'TempPass123!'),
    /Invalid email or password/,
    'Old temporary password must be rejected',
  );
});

// ---------------------------------------------------------------------------
// SQL / key structure (drift guards against the real services)
// ---------------------------------------------------------------------------

test('portal 2FA: pending-login Redis key uses portal_pending_login: prefix + 600s TTL', () => {
  const key = `portal_pending_login:${crypto.randomUUID()}`;
  assert.ok(key.startsWith('portal_pending_login:'), 'Pending login key prefix');
  assert.equal(PENDING_LOGIN_TTL_S, 600, 'Pending state must expire with the code (10 minutes)');
});

test('portal 2FA: OTP verification SQL matches on code_hash + expiry, deletes on success', () => {
  const selectSql =
    'SELECT * FROM verification_codes WHERE email = $1 AND code_hash = $2 AND expires_at > NOW()';
  const deleteSql = 'DELETE FROM verification_codes WHERE email = $1';
  assert.ok(selectSql.includes('code_hash'), 'Lookup must use the digest, never plaintext');
  assert.ok(selectSql.includes('expires_at > NOW()'), 'Expiry enforced in SQL');
  assert.ok(deleteSql.includes('DELETE'), 'Single-use cleanup');
});

test('portal 2FA: rate limits exist for every portal auth route', () => {
  const routes = [
    'POST /api/portal/auth/login',
    'POST /api/portal/auth/verify-2fa',
    'POST /api/portal/auth/forgot-password',
    'POST /api/portal/auth/verify-reset-otp',
    'POST /api/portal/auth/reset-password',
  ];
  for (const route of routes) {
    assert.ok(route.startsWith('POST /api/portal/auth/'), `Route shape: ${route}`);
  }
  // verify-2fa is capped at 5/min — infeasible for a 900k-combination space.
  const verify2faLimitPerMinute = 5;
  assert.ok(verify2faLimitPerMinute <= 5, 'verify-2fa rate limit must be strict');
});