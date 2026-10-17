// tests/e2e/dashboard-workflows/run-colab-identity-e2e.cjs
//
// COLAB IDENTITY HTTP E2E — admin creation, login, linking, disable/enable,
// identity separation and test-account handling.
// ---------------------------------------------------------------------------
// Boots the REAL backend and drives the EXACT HTTP surface the admin
// dashboard and the sponsor portal (colab) call:
//   * admin creates a sponsor (+ optional portal login in NEW mode)
//   * portal login for a colab identity whose email ALSO belongs to an
//     INACTIVE rider — the driver/rider row must never affect the login
//   * forced first-login password change, then dashboard access
//   * disable → re-enable → login again (no forever-disabled trap)
//   * linking a rider/driver identity as a colab login is refused
//   * sponsor/partner/fleet sharing one colab identity works
//   * consumer signup can reuse a portal-only email (separate namespaces)
//   * admin lists hide test accounts by default, badge them when included,
//     and the colab link picker never returns rider/driver identities
//
// Uses the real DB + Redis; all scratch rows are removed at the end.
//
// Usage: node run-colab-identity-e2e.cjs

process.env.REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
require('../../../backend/node_modules/dotenv').config({ path: require('path').resolve(__dirname, '../../../backend/.env') });

if (process.env.NODE_ENV === 'production') {
  console.error('❌ Refusing to run Colab Identity E2E in production');
  process.exit(1);
}

require('../../../backend/node_modules/ts-node').register({
  dir: require('path').resolve(__dirname, '../../../backend'),
  transpileOnly: true,
  compilerOptions: { module: 'commonjs', esModuleInterop: true },
});

const crypto = require('crypto');
const { spawn } = require('child_process');
const { pool } = require('../../../backend/src/config/database');
const jwt = require('../../../backend/node_modules/jsonwebtoken');
const bcrypt = require('../../../backend/node_modules/bcryptjs');
const { env } = require('../../../backend/src/config/env');

let passed = 0, failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  [PASS] ${name}${extra ? ` — ${extra}` : ''}`); }
  else { failed++; console.log(`  [FAIL] ${name}${extra ? ` — ${extra}` : ''}`); }
};
const API = (port) => `http://127.0.0.1:${port}/api`;

