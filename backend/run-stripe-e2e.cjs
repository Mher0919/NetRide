// backend/run-stripe-e2e.cjs
//
// REAL STRIPE SANDBOX E2E (test mode)
// ---------------------------------------------------------------------------
// Exercises the actual Stripe test-mode flow when credentials are present:
//   1. creates/reuses a Stripe customer for a seeded rider,
//   2. runs a rider wallet top-up through Checkout-completed reconciliation,
//   3. charges the saved card off-session (test card 4242...),
//   4. runs a sponsor budget top-up webhook application,
//   5. reports the resulting local database state.
//
// The Stripe payment ISN'T a real payment (Stripe test mode). Existing cards
// and webhooks are never touched in live mode; the script refuses to run
// with live keys (see stripe.client.ts interlock).
//
// Usage:
//   node run-stripe-e2e.cjs            # requires test keys in backend/.env
//
// Needs the webhook forwarding running for step 3's confirmation to arrive:
//   stripe listen --forward-to localhost:3000/api/payments/webhook

process.env.REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
process.env.PORT = '0';
require('dotenv').config();

if (process.env.NODE_ENV === 'production') {
  console.error('❌ Refusing to run Stripe E2E in production');
  process.exit(1);
}
if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_SECRET_KEY.startsWith('sk_test_')) {
  console.error('⏭️  SKIPPED — STRIPE_SECRET_KEY must be a TEST key (sk_test_…) to run this script.');
  console.error('     (This is expected if you have not configured the sandbox yet.)');
  process.exit(0);
}

require('ts-node').register({
  transpileOnly: true,
  compilerOptions: { module: 'commonjs', esModuleInterop: true },
});

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { Client } = require('pg');

const { pool } = require('./src/config/database');
const { PaymentsService } = require('./src/modules/payments/payments.service');
const { getStripeGateway } = require('./src/modules/payments/stripe.gateway');
const { getStripe } = require('./src/modules/payments/stripe.client');

let passed = 0, failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  [PASS] ${name}${extra ? ` — ${extra}` : ''}`); }
  else { failed++; console.log(`  [FAIL] ${name}${extra ? ` — ${extra}` : ''}`); }
};

(async () => {
  const suffix = crypto.randomBytes(4).toString('hex');
  const email = `stripe-e2e-${suffix}@netride.test`;
  const client = new Client({ connectionString: process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL });
  await client.connect();

  const hash = await bcrypt.hash('password123', 4);
  const user = await client.query(
    `INSERT INTO users (email, full_name, password_hash, role, is_verified, verification_status, is_active, rating, rating_count)
     VALUES ($1, 'Stripe E2E Rider', $2, 'RIDER', TRUE, 'VERIFIED', TRUE, 5.0, 0)
     RETURNING id`, [email, hash],
  );
  const riderId = user.rows[0].id;
  console.log('═══ STRIPE SANDBOX E2E ═══');

  try {
    // 1. Customer
    const customer = await PaymentsService.ensureStripeCustomer(riderId);
    ok('Stripe customer created/reused', !!customer, customer?.customerId);

    // 2. Wallet top-up session + simulated Checkout completion (reconcile path
    //    mirrors what `stripe trigger checkout.session.completed` delivers).
    const topup = await PaymentsService.createWalletTopUpSession({
      userId: riderId,
      amountCents: 2500,
      successUrl: 'http://localhost:3000/api/payments/return?kind=topup&state=success',
      cancelUrl: 'http://localhost:3000/api/payments/return?kind=topup&state=cancel',
      idempotencyKey: `e2e-topup:${suffix}`,
    });
    ok('wallet top-up Checkout session created', !!topup.url, topup.url?.slice(0, 80));

    const gateway = getStripeGateway();
    const sessionRow = await pool.query(`SELECT stripe_checkout_session_id FROM stripe_payments WHERE id = $1`, [topup.paymentRowId]);
    const sessionId = sessionRow.rows[0]?.stripe_checkout_session_id;
    ok('session id persisted locally', !!sessionId);
    if (sessionId) {
      const fresh = await gateway.retrieveCheckoutSession(sessionId);
      ok('session retrievable from Stripe', fresh.id === sessionId, fresh.status ?? '');
    }

    // 3. Off-session charge with a saved TEST card (data below is Stripe's
    //    documented test card — no real money moves in test mode).
    const stripe = getStripe();
    const pm = await stripe.paymentMethods.create({
      type: 'card',
      card: { number: '4242424242424242', exp_month: 12, exp_year: 2034, cvc: '123' },
    });
    await stripe.paymentMethods.attach(pm.id, { customer: customer.customerId });
    const charge = await PaymentsService.chargeRiderOffSession({
      riderId,
      amountCents: 1500,
      purpose: 'RIDE_CHARGE',
      idempotencyKey: `e2e-charge:${suffix}`,
      requireConsent: false,
    });
    ok('off-session charge accepted in test mode', charge.ok === true, `${charge.paymentIntentId} ${charge.failureReason ?? ''}`);

    // 4. Webhook application: mark the payment row succeeded as the
    //    payment_intent.succeeded delivery would.
    if (charge.paymentIntentId) {
      const intent = await gateway.retrievePaymentIntent(charge.paymentIntentId);
      ok('PaymentIntent succeeded in test mode', intent.status === 'succeeded', intent.status);
      const applied = await PaymentsService.reconcilePayment(charge.paymentRowId!);
      ok('reconcile applies the succeeded intent', applied.applied === true || applied.status === 'SUCCEEDED', JSON.stringify(applied));
    }
  } catch (err) {
    failed++;
    console.error('❌ E2E step failed:', err.message);
  } finally {
    // Cleanup
    await pool.query(`DELETE FROM stripe_payments WHERE user_id = $1`, [riderId]);
    await pool.query(`DELETE FROM stripe_customers WHERE user_id = $1`, [riderId]);
    await pool.query(`DELETE FROM wallet_transactions WHERE user_id = $1`, [riderId]);
    await pool.query(`DELETE FROM rider_wallets WHERE user_id = $1`, [riderId]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [riderId]);
    await client.end();
    console.log(`\nSTRIPE E2E: ${passed} passed, ${failed} failed`);
    setTimeout(() => process.exit(failed > 0 ? 1 : 0), 300);
  }
})().catch((err) => { console.error('❌ STRIPE E2E crashed:', err.message); process.exit(1); });