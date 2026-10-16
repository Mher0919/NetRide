// tests/e2e/dashboard-workflows/run-colab-e2e.cjs
//
// COLAB DASHBOARD HTTP E2E (test mode)
// ---------------------------------------------------------------------------
// Boots the REAL backend and drives the EXACT HTTP surface the sponsor portal
// (apps/sponsor_portal) calls, through the real auth + middleware stack:
//   * in-dashboard card entry (SetupIntent + confirm)
//   * saved payment-method management (list / default / detach, incl. the
//     rules: the default may not be removed, another sponsor never sees a
//     sponsor's methods)
//   * in-dashboard funding (PaymentIntent + confirm + budget credit) and the
//     idempotency replay guard (same key → refused, no double charge)
//   * withdrawal state endpoint used by the dashboard
//   * auth guard (no token → 401)
//
// Stripe test-mode tokens are used (pm_card_visa etc.); no real money moves.
// Refuses to run in production or without sk_test_ keys.
//
// Usage: node run-colab-e2e.cjs

process.env.REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
require('../../../backend/node_modules/dotenv').config({ path: require('path').resolve(__dirname, '../../../backend/.env') });

if (process.env.NODE_ENV === 'production') {
  console.error('❌ Refusing to run Colab E2E in production');
  process.exit(1);
}
if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_SECRET_KEY.startsWith('sk_test_')) {
  console.log('✅  SKIPPED — STRIPE_SECRET_KEY must be a TEST key (sk_test_…)');
  process.exit(0);
}

require('../../../backend/node_modules/ts-node').register({
  dir: require('path').resolve(__dirname, '../../../backend'),
  transpileOnly: true,
  compilerOptions: { module: 'commonjs', esModuleInterop: true },
});

const crypto = require('crypto');
const { spawn } = require('child_process');
const { pool } = require('../../../backend/src/config/database');
const { getStripe } = require('../../../backend/src/modules/payments/stripe.client');
const jwt = require('../../../backend/node_modules/jsonwebtoken');
const { env } = require('../../../backend/src/config/env');

let passed = 0, failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  [PASS] ${name}${extra ? ` — ${extra}` : ''}`); }
  else { failed++; console.log(`  [FAIL] ${name}${extra ? ` — ${extra}` : ''}`); }
};
const API = (port) => `http://127.0.0.1:${port}/api`;

async function waitForReady(port, attempts = 240) {
  // Poll /health/live (no dependencies, fast) — /health/ready probes Redis
  // and queues which are legitimately absent in local dev and make every
  // attempt take tens of seconds. Any HTTP response means the server is up.
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health/live`, { signal: AbortSignal.timeout(2000) });
      if (r.status >= 200 && r.status < 500) return true;
    } catch { /* not up yet */ }
    await new Promise((res) => setTimeout(res, 1000));
  }
  return false;
}

async function request(port, method, path, { token, body } = {}) {
  const res = await fetch(`${API(port)}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  return { status: res.status, data };
}

async function completeSetupIntent(customerId, pmToken, metadata) {
  const stripe = getStripe();
  const pm = (await stripe.paymentMethods.attach(pmToken, { customer: customerId })).id;
  const si = await stripe.setupIntents.create({
    customer: customerId,
    payment_method: pm,
    confirm: true,
    usage: 'off_session',
    automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
    metadata,
  });
  return { pm, si: si.id };
}