async function waitForReady(port, attempts = 240) {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health/live`, { signal: AbortSignal.timeout(2000) });
      if (r.status >= 200 && r.status < 500) return true;
    } catch { /* not up yet */ }
    await new Promise((res) => setTimeout(res, 1000));
  }
  return false;
}

async function request(port, method, path, { token, body, headers } = {}) {
  const res = await fetch(`${API(port)}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(headers ?? {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  return { status: res.status, data };
}

(async () => {
  const port = 20000 + Math.floor(Math.random() * 1000);
  const server = spawn(process.execPath, ['-r', 'ts-node/register', 'src/app.ts'], {
    cwd: require('path').resolve(__dirname, '../../../backend'),
    env: { ...process.env, PORT: String(port), REDIS_URL: process.env.REDIS_URL },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => process.stdout.write(`  [server] ${d}`));
  server.stderr.on('data', (d) => process.stdout.write(`  [server!] ${d}`));
  console.log(`═══ COLAB IDENTITY HTTP E2E ═══ (port ${port})`);

  const suffix = crypto.randomBytes(5).toString('hex');
  const sharedEmail = `colab.id.${suffix}@gmail.com`;        // rider + colab identity
  const portalOnlyEmail = `colab.portalonly.${suffix}@gmail.com`;
  const sponsorBEmail = `colab.b.${suffix}@gmail.com`;
  const sponsorTestEmail = `colab.c.${suffix}@netride.test`;  // test-classified
  const fleetRealContact = `colab.fleet.real.${suffix}@gmail.com`;
  const fleetTestContact = `colab.fleet.test.${suffix}@netride.test`;
  const fleetPortalEmail = `colab.fleet.portal.${suffix}@gmail.com`;
  const adminEmail = `colab.admin.${suffix}@gmail.com`;
  const testRiderEmail = `colab.id.test.${suffix}@netride.test`;
  const allEmails = [
    sharedEmail, portalOnlyEmail, sponsorBEmail, sponsorTestEmail,
    fleetRealContact, fleetTestContact, fleetPortalEmail, adminEmail, testRiderEmail,
  ];

  const created = { sponsors: [], fleets: [], partners: [] };
  const tempPassword = 'TempPass-' + suffix + '!';
  const newPassword = 'NewPass-' + suffix + '!';
  const riderPassword = 'RiderPass-' + suffix + '!';

  try {
    if (!(await waitForReady(port))) throw new Error('backend did not become ready in time');
    console.log('  · backend ready');

    // ---- scratch identities ------------------------------------------------
    const riderRes = await pool.query(
      `INSERT INTO users (email, full_name, password_hash, role, is_active)
       VALUES ($1, 'Colab E2E Rider', $2, 'RIDER', FALSE) RETURNING id`,
      [sharedEmail, await bcrypt.hash(riderPassword, 10)],
    );
    const riderId = riderRes.rows[0].id;
    const testRiderRes = await pool.query(
      `INSERT INTO users (email, full_name, role, is_active)
       VALUES ($1, 'Colab E2E Test Rider', 'RIDER', TRUE) RETURNING id`,
      [testRiderEmail],
    );
    const adminRes = await pool.query(
      `INSERT INTO users (email, full_name, role, is_active)
       VALUES ($1, 'Colab E2E Admin', 'ADMIN', TRUE) RETURNING id`,
      [adminEmail],
    );
    const adminToken = jwt.sign(
      { id: adminRes.rows[0].id, role: 'ADMIN', email: adminEmail },
      env.JWT_SECRET,
      { expiresIn: '1h', algorithm: 'HS256' },
    );

    const trustedTokenFor = async (email, role) => {
      const r = await pool.query(`SELECT id FROM users WHERE email = $1 AND role = $2`, [email, role]);
      if (!r.rows[0]) throw new Error(`identity not found: ${role} ${email}`);
      return jwt.sign(
        { id: r.rows[0].id, role, email, t: 'portal-trusted' },
        env.JWT_SECRET,
        { expiresIn: '30d', algorithm: 'HS256' },
      );
    };

    // ---- 1. admin creates sponsor + NEW portal login on a rider-owned email ----
    let r = await request(port, 'POST', '/admin/sponsors', {
      token: adminToken,
      body: {
        businessName: `Colab Identity A ${suffix}`,
        businessType: 'RESTAURANT',
        email: sharedEmail,
        discountType: 'PERCENTAGE',
        discountPercent: 10,
        maxDiscountPercent: 50,
        initialBudgetCents: 0,
      },
    });
    ok('admin creates sponsor A', r.status === 201 && !!r.data?.sponsor?.id, r.data?.error);
    const sponsorAId = r.data?.sponsor?.id;
    created.sponsors.push(sponsorAId);

    r = await request(port, 'POST', `/admin/sponsors/${sponsorAId}/portal-account`, {
      token: adminToken,
      body: { user_mode: 'NEW', email: sharedEmail },
    });
    ok(
      'portal login created on an email owned by an INACTIVE rider',
      r.status === 201 && typeof r.data?.temporaryPassword === 'string' && r.data.temporaryPassword.length >= 8,
      r.data?.error,
    );
    const sponsorTempPassword = r.data?.temporaryPassword;

    const sameEmailRows = await pool.query(
      `SELECT id, role, is_active FROM users WHERE email = $1 ORDER BY role`,
      [sharedEmail],
    );
    const roles = sameEmailRows.rows.map((x) => x.role).sort();
    ok('same email exists as two independent identities', roles.join(',') === 'RIDER,SPONSOR', roles.join(','));
    const sponsorIdentity = sameEmailRows.rows.find((x) => x.role === 'SPONSOR');
    ok('rider identity left untouched (still disabled)', sameEmailRows.rows.find((x) => x.role === 'RIDER')?.is_active === false);
    ok('colab identity active and linked to the sponsor', sponsorIdentity?.is_active === true);
    const portalLink = await pool.query(
      `SELECT user_id FROM sponsor_portal_accounts WHERE sponsor_id = $1`,
      [sponsorAId],
    );
    ok('sponsor portal account points at the colab identity (not the rider)', portalLink.rows[0]?.user_id === sponsorIdentity?.id);

    // ---- 2. portal login ---------------------------------------------------
    const sponsorTrusted = await trustedTokenFor(sharedEmail, 'SPONSOR');

    r = await request(port, 'POST', '/portal/auth/login', {
      body: { email: sharedEmail, password: 'definitely-wrong', trusted_device_token: sponsorTrusted },
    });
    ok('wrong password refused', r.status === 401);

    r = await request(port, 'POST', '/portal/auth/login', {
      body: { email: sharedEmail, password: sponsorTempPassword, trusted_device_token: sponsorTrusted },
    });
    ok(
      'colab login succeeds despite the inactive rider row',
      r.status === 200 && !!r.data?.token && r.data?.portals?.[0]?.type === 'SPONSOR',
      r.data?.error,
    );
    const sessionToken = r.data?.token;
    ok('first login requires password change', r.data?.portal?.mustChangePassword === true);

    r = await request(port, 'GET', '/portal/dashboard', { token: sessionToken, headers: { 'x-portal-type': 'SPONSOR' } });
    ok('data blocked until the temporary password is changed', r.status === 403);

    r = await request(port, 'POST', '/portal/auth/change-password', {
      token: sessionToken,
      body: { newPassword },
    });
    ok('forced password change accepted', r.status === 200, r.data?.error);

    r = await request(port, 'GET', '/portal/dashboard', { token: sessionToken, headers: { 'x-portal-type': 'SPONSOR' } });
    ok('dashboard readable after the change', r.status === 200 && r.data?.type === 'SPONSOR');

    // ---- 3. disable → enable round trip ------------------------------------
    r = await request(port, 'POST', `/admin/sponsors/${sponsorAId}/portal-account/disable`, { token: adminToken });
    ok('admin disables the login', r.status === 200, r.data?.error);

    const afterDisable = await pool.query(
      `SELECT spa.is_active AS portal_active, u.is_active AS identity_active
       FROM sponsor_portal_accounts spa JOIN users u ON u.id = spa.user_id
       WHERE spa.sponsor_id = $1`,
      [sponsorAId],
    );
    ok('disable flips only the portal row', afterDisable.rows[0]?.portal_active === false);
    ok('disable never deactivates the identity', afterDisable.rows[0]?.identity_active === true);
    const riderStill = await pool.query(`SELECT is_active FROM users WHERE id = $1`, [riderId]);
    ok('disable never touches the rider row', riderStill.rows[0]?.is_active === false);

    r = await request(port, 'POST', '/portal/auth/login', {
      body: { email: sharedEmail, password: newPassword, trusted_device_token: sponsorTrusted },
    });
    ok(
      'disabled login is refused with a clear disabled message',
      r.status === 401 && /disabled/i.test(String(r.data?.error ?? '')),
      r.data?.error,
    );

    r = await request(port, 'POST', `/admin/sponsors/${sponsorAId}/portal-account/enable`, { token: adminToken });
    ok('admin re-enables the login', r.status === 200, r.data?.error);

    r = await request(port, 'POST', '/portal/auth/login', {
      body: { email: sharedEmail, password: newPassword, trusted_device_token: sponsorTrusted },
    });
    ok('login works again after re-enable', r.status === 200 && !!r.data?.token, r.data?.error);

    // ---- 4. linking a rider/driver identity is refused ---------------------
    r = await request(port, 'POST', '/admin/sponsors', {
      token: adminToken,
      body: {
        businessName: `Colab Identity B ${suffix}`,
        businessType: 'CAFE',
        email: sponsorBEmail,
        discountType: 'PERCENTAGE',
        discountPercent: 5,
        maxDiscountPercent: 25,
        initialBudgetCents: 0,
      },
    });
    const sponsorBId = r.data?.sponsor?.id;
    created.sponsors.push(sponsorBId);

    r = await request(port, 'POST', `/admin/sponsors/${sponsorBId}/portal-account`, {
      token: adminToken,
      body: { user_mode: 'EXISTING', user_id: riderId },
    });
    ok(
      'linking a rider identity as a colab login is refused',
      r.status === 400 && /colab account/i.test(String(r.data?.error ?? '')),
      r.data?.error,
    );

    // ---- 5. sponsor/partner/fleet share one colab identity -----------------
    r = await request(port, 'POST', '/admin/partners', {
      token: adminToken,
      body: {
        name: `Colab Identity Partner ${suffix}`,
        business_type: 'RETAIL',
        user_mode: 'NEW',
        email: sharedEmail,
        password: 'PartnerPass-' + suffix + '!',
        commission_rate: 0.1,
      },
    });
    ok(
      'partner NEW with an already-linked colab email is refused (link instead)',
      r.status === 400 && /colab account/i.test(String(r.data?.error ?? '')),
      r.data?.error,
    );

    r = await request(port, 'POST', '/admin/partners', {
      token: adminToken,
      body: {
        name: `Colab Identity Partner ${suffix}`,
        business_type: 'RETAIL',
        user_mode: 'EXISTING',
        user_id: sponsorIdentity?.id,
        commission_rate: 0.1,
      },
    });
    ok('partner links the existing colab identity', r.status === 201, r.data?.error);
    const partnerId = r.data?.id;
    if (partnerId) created.partners.push(partnerId);

    const partnerLink = await pool.query(`SELECT user_id FROM partners WHERE id = $1`, [partnerId]);
    ok('partner row points at the shared colab identity', partnerLink.rows[0]?.user_id === sponsorIdentity?.id);

    r = await request(port, 'POST', '/portal/auth/login', {
      body: { email: sharedEmail, password: newPassword, trusted_device_token: sponsorTrusted },
    });
    const portalTypes = (r.data?.portals ?? []).map((p) => p.type).sort();
    ok(
      'one login owns BOTH sponsor and partner dashboards',
      r.status === 200 && portalTypes.join(',') === 'PARTNER,SPONSOR',
      portalTypes.join(','),
    );

    // ---- 6. consumer signup may reuse a portal-only email ------------------
    r = await request(port, 'POST', '/admin/sponsors', {
      token: adminToken,
      body: {
        businessName: `Colab Identity PortalOnly ${suffix}`,
        businessType: 'SERVICES',
        email: portalOnlyEmail,
        discountType: 'PERCENTAGE',
        discountPercent: 10,
        maxDiscountPercent: 50,
        initialBudgetCents: 0,
      },
    });
    const sponsorPortalOnlyId = r.data?.sponsor?.id;
    created.sponsors.push(sponsorPortalOnlyId);
    r = await request(port, 'POST', `/admin/sponsors/${sponsorPortalOnlyId}/portal-account`, {
      token: adminToken,
      body: { user_mode: 'NEW', email: portalOnlyEmail },
    });
    ok('portal-only email gets a colab identity', r.status === 201, r.data?.error);

    r = await request(port, 'POST', '/auth/signup-password', {
      body: { email: portalOnlyEmail, full_name: 'Colab E2E Consumer', password: 'ConsumerPass-' + suffix + '!', role: 'RIDER' },
    });
    ok('consumer signup succeeds on a portal-only email', r.status === 200 && r.data?.otp_required === true, r.data?.error);
    const dual = await pool.query(
      `SELECT role FROM users WHERE email = $1 ORDER BY role`,
      [portalOnlyEmail],
    );
    ok('portal identity and consumer identity coexist', dual.rows.map((x) => x.role).join(',') === 'RIDER,SPONSOR', dual.rows.map((x) => x.role).join(','));

    // ---- 7. consumer login resolves the rider, never the colab identity ----
    r = await request(port, 'POST', '/auth/login-password', {
      body: { email: sharedEmail, password: riderPassword, app_role: 'RIDER' },
    });
    ok(
      'driver/rider app login resolves the rider identity (same email)',
      r.status === 200 && r.data?.otp_required === true,
      r.data?.error,
    );
    r = await request(port, 'POST', '/auth/login-password', {
      body: { email: sharedEmail, password: newPassword, app_role: 'RIDER' },
    });
    ok('colab password does NOT work on the driver/rider login', r.status === 401, `status ${r.status}`);

    // ---- 8. admin lists separate test accounts -----------------------------
    r = await request(port, 'POST', '/admin/sponsors', {
      token: adminToken,
      body: {
        businessName: `Colab Identity C ${suffix}`,
        businessType: 'BAR',
        email: sponsorTestEmail,
        discountType: 'PERCENTAGE',
        discountPercent: 10,
        maxDiscountPercent: 50,
        initialBudgetCents: 0,
      },
    });
    const sponsorCId = r.data?.sponsor?.id;
    created.sponsors.push(sponsorCId);

    r = await request(port, 'GET', `/admin/sponsors?search=${encodeURIComponent(suffix)}&limit=200`, { token: adminToken });
    let list = r.data?.sponsors ?? [];
    ok('sponsors list hides test accounts by default', !list.some((s) => s.id === sponsorCId) && list.some((s) => s.id === sponsorAId));
    r = await request(port, 'GET', `/admin/sponsors?search=${encodeURIComponent(suffix)}&limit=200&includeTest=true`, { token: adminToken });
    list = r.data?.sponsors ?? [];
    const sponsorC = list.find((s) => s.id === sponsorCId);
    ok('sponsors list shows test accounts when included, badged', !!sponsorC && sponsorC.is_test === true);

    r = await request(port, 'GET', `/admin/users?search=${encodeURIComponent(testRiderEmail)}&limit=10`, { token: adminToken });
    ok('users list hides test identities by default', (r.data?.total ?? -1) === 0, `total ${r.data?.total}`);
    r = await request(port, 'GET', `/admin/users?search=${encodeURIComponent(testRiderEmail)}&limit=10&includeTest=true`, { token: adminToken });
    ok('users list shows test identities when included, badged', r.data?.total === 1 && r.data?.users?.[0]?.is_test === true);

    r = await request(port, 'GET', `/admin/portal-users?search=${encodeURIComponent(sharedEmail)}`, { token: adminToken });
    const portalUsers = r.data?.users ?? [];
    ok(
      'colab link picker returns the colab identity only (never the rider)',
      portalUsers.length === 1 && portalUsers[0].role === 'SPONSOR' && !portalUsers.some((u) => ['RIDER', 'DRIVER', 'ADMIN'].includes(u.role)),
      portalUsers.map((u) => u.role).join(','),
    );

    // ---- 9. fleet portal account disable/enable + fleet list separation -----
    r = await request(port, 'POST', '/admin/fleets', {
      token: adminToken,
      body: { name: `Colab Identity Fleet ${suffix}`, platform_share_percent: 20, contact_email: fleetRealContact },
    });
    const fleetRealId = r.data?.fleet?.id;
    created.fleets.push(fleetRealId);
    r = await request(port, 'POST', '/admin/fleets', {
      token: adminToken,
      body: { name: `Colab Identity Fleet Test ${suffix}`, platform_share_percent: 20, contact_email: fleetTestContact },
    });
    const fleetTestId = r.data?.fleet?.id;
    created.fleets.push(fleetTestId);

    r = await request(port, 'POST', `/admin/fleets/${fleetRealId}/portal-account`, {
      token: adminToken,
      body: { email: fleetPortalEmail },
    });
    ok('fleet portal account created', r.status === 201 && !!r.data?.temporaryPassword, r.data?.error);
    const fleetTempPassword = r.data?.temporaryPassword;
    const fleetTrusted = await trustedTokenFor(fleetPortalEmail, 'FLEET');

    r = await request(port, 'POST', '/portal/auth/login', {
      body: { email: fleetPortalEmail, password: fleetTempPassword, trusted_device_token: fleetTrusted },
    });
    ok('fleet colab login works', r.status === 200 && r.data?.portals?.[0]?.type === 'FLEET', r.data?.error);

    r = await request(port, 'POST', `/admin/fleets/${fleetRealId}/portal-account/disable`, { token: adminToken });
    ok('fleet login disabled', r.status === 200, r.data?.error);
    r = await request(port, 'POST', '/portal/auth/login', {
      body: { email: fleetPortalEmail, password: fleetTempPassword, trusted_device_token: fleetTrusted },
    });
    ok('fleet disabled login refused', r.status === 401 && /disabled/i.test(String(r.data?.error ?? '')));

    r = await request(port, 'POST', `/admin/fleets/${fleetRealId}/portal-account/enable`, { token: adminToken });
    ok('fleet login re-enabled', r.status === 200, r.data?.error);
    r = await request(port, 'POST', '/portal/auth/login', {
      body: { email: fleetPortalEmail, password: fleetTempPassword, trusted_device_token: fleetTrusted },
    });
    ok('fleet login works after re-enable', r.status === 200 && !!r.data?.token, r.data?.error);

    r = await request(port, 'GET', '/admin/fleets', { token: adminToken });
    let fleets = r.data?.fleets ?? [];
    ok('fleets list hides test fleets by default', !fleets.some((f) => f.id === fleetTestId) && fleets.some((f) => f.id === fleetRealId));
    r = await request(port, 'GET', '/admin/fleets?includeTest=true', { token: adminToken });
    fleets = r.data?.fleets ?? [];
    ok('fleets list shows test fleets when included, badged', fleets.some((f) => f.id === fleetTestId && f.is_test === true));

    // ---- 10. partner list test separation -----------------------------------
    const testPartnerRes = await pool.query(
      `INSERT INTO partners (name, business_type, contact_email, commission_rate, status, must_change_password)
       VALUES ($1, 'RETAIL', $2, 0.1, 'ACTIVE', FALSE) RETURNING id`,
      [`Colab Identity Test Partner ${suffix}`, `partner.test.${suffix}@netride.test`],
    );
    const testPartnerId = testPartnerRes.rows[0].id;
    created.partners.push(testPartnerId);

    r = await request(port, 'GET', `/admin/partners?search=${encodeURIComponent(suffix)}`, { token: adminToken });
    let partners = r.data?.partners ?? [];
    ok('partners list hides test accounts by default', !partners.some((p) => p.id === testPartnerId));
    r = await request(port, 'GET', `/admin/partners?search=${encodeURIComponent(suffix)}&includeTest=true`, { token: adminToken });
    partners = r.data?.partners ?? [];
    ok('partners list shows test accounts when included, badged', partners.some((p) => p.id === testPartnerId && p.is_test === true));
  } catch (err) {
    failed++;
    console.error('❌ COLAB IDENTITY E2E failed:', err.message);
  } finally {
    // ---- cleanup -----------------------------------------------------------
    try {
      for (const id of created.sponsors.filter(Boolean)) {
        await pool.query(`DELETE FROM sponsor_ledger_entries WHERE sponsor_id = $1`, [id]);
        await pool.query(`DELETE FROM sponsor_portal_accounts WHERE sponsor_id = $1`, [id]);
        await pool.query(`DELETE FROM sponsors WHERE id = $1`, [id]);
      }
      for (const id of created.fleets.filter(Boolean)) {
        await pool.query(`DELETE FROM fleet_portal_accounts WHERE fleet_id = $1`, [id]);
        await pool.query(`DELETE FROM fleet_partners WHERE id = $1`, [id]);
      }
      for (const id of created.partners.filter(Boolean)) {
        await pool.query(`DELETE FROM partners WHERE id = $1`, [id]);
      }
      await pool.query(`DELETE FROM users WHERE email = ANY($1::text[])`, [allEmails]);
      await pool.query(`DELETE FROM verification_codes WHERE email = ANY($1::text[])`, [allEmails]);
      console.log('  · scratch data cleaned up');
    } catch (cleanupErr) {
      console.error('  ! cleanup error:', cleanupErr.message);
    }
    server.kill('SIGTERM');
    setTimeout(() => process.exit(failed > 0 ? 1 : 0), 500);
    console.log(`\nCOLAB IDENTITY E2E: ${passed} passed, ${failed} failed`);
  }
})();
