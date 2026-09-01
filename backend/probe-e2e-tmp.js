require('dotenv').config({ path: 'C:/Users/mmkrt/OneDrive/Desktop/NetRide/backend/.env' });
const http = require('http');
const { Pool } = require('pg');

function call(path, method, body, headers) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: '127.0.0.1', port: 3000, path, method,
      headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...headers },
    }, (resp) => {
      let out = '';
      resp.on('data', (c) => (out += c));
      resp.on('end', () => {
        try { resolve({ status: resp.statusCode, body: JSON.parse(out) }); }
        catch { resolve({ status: resp.statusCode, body: out }); }
      });
    });
    req.on('error', (e) => resolve({ status: 0, body: e.message }));
    if (data) req.write(data);
    req.end();
  });
}

const log = (label, r) => console.log(`\n=== ${label} ===\nHTTP ${r.status}\n${typeof r.body === 'string' ? r.body : JSON.stringify(r.body, null, 1).slice(0, 700)}`);

(async () => {
  // 0. Admin login
  let r = await call('/api/auth/login-password', 'POST', { email: 'admin@netride.org', password: '_!MMkrtumy_0919!_' });
  log('admin login step1', r);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let step1 = r.body;
  let adminToken;
  if (step1.otp_required) {
    const res = await pool.query(`SELECT code FROM verification_codes WHERE email = 'support@netride.org' ORDER BY created_at DESC LIMIT 1`);
    r = await call('/api/auth/admin/verify-2fa', 'POST', { email: 'admin@netride.org', code: res.rows[0].code });
    log('admin login step2', { status: r.status, body: { token: '****' + (r.body?.token ?? '').slice(-12) } });
    adminToken = r.body.token;
  } else {
    adminToken = step1.token;
  }

  // 1. Admin: create fleet portal account
  const fleetId = '9b47afcb-d5ce-472d-a5fb-e07d71a96e6d';
  r = await call('/api/admin/fleets/' + fleetId + '/portal-account', 'POST', { email: 'fleet-test@netride.org' }, { Authorization: `Bearer ${adminToken}` });
  log('admin create fleet portal account', r);
  const fleetPassword = r.body.temporaryPassword;

  // 2. Portal login as FLEET (must change password)
  r = await call('/api/portal/auth/login', 'POST', { email: 'fleet-test@netride.org', password: fleetPassword });
  log('portal login fleet (temp pw)', { status: r.status, body: { ...r.body, token: r.body?.token ? 'issued' : undefined } });

  // 2b. Fleet change password
  r = await call('/api/portal/auth/change-password', 'POST', { newPassword: 'FleetPass_123!' }, { Authorization: `Bearer ${r.body.token}` });
  log('portal fleet change password', r);

  // 2c. Fleet login again + dashboard + drivers + rides
  r = await call('/api/portal/auth/login', 'POST', { email: 'fleet-test@netride.org', password: 'FleetPass_123!' });
  log('portal login fleet (new pw)', { status: r.status, body: { ...r.body, token: r.body?.token ? 'issued' : undefined } });
  const fleetToken = r.body.token;
  r = await call('/api/portal/dashboard', 'GET', null, { Authorization: `Bearer ${fleetToken}` });
  log('portal fleet dashboard', r);
  r = await call('/api/portal/fleet/drivers', 'GET', null, { Authorization: `Bearer ${fleetToken}` });
  log('portal fleet drivers', r);

  // 3. Portal login as PARTNER
  r = await call('/api/portal/auth/login', 'POST', { email: 'partner-test@netride.org', password: 'TestPartner_123!' });
  log('portal login partner', { status: r.status, body: { ...r.body, token: r.body?.token ? 'issued' : undefined } });
  const partnerToken = r.body.token;
  r = await call('/api/portal/dashboard', 'GET', null, { Authorization: `Bearer ${partnerToken}` });
  log('portal partner dashboard', r);
  r = await call('/api/portal/usage', 'GET', null, { Authorization: `Bearer ${partnerToken}` });
  log('portal partner usage', r);
  r = await call('/api/portal/commission', 'GET', null, { Authorization: `Bearer ${partnerToken}` });
  log('portal partner commission', r);

  // 4. Admin: reset sponsor portal password, then portal login as SPONSOR
  const sponsorId = 'e62b4ac6-d93a-4a2a-bc3e-b39f5f8bcaa9';
  r = await call('/api/admin/sponsors/' + sponsorId + '/portal-account/reset-password', 'POST', {}, { Authorization: `Bearer ${adminToken}` });
  log('admin reset sponsor portal password', r);
  const sponsorPassword = r.body.temporaryPassword;
  r = await call('/api/portal/auth/login', 'POST', { email: 'mmkrtumyan29@gmail.com', password: sponsorPassword });
  log('portal login sponsor', { status: r.status, body: { ...r.body, token: r.body?.token ? 'issued' : undefined } });
  const sponsorToken = r.body.token;
  r = await call('/api/portal/dashboard', 'GET', null, { Authorization: `Bearer ${sponsorToken}` });
  log('portal sponsor dashboard', r);
  // Sponsor-only endpoints via portal JWT (sponsorMiddleware compat)
  r = await call('/api/sponsor/customers', 'GET', null, { Authorization: `Bearer ${sponsorToken}` });
  log('sponsor /sponsor/customers via portal token', r);
  r = await call('/api/sponsor/settings', 'GET', null, { Authorization: `Bearer ${sponsorToken}` });
  log('sponsor /sponsor/settings via portal token', { status: r.status, body: { ...r.body, email: undefined } });

  // 5. Unauthorized checks
  r = await call('/api/portal/dashboard', 'GET', null, {});
  log('portal dashboard without token', r);
  r = await call('/api/portal/fleet/drivers', 'GET', null, { Authorization: `Bearer ${partnerToken}` });
  log('fleet drivers with PARTNER token (should 403)', r);

  await pool.end();
  console.log('\n\nSPONSOR LOGIN CREDENTIALS: mmkrtumyan29@gmail.com / ' + sponsorPassword + '  (must change on first login)');
})();