(async () => {
  const port = 19000 + Math.floor(Math.random() * 1000);
  // Run app.ts as the MAIN module so its `require.main === module` guard
  // binds the HTTP server (ts-node/register preloads the compiler).
  const server = spawn(process.execPath, ['-r', 'ts-node/register', 'src/app.ts'], {
    cwd: require('path').resolve(__dirname, '../../../backend'),
    env: { ...process.env, PORT: String(port), REDIS_URL: process.env.REDIS_URL },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => process.stdout.write(`  [server] ${d}`));
  server.stderr.on('data', (d) => process.stdout.write(`  [server!] ${d}`));
  console.log(`═══ COLAB DASHBOARD HTTP E2E ═══ (port ${port})`);

  let serverRef = server;
  try {
    if (!(await waitForReady(port))) throw new Error('backend did not become ready in time');
    console.log('  · backend ready');

    const suffix = crypto.randomBytes(4).toString('hex');
    const stripe = getStripe();

    // ---- scratch sponsor A + its portal user ------------------------------
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const userA = await client.query(
        `INSERT INTO users (email, full_name, password_hash, role) VALUES ($1, 'Colab E2E A', 'x', 'SPONSOR') RETURNING id`,
        [`colab-e2e-a-${suffix}@netride.test`],
      );
      const userB = await client.query(
        `INSERT INTO users (email, full_name, password_hash, role) VALUES ($1, 'Colab E2E B', 'x', 'SPONSOR') RETURNING id`,
        [`colab-e2e-b-${suffix}@netride.test`],
      );
      const sponsorA = await client.query(
        `INSERT INTO sponsors (business_name, business_type, discount_type, discount_percent,
                               max_discount_percent, initial_budget_cents, remaining_budget_cents,
                               reserved_budget_cents, used_budget_cents, status)
         VALUES ($1, 'RESTAURANT', 'PERCENTAGE', 10, 90, 0, 0, 0, 0, 'ACTIVE') RETURNING id`,
        [`Colab E2E A ${suffix}`],
      );
      const sponsorB = await client.query(
        `INSERT INTO sponsors (business_name, business_type, discount_type, discount_percent,
                               max_discount_percent, initial_budget_cents, remaining_budget_cents,
                               reserved_budget_cents, used_budget_cents, status)
         VALUES ($1, 'RESTAURANT', 'PERCENTAGE', 10, 90, 0, 0, 0, 0, 'ACTIVE') RETURNING id`,
        [`Colab E2E B ${suffix}`],
      );
      await client.query(
        `INSERT INTO sponsor_portal_accounts (user_id, sponsor_id, is_active, must_change_password)
         VALUES ($1, $2, TRUE, FALSE)`,
        [userA.rows[0].id, sponsorA.rows[0].id],
      );
      await client.query(
        `INSERT INTO sponsor_portal_accounts (user_id, sponsor_id, is_active, must_change_password)
         VALUES ($1, $2, TRUE, FALSE)`,
        [userB.rows[0].id, sponsorB.rows[0].id],
      );
      await client.query('COMMIT');
      const sponsorAId = sponsorA.rows[0].id;
      const sponsorBId = sponsorB.rows[0].id;
      const tokenA = jwt.sign(
        { id: userA.rows[0].id, role: 'SPONSOR', email: `colab-e2e-a-${suffix}@netride.test`, sponsorId: sponsorAId },
        env.JWT_SECRET,
        { expiresIn: '1h', algorithm: 'HS256' },
      );
      const tokenB = jwt.sign(
        { id: userB.rows[0].id, role: 'SPONSOR', email: `colab-e2e-b-${suffix}@netride.test`, sponsorId: sponsorBId },
        env.JWT_SECRET,
        { expiresIn: '1h', algorithm: 'HS256' },
      );

      // ---- 1. auth guard ---------------------------------------------------
      let r = await request(port, 'GET', '/sponsor/funding');
      ok('unauthenticated request → 401', r.status === 401);

      // ---- 2. funding dashboard state --------------------------------------
      r = await request(port, 'GET', '/sponsor/funding', { token: tokenA });
      ok('GET /sponsor/funding returns budget state', r.status === 200 && Number(r.data?.budget?.spendableBudgetCents ?? -1) === 0);

      // ---- 3. in-dashboard card entry (SetupIntent) ------------------------
      r = await request(port, 'POST', '/sponsor/payment-method/setup-intent', { token: tokenA });
      ok('setup-intent issued (client secret + pk_test key)', !!r.data?.setupIntentClientSecret && r.data?.publishableKey?.startsWith('pk_test_'), r.data?.customerId);
      const customerId = r.data.customerId;

      let completed = await completeSetupIntent(customerId, 'pm_card_visa', {
        kind: 'SPONSOR_CARD_SETUP',
        sponsor_id: sponsorAId,
      });
      r = await request(port, 'POST', '/sponsor/payment-method/setup-intent/confirm', {
        token: tokenA,
        body: { setupIntentId: completed.si },
      });
      ok('server-side setup confirmation applied', r.status === 200 && r.data?.applied === true);

      r = await request(port, 'GET', '/sponsor/payment-methods', { token: tokenA });
      let visa = r.data?.methods?.[0];
      ok('payment method listed with default flag', r.status === 200 && r.data?.methods?.length === 1 && visa?.isDefault === true, visa?.last4);

      // Second card: adding must not clear or double-book the first.
      const completed2 = await completeSetupIntent(customerId, 'pm_card_mastercard', {
        kind: 'SPONSOR_CARD_SETUP',
        sponsor_id: sponsorAId,
      });
      r = await request(port, 'POST', '/sponsor/payment-method/setup-intent/confirm', {
        token: tokenA,
        body: { setupIntentId: completed2.si },
      });
      r = await request(port, 'GET', '/sponsor/payment-methods', { token: tokenA });
      ok('two saved methods listed', r.status === 200 && r.data?.methods?.length === 2);

      // ---- 4. set default / detach ------------------------------------------
      const mastercard = r.data.methods.find((m) => m.id !== visa.id);
      r = await request(port, 'POST', `/sponsor/payment-methods/${mastercard.id}/default`, { token: tokenA });
      ok('default payment method changed', r.status === 200);
      r = await request(port, 'GET', '/sponsor/payment-methods', { token: tokenA });
      const mc = r.data.methods.find((m) => m.id === mastercard.id);
      const updatedVisa = r.data.methods.find((m) => m.id !== mastercard.id);
      ok('default flag followed the switch', mc?.isDefault === true && updatedVisa?.isDefault === false);

      r = await request(port, 'DELETE', `/sponsor/payment-methods/${updatedVisa.id}`, { token: tokenA });
      ok('non-default card removed', r.status === 200);
      r = await request(port, 'DELETE', `/sponsor/payment-methods/${mastercard.id}`, { token: tokenA });
      ok('default card removal refused (400)', r.status === 400);

      // ---- 5. in-dashboard funding + idempotency replay ---------------------
      const fundKey = `colab-fund:${suffix}`;
      r = await request(port, 'POST', '/sponsor/funding/intent', {
        token: tokenA,
        body: { amountCents: 2500, idempotencyKey: fundKey },
      });
      ok('funding PaymentIntent client secret issued', r.status === 200 && !!r.data?.clientSecret, r.data?.paymentIntentId);
      const stripe2 = getStripe();
      const confirmedPi = await stripe2.paymentIntents.confirm(r.data.paymentIntentId, { payment_method: mastercard.id });
      r = await request(port, 'POST', `/sponsor/funding/intent/${r.data.paymentRowId}/confirm`, {
        token: tokenA,
        body: { paymentIntentId: r.data.paymentIntentId },
      });
      ok('funding confirmed → budget credited', r.status === 200 && r.data?.status === 'SUCCEEDED', `${confirmedPi.status}`);
      r = await request(port, 'GET', '/sponsor/funding', { token: tokenA });
      ok('budget reflects the $25.00 credit', Number(r.data?.budget?.initialBudgetCents) === 2500, `$${(Number(r.data?.budget?.initialBudgetCents) / 100).toFixed(2)}`);

      r = await request(port, 'POST', '/sponsor/funding/intent', {
        token: tokenA,
        body: { amountCents: 2500, idempotencyKey: fundKey },
      });
      ok('funding idempotency replay refused (no double charge)', r.status === 400);

      // ---- 6. tenant isolation ----------------------------------------------
      r = await request(port, 'GET', '/sponsor/payment-methods', { token: tokenB });
      ok('sponsor B never sees sponsor A methods', r.status === 200 && r.data?.methods?.length === 0);
      r = await request(port, 'DELETE', `/sponsor/payment-methods/${mastercard.id}`, { token: tokenB });
      ok('sponsor B cannot remove sponsor A card', r.status !== 200);
      r = await request(port, 'POST', `/sponsor/payment-methods/${mastercard.id}/default`, { token: tokenB });
      ok('sponsor B cannot change sponsor A default', r.status !== 200);

      // ---- 7. withdrawal state used by the dashboard ------------------------
      r = await request(port, 'GET', '/sponsor/withdrawals', { token: tokenA });
      ok('withdrawal state endpoint works', r.status === 200 && r.data?.state?.eligible === true);

      // ---- cleanup -----------------------------------------------------------
      await pool.query('DELETE FROM stripe_payments WHERE sponsor_id = $1', [sponsorAId]);
      await pool.query('DELETE FROM sponsor_ledger_entries WHERE sponsor_id = $1', [sponsorAId]);
      await pool.query('DELETE FROM sponsors WHERE id = $1', [sponsorAId]);
      await pool.query('DELETE FROM sponsor_portal_accounts WHERE sponsor_id = $1', [sponsorAId]);
      await pool.query('DELETE FROM users WHERE id = $1', [userA.rows[0].id]);
      await pool.query('DELETE FROM sponsor_portal_accounts WHERE sponsor_id = $1', [sponsorBId]);
      await pool.query('DELETE FROM sponsors WHERE id = $1', [sponsorBId]);
      await pool.query('DELETE FROM users WHERE id = $1', [userB.rows[0].id]);
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* noop */ }
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    failed++;
    console.error('❌ COLAB E2E failed:', err.message);
  } finally {
    serverRef.kill('SIGTERM');
    setTimeout(() => process.exit(failed > 0 ? 1 : 0), 500);
    console.log(`\nCOLAB E2E: ${passed} passed, ${failed} failed`);
  }
})();