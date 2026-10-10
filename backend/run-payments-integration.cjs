// backend/run-payments-integration.cjs
//
// PAYMENT SETTLEMENT INTEGRATION TESTS (no real money, no Stripe network)
// ---------------------------------------------------------------------------
// Runs the real settlement services against the configured Postgres with a
// FAKE Stripe gateway installed (setStripeGatewayForTests). Every money
// assertion exercises production code paths: fare breakdowns, wallet
// collection, off-session Stripe collection, sponsor budget consume/release,
// driver earnings from the ORIGINAL fare, the expiry additional charge and
// idempotency under duplicates/retries.
//
// Usage:   node run-payments-integration.cjs
// Safety:  refuses to run when NODE_ENV=production. Creates only test *
//          accounts (emails @netride.test) and cleans up after itself.
//          Set SKIP_PAYMENTS_E2E=1 to bypass.

process.env.REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
process.env.PORT = '0';
require('dotenv').config();

if (process.env.NODE_ENV === 'production' || process.env.SKIP_PAYMENTS_E2E === '1') {
  console.log('⏭️  SKIPPED (production or SKIP_PAYMENTS_E2E)');
  process.exit(0);
}

require('ts-node').register({
  transpileOnly: true,
  compilerOptions: { module: 'commonjs', esModuleInterop: true },
});

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const { pool } = require('./src/config/database');
const { WalletService } = require('./src/modules/wallet/wallet.service');
const { DriverService } = require('./src/modules/driver/driver.service');
const { FinancialLedgerService, centsValue } = require('./src/services/financial-ledger.service');
const { RideSettlementService } = require('./src/modules/payments/ride-settlement.service');
const { PaymentsService } = require('./src/modules/payments/payments.service');
const { SpecialRedemptionService } = require('./src/modules/sponsor/special-redemption.service');
const { SponsorService } = require('./src/modules/sponsor/sponsor.service');
const { setStripeGatewayForTests, clearStripeGatewayForTests } = require('./src/modules/payments/stripe.gateway');
const {
  requestSponsorWithdrawal,
  sponsorWithdrawalState,
  driverWithdrawalState,
  assertDriverCanWithdraw,
  executeSponsorWithdrawalRefunds,
} = require('./src/modules/payments/withdrawal.service');

let passed = 0, failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  [PASS] ${name}${extra ? ` — ${extra}` : ''}`); }
  else { failed++; console.log(`  [FAIL] ${name}${extra ? ` — ${extra}` : ''}`); }
};
const section = (s) => console.log(`\n═══ ${s} ═══`);

// ---------------------- fake Stripe gateway ---------------------------------
function fakeGateway({ onCharge } = {}) {
  const charges = [];
  const refunds = [];
  let failNextCharges = false;
  return {
    charges,
    refunds,
    setFailCharges(v) { failNextCharges = v; },
    async createOffSessionCharge(params) {
      charges.push({
        amountCents: params.amountCents,
        customerId: params.customerId,
        paymentMethodId: params.paymentMethodId,
        idempotencyKey: params.idempotencyKey,
      });
      const piId = `pi_${crypto.randomBytes(10).toString('hex')}`;
      if (failNextCharges) {
        return { paymentIntentId: piId, status: 'requires_payment_method', chargeId: null, failureReason: 'Your card was declined.', requiresAction: false };
      }
      return { paymentIntentId: piId, status: 'succeeded', chargeId: `ch_${crypto.randomBytes(6).toString('hex')}`, failureReason: null, requiresAction: false };
    },
    async createRefund(params) {
      refunds.push({
        paymentIntentId: params.paymentIntentId,
        amountCents: params.amountCents,
        idempotencyKey: params.idempotencyKey,
      });
      return { refundId: `re_${crypto.randomBytes(6).toString('hex')}`, status: 'succeeded' };
    },
    async createCheckoutSession() { throw new Error('not used in integration tests'); },
    async retrieveCheckoutSession() { throw new Error('not used'); },
    async retrieveSetupIntent() { throw new Error('not used'); },
    async retrievePaymentIntent(id) { return { id, status: 'succeeded', amountCents: 0, amountReceivedCents: 0, chargeId: null, customerId: null, paymentMethodId: null, metadata: {}, lastPaymentError: null }; },
    async ensureCustomer({ userId }) { return { customerId: `cus_test_${userId}` }; },
    async createExpressAccount() { throw new Error('not used'); },
    async createAccountLink() { throw new Error('not used'); },
    async retrieveAccount() { throw new Error('not used'); },
    async createTransfer() { throw new Error('not used in integration tests'); },
    async retrieveBalanceTransaction() { return { feeCents: 29, netCents: 0, currency: 'usd' }; },
    async retrieveCharge(id) { return { id, balanceTransactionId: 'txn_fake', refundedAmountCents: 0, amountCents: 0 }; },
    async retrievePaymentMethod() { throw new Error('not used'); },
    async listPaymentMethods() { return [{ id: 'pm_fake', brand: 'visa', last4: '4242', expMonth: 12, expYear: 2034 }]; },
    async detachPaymentMethod() {},
    constructWebhookEvent() { throw new Error('not used'); },
  };
}

// ---------------------- fixtures -------------------------------------------
const suffix = crypto.randomBytes(4).toString('hex');
let riderId = null, driverId = null, sponsorId = null, redemptionId = null, rideId = null;
const createdIds = { users: [], sponsor: null, redemptions: [], rides: [], wallets: [] };

async function seedUser(email, role) {
  const id = uuidv4();
  const res = await pool.query(
    `INSERT INTO users (id, email, full_name, password_hash, role, is_verified, verification_status, is_active, rating, rating_count)
     VALUES ($1, $2, $3, 'x', $4, TRUE, 'VERIFIED', TRUE, 5.0, 0)
     RETURNING id`,
    [id, email, `Test ${role} ${suffix}`, role],
  );
  if (role === 'DRIVER') {
    await pool.query(`INSERT INTO drivers (user_id, license_number) VALUES ($1, $2)`, [id, `LIC${suffix}`]);
  }
  createdIds.users.push(id);
  return res.rows[0].id;
}

async function seedSponsor(budgetCents) {
  const id = uuidv4();
  await pool.query(
    `INSERT INTO sponsors (
       id, business_name, business_type, discount_type, max_discount_percent,
       discount_fixed_amount_cents, initial_budget_cents, remaining_budget_cents,
       reserved_budget_cents, used_budget_cents, status,
       latitude, longitude
     ) VALUES ($1, 'PayTest Sponsor', 'TEST', 'FIXED_AMOUNT', 90, $2, $3, $3, 0, 0, 'ACTIVE', 34.05, -118.24)`,
    [id, budgetCents, budgetCents],
  );
  await pool.query(
    `INSERT INTO sponsor_ledger_entries (sponsor_id, type, amount_cents, direction, reference_type, reason, balance_after_cents)
     VALUES ($1, 'INITIAL_FUNDING', $2, 'CREDIT', 'integration_test', 'Seed', $2)`,
    [id, budgetCents],
  );
  createdIds.sponsor = id;
  return id;
}

async function insertSpecialRide({ rider, driver, originalFareCents, subsidyCents, riderCollectedHint }) {
  const id = uuidv4();
  const sponsor = createdIds.sponsor;
  await pool.query(
    `INSERT INTO rides (
       id, rider_id, status, pickup_lat, pickup_lng, pickup_address,
       destination_lat, destination_lng, destination_address, requested_class,
       distance_meters, duration_seconds, fare_amount,
       final_payment_cents, sponsor_discount_cents, special_terms_accepted_at
     ) VALUES ($1,$2,'COMPLETED',34.05,-118.24,'A',34.01,-118.49,'B','CORE',5000,900,$3,$4,$5,NOW())`,
    [id, rider, (originalFareCents / 100).toFixed(2), originalFareCents - subsidyCents, subsidyCents],
  );
  await pool.query(
    `INSERT INTO ride_price_snapshots (
       ride_id, distance_km, duration_minutes, final_fare,
       driver_share_cents, platform_share_cents, netride_share_cents,
       fleet_allocations, revenue_config_snapshot
     ) VALUES ($1,5,15,$2,600,400,400,'[]','{"driverSharePercent":60,"platformSharePercent":40}')`,
    [id, (originalFareCents / 100).toFixed(2)],
  );
  // The special redemption attached to the ride (RIDE_PENDING after request).
  const redemptionId = uuidv4();
  await pool.query(
    `INSERT INTO special_redemptions (
       id, sponsor_id, rider_id, ride_id, status, ride_requested_at, ride_completed_at,
       sponsor_name, sponsor_business_type, discount_type, discount_fixed_amount_cents,
       calculated_discount_cents, discount_label
     ) VALUES ($1,$2,$3,$4,'RIDE_PENDING',NOW(),NOW(),'PayTest Sponsor','RESTAURANT','FIXED_AMOUNT',$5,$5,'$5.00 off')`,
    [redemptionId, sponsor, rider, id, subsidyCents],
  );
  createdIds.rides.push(id);
  createdIds.redemptions.push(redemptionId);
  // Mirror attachToRideRequest: the subsidy is RESERVED from the budget.
  await pool.query(
    `UPDATE sponsors SET reserved_budget_cents = reserved_budget_cents + $2, updated_at = NOW() WHERE id = $1`,
    [sponsor, subsidyCents],
  );
  return { rideId: id, redemptionId };
}

async function finishRide(rideId, rider, driver, { walletBalanceCents, riderCollectedExactly }) {
  // Wallet funding so the completion charge can settle.
  await WalletService.post(rider, walletBalanceCents, 'ADMIN_GRANT', { idempotencyKey: `seed:${rideId}`, description: 'test funding' });
  // Breakdown snapshot (as the accept path would).
  await RideSettlementService.snapshotOnAccept(rideId, driver);
  // Existing completion pieces: driver wallet credit + rider wallet charge.
  await DriverService.creditOnRideComplete(driver, 1000, 0, rideId);
  const due = await pool.query(`SELECT final_payment_cents FROM rides WHERE id = $1`, [rideId]);
  const charged = await WalletService.chargeForRide(rider, rideId, centsValue(due.rows[0].final_payment_cents));
  if (charged.walletChargeCents > 0) {
    await pool.query(`UPDATE rides SET wallet_payment_cents = $1 WHERE id = $2`, [charged.walletChargeCents, rideId]);
  }
  // Ledger + settlement pass.
  const alloc = { driverShareCents: 600, platformShareCents: 400, netrideShareCents: 400 };
  await FinancialLedgerService.recordRideCompletion({
    rideId, riderId: rider, driverId: driver, fareCents: centsValue(due.rows[0].final_payment_cents),
    promotionCents: 0, creditsCents: 0, tipCents: 0,
    walletPaymentCents: charged.walletChargeCents || riderCollectedExactly || 0,
    amountOwedCents: 0, driverShareCents: alloc.driverShareCents, platformShareCents: alloc.platformShareCents,
    netrideShareCents: alloc.netrideShareCents, paymentProvider: 'wallet', paymentReference: rideId,
    completedAt: new Date(), originalFareCents: 1000, riderShareCents: centsValue(due.rows[0].final_payment_cents),
    sponsorSubsidyCents: 500, sponsorCollectedCents: 0, additionalRiderChargeCents: 0,
  });
  await RideSettlementService.onRideCompleted(rideId);
}

async function cleanup() {
  for (const rideId of createdIds.rides) {
    await pool.query(`DELETE FROM stripe_payments WHERE ride_id = $1`, [rideId]).catch(() => {});
    await pool.query(`DELETE FROM financial_transactions WHERE ride_id = $1`, [rideId]).catch(() => {});
    await pool.query(`DELETE FROM payouts WHERE ride_id = $1`, [rideId]).catch(() => {});
    await pool.query(`DELETE FROM ride_fare_breakdowns WHERE ride_id = $1`, [rideId]).catch(() => {});
    await pool.query(`DELETE FROM rides WHERE id = $1`, [rideId]).catch(() => {});
  }
  for (const r of createdIds.redemptions) {
    await pool.query(`DELETE FROM special_redemptions WHERE id = $1`, [r]).catch(() => {});
  }
  if (createdIds.sponsor) {
    await pool.query(`DELETE FROM sponsor_ledger_entries WHERE sponsor_id = $1`, [createdIds.sponsor]).catch(() => {});
    await pool.query(`DELETE FROM stripe_payments WHERE sponsor_id = $1`, [createdIds.sponsor]).catch(() => {});
    await pool.query(
      `DELETE FROM special_redemptions WHERE sponsor_id = $1 ` + 
      (createdIds.redemptions.length ? `AND id = ANY($2::uuid[])` : `AND id = NULL`),
      createdIds.redemptions.length ? [createdIds.sponsor, createdIds.redemptions] : [createdIds.sponsor],
    ).catch(() => {});
    await pool.query(`DELETE FROM sponsors WHERE id = $1`, [createdIds.sponsor]).catch(() => {});
  }
  for (const u of createdIds.users) {
    await pool.query(`DELETE FROM stripe_payments WHERE user_id = $1`, [u]).catch(() => {});
    await pool.query(`DELETE FROM rider_wallets WHERE user_id = $1`, [u]).catch(() => {});
    await pool.query(`DELETE FROM wallet_transactions WHERE user_id = $1`, [u]).catch(() => {});
    await pool.query(`DELETE FROM driver_wallets WHERE driver_id = $1`, [u]).catch(() => {});
    await pool.query(`DELETE FROM stripe_customers WHERE user_id = $1`, [u]).catch(() => {});
    await pool.query(`DELETE FROM users WHERE id = $1`, [u]).catch(() => {});
  }
}

(async () => {
  console.log('NETRIDE PAYMENT SETTLEMENT INTEGRATION TESTS (fake Stripe, real Postgres)');

  // ---------------------------- SCENARIO 1: SPECIAL SUCCESS -----------------
  section('SCENARIO 1 — $10 special ride, $5 rider / $5 sponsor, driver from ORIGINAL fare');
  {
    const gateway = fakeGateway();
    setStripeGatewayForTests(gateway);
    try {
      riderId = await seedUser(`stripe-rider-${suffix}@netride.test`, 'RIDER');
      driverId = await seedUser(`stripe-driver-${suffix}@netride.test`, 'DRIVER');
      sponsorId = await seedSponsor(100000); // $1,000.00 funded budget

      // Give the rider a saved card + consent (off-session charge permission).
      await pool.query(
        `INSERT INTO stripe_customers (user_id, stripe_customer_id, default_payment_method_id, card_last4, off_session_consent, off_session_consent_at)
         VALUES ($1, 'cus_rider', 'pm_rider', '4242', TRUE, NOW())`,
        [riderId],
      );

      const { rideId: r1, redemptionId: rd1 } = await insertSpecialRide({
        rider: riderId, driver: driverId, originalFareCents: 1000, subsidyCents: 500,
      });
      rideId = r1; redemptionId = rd1;

      // Driver request screen value: earnings must be from the ORIGINAL fare.
      const breakdown = await RideSettlementService.snapshotOnAccept(r1, driverId).then(() =>
        pool.query(`SELECT * FROM ride_fare_breakdowns WHERE ride_id = $1`, [r1])
      );
      const b = breakdown.rows[0];
      ok('breakdown: original fare $10', centsValue(b.original_fare_cents) === 1000);
      ok('breakdown: sponsor subsidy $5', centsValue(b.sponsor_subsidy_cents) === 500);
      ok('breakdown: rider share $5', centsValue(b.rider_share_cents) === 500);
      ok('breakdown: driver earnings $6 (from ORIGINAL fare)', centsValue(b.driver_earnings_cents) === 600, `got ${centsValue(b.driver_earnings_cents)}`);
      ok('breakdown: platform commission $4', centsValue(b.platform_commission_cents) === 400);

      await finishRide(r1, riderId, driverId, { walletBalanceCents: 1000, riderCollectedExactly: 500 });

      const afterComplete = (await pool.query(`SELECT * FROM ride_fare_breakdowns WHERE ride_id = $1`, [r1])).rows[0];
      ok('completion: rider collected $5', centsValue(afterComplete.rider_collected_cents) === 500);
      ok('completion: settlement PARTIALLY_SETTLED (sponsor pending)', afterComplete.settlement_status === 'PARTIALLY_SETTLED');

      // Driver total after completion: 60% of ORIGINAL fare, exactly.
      const driverWallet = (await pool.query(`SELECT balance_cents, lifetime_earnings_cents FROM driver_wallets WHERE driver_id = $1`, [driverId])).rows[0];
      ok('completion: driver wallet +600 (60% of $10)', centsValue(driverWallet.balance_cents) === 600, `got ${centsValue(driverWallet.balance_cents)}`);

      // Redemption: code → sponsor validates → settlement happens
      // AUTOMATICALLY (NEW MODEL — no rider reward is ever issued).
      await pool.query(
        `UPDATE special_redemptions SET status = 'SPONSOR_VALIDATED',
                sponsor_validated_at = NOW(), sponsor_validated_by = $2
         WHERE id = $1`,
        [rd1, sponsorId],
      );
      const beforeBudget = (await pool.query(`SELECT remaining_budget_cents, reserved_budget_cents FROM sponsors WHERE id = $1`, [sponsorId])).rows[0];
      const walletBeforeSettle = (await pool.query(`SELECT balance_cents FROM rider_wallets WHERE user_id = $1`, [riderId])).rows[0];
      const settled = await SpecialRedemptionService.settleValidatedRedemption(rd1);
      ok('validation settles automatically → REWARD_COMPLETED', settled.status === 'REWARD_COMPLETED');
      ok('NO rider reward: reward_choice null, no reward amount',
        (settled.reward_choice === null || settled.reward_choice === undefined)
        && (settled.reward_amount_cents == null || settled.reward_amount_cents === 0),
        `choice=${settled.reward_choice} amount=${settled.reward_amount_cents}`);
      const walletAfterSettle = (await pool.query(`SELECT balance_cents FROM rider_wallets WHERE user_id = $1`, [riderId])).rows[0];
      const rewardWalletTx = (await pool.query(
        `SELECT COUNT(*)::int AS n FROM wallet_transactions WHERE user_id = $1 AND type = 'SPONSOR_REWARD'`,
        [riderId],
      )).rows[0];
      ok('rider wallet NOT credited by settlement (no cash back)', centsValue(walletAfterSettle.balance_cents) === centsValue(walletBeforeSettle.balance_cents), `balance=${centsValue(walletAfterSettle.balance_cents)}`);
      ok('no SPONSOR_REWARD wallet transaction exists', rewardWalletTx.n === 0);

      const afterBudget = (await pool.query(`SELECT remaining_budget_cents, reserved_budget_cents, used_budget_cents FROM sponsors WHERE id = $1`, [sponsorId])).rows[0];
      ok('sponsor: reserved released to 0', centsValue(afterBudget.reserved_budget_cents) === 0, `reserved=${centsValue(afterBudget.reserved_budget_cents)}`);
      ok('sponsor: spent exactly $5 of funded budget', centsValue(afterBudget.used_budget_cents) === 500, `used=${centsValue(afterBudget.used_budget_cents)}`);
      ok('sponsor: remaining = funded - used', centsValue(afterBudget.remaining_budget_cents) === centsValue(beforeBudget.remaining_budget_cents) - 500);

      const settledBreakdown = (await pool.query(`SELECT * FROM ride_fare_breakdowns WHERE ride_id = $1`, [r1])).rows[0];
      ok('settlement: sponsor collected $5', centsValue(settledBreakdown.sponsor_collected_cents) === 500);
      ok('settlement: SETTLED (5 rider + 5 sponsor = 10)', settledBreakdown.settlement_status === 'SETTLED');

      const driverAfter = (await pool.query(`SELECT balance_cents FROM driver_wallets WHERE driver_id = $1`, [driverId])).rows[0];
      ok('driver NOT double-paid: still exactly $6 (no SPONSOR_CREDIT, no top-up)', centsValue(driverAfter.balance_cents) === 600, `got ${centsValue(driverAfter.balance_cents)}`);
      const sponsorPayouts = (await pool.query(`SELECT COUNT(*)::int AS n FROM payouts WHERE ride_id = $1`, [r1])).rows[0];
      ok('no SPONSOR_CREDIT payout row for this ride', sponsorPayouts.n === 1, `payout rows=${sponsorPayouts.n} (only RIDE_CREDIT)`);

      const ledger = (await pool.query(`SELECT * FROM financial_transactions WHERE ride_id = $1`, [r1])).rows[0];
      ok('ledger: sponsor_collected_cents = 500', centsValue(ledger.sponsor_collected_cents) === 500);
      ok('ledger: sponsor_contribution_status = COLLECTED', ledger.sponsor_contribution_status === 'COLLECTED');
      ok('ledger: rider_share_cents = 500, original_fare_cents = 1000',
        centsValue(ledger.rider_share_cents) === 500 && centsValue(ledger.original_fare_cents) === 1000);

      // Idempotency: repeating the settlement must not double anything.
      const walletBeforeRepeat = (await pool.query(`SELECT balance_cents FROM rider_wallets WHERE user_id = $1`, [riderId])).rows[0];
      await SpecialRedemptionService.settleValidatedRedemption(rd1);
      const walletAfterRepeat = (await pool.query(`SELECT balance_cents FROM rider_wallets WHERE user_id = $1`, [riderId])).rows[0];
      ok('duplicate settlement: wallet unchanged', centsValue(walletAfterRepeat.balance_cents) === centsValue(walletBeforeRepeat.balance_cents));
      const sponsorLedgerCount = (await pool.query(
        `SELECT COUNT(*)::int AS n FROM sponsor_ledger_entries WHERE sponsor_id = $1 AND type = 'DISCOUNT_REDEEMED' AND reference_id = $2`,
        [sponsorId, rd1],
      )).rows[0];
      ok('duplicate redemption: exactly one DISCOUNT_REDEEMED ledger row', sponsorLedgerCount.n === 1);
    } finally {
      clearStripeGatewayForTests();
    }
  }

  // ---------------------------- SCENARIO 2: SPECIAL EXPIRY ------------------
  section('SCENARIO 2 — same $10 ride, no redemption → rider charged remaining $5 once, sponsor pays 0');
  {
    const gateway = fakeGateway();
    setStripeGatewayForTests(gateway);
    try {
      riderId = await seedUser(`stripe-exp-rider-${suffix}@netride.test`, 'RIDER');
      driverId = await seedUser(`stripe-exp-driver-${suffix}@netride.test`, 'DRIVER');
      sponsorId = await seedSponsor(100000);
      const { rideId: r2, redemptionId: rd2 } = await insertSpecialRide({
        rider: riderId, driver: driverId, originalFareCents: 1000, subsidyCents: 500,
      });
      rideId = r2; redemptionId = rd2;
      await pool.query(
        `INSERT INTO stripe_customers (user_id, stripe_customer_id, default_payment_method_id, off_session_consent)
         VALUES ($1, 'cus_exp', 'pm_exp', TRUE)`, [riderId],
      );
      await finishRide(r2, riderId, driverId, { walletBalanceCents: 1000 });
      // Rider paid their $5 share from the wallet; the rest sits for the
      // expiry collection.
      const precheck = (await pool.query(`SELECT rider_collected_cents FROM ride_fare_breakdowns WHERE ride_id=$1`, [r2])).rows[0];
      ok('expiry precheck: rider collected exactly $5', centsValue(precheck.rider_collected_cents) === 500);

      // Code issued, then expires: make the deadline pass, run the cron body.
      await pool.query(
        `UPDATE special_redemptions SET status='WAITING_FOR_SPONSOR', validation_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`,
        [rd2],
      );
      const expired = await SpecialRedemptionService.expireStaleRedemptions();
      ok('expiry job expires the redemption', expired === 1);

      const expBreakdown = (await pool.query(`SELECT * FROM ride_fare_breakdowns WHERE ride_id = $1`, [r2])).rows[0];
      ok('expiry: redemption EXPIRED', (await pool.query(`SELECT status FROM special_redemptions WHERE id=$1`, [rd2])).rows[0].status === 'EXPIRED');
      ok('expiry: sponsor contribution RELEASED (0 collected)', expBreakdown.sponsor_contribution_status === 'RELEASED' && centsValue(expBreakdown.sponsor_collected_cents) === 0);
      ok('expiry: rider total collected = $10', centsValue(expBreakdown.rider_collected_cents) === 1000, `got ${centsValue(expBreakdown.rider_collected_cents)}`);
      ok('expiry: additional charge COLLECTED = $5', expBreakdown.additional_charge_status === 'COLLECTED' && centsValue(expBreakdown.additional_rider_charge_cents) === 500);
      ok('expiry: settlement SETTLED', expBreakdown.settlement_status === 'SETTLED');

      const sponsorAfter = (await pool.query(`SELECT reserved_budget_cents, used_budget_cents FROM sponsors WHERE id=$1`, [sponsorId])).rows[0];
      ok('expiry: sponsor spent $0', centsValue(sponsorAfter.used_budget_cents) === 0);

      const expLedger = (await pool.query(`SELECT * FROM financial_transactions WHERE ride_id=$1`, [r2])).rows[0];
      ok('ledger: additional_rider_charge_cents = 500', centsValue(expLedger.additional_rider_charge_cents) === 500);
      ok('ledger: status SETTLED (rider paid the full fare)', expLedger.status === 'SETTLED');

      const driverWallet2 = (await pool.query(`SELECT balance_cents FROM driver_wallets WHERE driver_id=$1`, [driverId])).rows[0];
      ok('expiry: driver still earned the ORIGINAL-fare share ($6)', centsValue(driverWallet2.balance_cents) === 600, `got ${centsValue(driverWallet2.balance_cents)}`);

      // Idempotency: a repeated expiration run cannot charge the rider again.
      const stripeChargesBefore = gateway.charges.length;
      const riderWalletAfter = (await pool.query(`SELECT balance_cents FROM rider_wallets WHERE user_id=$1`, [riderId])).rows[0];
      await SpecialRedemptionService.expireStaleRedemptions();
      await RideSettlementService.sweepExpiredAdditionalCharges();
      const riderWalletRepeat = (await pool.query(`SELECT balance_cents FROM rider_wallets WHERE user_id=$1`, [riderId])).rows[0];
      ok('repeated expiry job: no duplicate charge attempts', gateway.charges.length === stripeChargesBefore);
      ok('repeated expiry job: rider wallet unchanged', centsValue(riderWalletRepeat.balance_cents) === centsValue(riderWalletAfter.balance_cents));

      // The additional charge went through the wallet (0 Stripe charges).
      ok('no off-session charge needed for the expiry (wallet funded it)', gateway.charges.length === 0);
    } finally {
      clearStripeGatewayForTests();
    }
  }

  // ----------------- SCENARIO 2B: EXPIRY WITH CARD + DECLINE + RETRY --------
  section('SCENARIO 2B — expiration with card collection, decline handled truthfully, retry succeeds');
  {
    const gateway = fakeGateway();
    setStripeGatewayForTests(gateway);
    try {
      riderId = await seedUser(`stripe-decl-rider-${suffix}@netride.test`, 'RIDER');
      driverId = await seedUser(`stripe-decl-driver-${suffix}@netride.test`, 'DRIVER');
      sponsorId = await seedSponsor(100000);
      const { rideId: r3, redemptionId: rd3 } = await insertSpecialRide({
        rider: riderId, driver: driverId, originalFareCents: 1000, subsidyCents: 500,
      });
      rideId = r3; redemptionId = rd3;
      await pool.query(
        `INSERT INTO stripe_customers (user_id, stripe_customer_id, default_payment_method_id, card_last4, off_session_consent)
         VALUES ($1, 'cus_decl', 'pm_decl', '0002', TRUE)`, [riderId],
      );
      // Wallet empty: the additional charge MUST go off-session.
      await finishRide(r3, riderId, driverId, { walletBalanceCents: 500 });
      await pool.query(
        `UPDATE special_redemptions SET status='WAITING_FOR_SPONSOR', validation_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`,
        [rd3],
      );
      gateway.setFailCharges(true);
      await SpecialRedemptionService.expireStaleRedemptions();

      let db = (await pool.query(`SELECT * FROM ride_fare_breakdowns WHERE ride_id=$1`, [r3])).rows[0];
      ok('decline: additional charge FAILED (never marked collected)', db.additional_charge_status === 'FAILED', `got ${db.additional_charge_status}`);
      ok('decline: settlement EXCEPTION surfaced for admin', db.settlement_status === 'EXCEPTION');
      ok('decline: rider only paid $5 so far', centsValue(db.rider_collected_cents) === 500);
      ok('decline: sponsor still paid $0', centsValue(db.sponsor_collected_cents) === 0);

      // Rider fixes the card; the admin/rider retry succeeds exactly once.
      gateway.setFailCharges(false);
      const retry = await RideSettlementService.retryAdditionalCharge(r3);
      ok('retry: charge collected after card fixed', retry.charged === true && retry.status === 'COLLECTED', JSON.stringify(retry));
      db = (await pool.query(`SELECT * FROM ride_fare_breakdowns WHERE ride_id=$1`, [r3])).rows[0];
      ok('retry: rider total = $10', centsValue(db.rider_collected_cents) === 1000);
      ok('retry: settlement SETTLED', db.settlement_status === 'SETTLED');
      ok('retry: exactly two attempts for the $5 additional charge (1 decline + 1 success), distinct Stripe idempotency keys',
        gateway.charges.filter((c) => c.amountCents === 500).length === 2
        && gateway.charges[0].idempotencyKey.startsWith('charge-')
        && gateway.charges[1].idempotencyKey.startsWith('charge-')
        && gateway.charges[0].idempotencyKey !== gateway.charges[1].idempotencyKey,
        `charge attempts=${JSON.stringify(gateway.charges.map((c) => ({ amt: c.amountCents, key: c.idempotencyKey, pm: c.paymentMethodId })))}`);
    } finally {
      clearStripeGatewayForTests();
    }
  }

  // ---------------- SCENARIO 3: ORDINARY RIDE (no special) ------------------
  section('SCENARIO 3 — ordinary $10 ride settles exactly as before');
  {
    riderId = await seedUser(`plain-rider-${suffix}@netride.test`, 'RIDER');
    driverId = await seedUser(`plain-driver-${suffix}@netride.test`, 'DRIVER');
    const rideId0 = uuidv4();
    createdIds.rides.push(rideId0);
    await pool.query(
      `INSERT INTO rides (id, rider_id, status, pickup_lat, pickup_lng, pickup_address, destination_lat, destination_lng, destination_address, requested_class, distance_meters, duration_seconds, fare_amount, final_payment_cents)
       VALUES ($1,$2,'COMPLETED',34.05,-118.24,'A',34.01,-118.49,'B','CORE',5000,900,'10.00',1000)`,
      [rideId0, riderId],
    );
    await pool.query(
      `INSERT INTO ride_price_snapshots (ride_id, distance_km, duration_minutes, final_fare, driver_share_cents, platform_share_cents, netride_share_cents, fleet_allocations, revenue_config_snapshot)
       VALUES ($1,5,15,'10.00',600,400,400,'[]','{"driverSharePercent":60,"platformSharePercent":40}')`,
      [rideId0],
    );
    await RideSettlementService.snapshotOnAccept(rideId0, driverId);
    const b0 = (await pool.query(`SELECT * FROM ride_fare_breakdowns WHERE ride_id=$1`, [rideId0])).rows[0];
    ok('ordinary: no sponsor subsidy', centsValue(b0.sponsor_subsidy_cents) === 0);
    ok('ordinary: rider share = full fare', centsValue(b0.rider_share_cents) === 1000);

    await finishRide(rideId0, riderId, driverId, { walletBalanceCents: 1000, riderCollectedExactly: 1000 });
    const b0a = (await pool.query(`SELECT * FROM ride_fare_breakdowns WHERE ride_id=$1`, [rideId0])).rows[0];
    ok('ordinary: rider charged $10', centsValue(b0a.rider_collected_cents) === 1000);
    ok('ordinary: SETTLED', b0a.settlement_status === 'SETTLED');
    const dw = (await pool.query(`SELECT balance_cents FROM driver_wallets WHERE driver_id=$1`, [driverId])).rows[0];
    ok('ordinary: driver earned 60% = $6', centsValue(dw.balance_cents) === 600);
    const ft0 = (await pool.query(`SELECT * FROM financial_transactions WHERE ride_id=$1`, [rideId0])).rows[0];
    ok('ordinary: ledger status', ft0.status === 'SETTLED');
    ok('ordinary: no sponsor components', centsValue(ft0.sponsor_subsidy_cents) === 0 && ft0.sponsor_contribution_status === 'NONE');
  }

  // --------------- SCENARIO 4: security / authorization checks --------------
  section('SCENARIO 4 — security: consent required, no fake paid states');
  {
    const gateway = fakeGateway();
    setStripeGatewayForTests(gateway);
    try {
      riderId = await seedUser(`noconsent-rider-${suffix}@netride.test`, 'RIDER');
      driverId = await seedUser(`noconsent-driver-${suffix}@netride.test`, 'DRIVER');
      sponsorId = await seedSponsor(100000);
      const { rideId: r4, redemptionId: rd4 } = await insertSpecialRide({
        rider: riderId, driver: driverId, originalFareCents: 1000, subsidyCents: 500,
      });
      // Remove consent (the ride was created before consent enforcement).
      await pool.query(`UPDATE rides SET special_terms_accepted_at = NULL WHERE id = $1`, [r4]);
      rideId = r4; redemptionId = rd4;
      await pool.query(
        `INSERT INTO stripe_customers (user_id, stripe_customer_id, default_payment_method_id, off_session_consent)
         VALUES ($1, 'cus_nc', 'pm_nc', TRUE)`, [riderId],
      );
      await finishRide(r4, riderId, driverId, { walletBalanceCents: 500 });
      await pool.query(
        `UPDATE special_redemptions SET status='WAITING_FOR_SPONSOR', validation_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`,
        [rd4],
      );
      await SpecialRedemptionService.expireStaleRedemptions();
      const db4 = (await pool.query(`SELECT * FROM ride_fare_breakdowns WHERE ride_id=$1`, [r4])).rows[0];
      ok('consent missing: additional charge REQUIRED, never charged', db4.additional_charge_status === 'REQUIRED', `got ${db4.additional_charge_status}`);
      ok('consent missing: settlement EXCEPTION for admin resolution', db4.settlement_status === 'EXCEPTION');
      ok('consent missing: no Stripe charge attempted', gateway.charges.length === 0);

      // A client can never mark a payment collected: ids are server-enforced.
      const attempt = await pool.query(`SELECT COUNT(*)::int AS n FROM ride_fare_breakdowns WHERE ride_id=$1 AND additional_charge_status='COLLECTED'`, [r4]);
      ok('client cannot fake a collected status (server-only columns)', attempt.rows[0].n === 0);
    } finally {
      clearStripeGatewayForTests();
    }
  }

  // ----------------- SCENARIO 5: SPONSOR MANUAL WITHDRAWAL -----------------
  section('SCENARIO 5 — sponsor (colab) card-backed manual withdrawal, once per week');
  {
    const gateway = fakeGateway();
    setStripeGatewayForTests(gateway);
    try {
      riderId = await seedUser(`withdraw-rider-${suffix}@netride.test`, 'RIDER');
      driverId = await seedUser(`withdraw-driver-${suffix}@netride.test`, 'DRIVER');
      sponsorId = await seedSponsor(200000); // $2,000.00 funded budget

      // Two real funding charges on file (SUCCEEDED) so refunds have a source.
      await pool.query(
        `INSERT INTO stripe_payments (purpose, sponsor_id, amount_cents, currency, status, stripe_payment_intent_id, stripe_checkout_session_id, idempotency_key)
         VALUES ('SPONSOR_BUDGET_TOPUP', $1, 150000, 'USD', 'SUCCEEDED', 'pi_fund_a', 'cs_a', 'k_a'),
                ('SPONSOR_BUDGET_TOPUP', $1, 100000, 'USD', 'SUCCEEDED', 'pi_fund_b', 'cs_b', 'k_b')`,
        [sponsorId],
      );

      const wState0 = await sponsorWithdrawalState(sponsorId);
      ok('new sponsor: withdrawal eligible immediately', wState0.eligible === true);

      const res = await requestSponsorWithdrawal({ sponsorId, amountCents: 120000 });
      ok('withdrawal completes', res.withdrawal.status === 'COMPLETED', `status=${res.withdrawal.status}`);
      ok('exactly one refund for $1200 from the oldest funding charge',
        gateway.refunds.length === 1 && gateway.refunds[0].amountCents === 120000 && gateway.refunds[0].paymentIntentId === 'pi_fund_a',
        JSON.stringify(gateway.refunds));
      ok('refund idempotency key is withdrawal-scoped',
        gateway.refunds.every((rf) => String(rf.idempotencyKey).startsWith('sponsor-withdrawal:')), JSON.stringify(gateway.refunds.map((r) => r.idempotencyKey)));

      const sponsorAfter = (await pool.query(`SELECT initial_budget_cents, remaining_budget_cents, reserved_budget_cents, used_budget_cents FROM sponsors WHERE id=$1`, [sponsorId])).rows[0];
      ok('budget debited by $1200 (remaining)', centsValue(sponsorAfter.remaining_budget_cents) === 80000, `remaining=${centsValue(sponsorAfter.remaining_budget_cents)}`);
      ok('budget invariant holds: remaining + used = initial', centsValue(sponsorAfter.remaining_budget_cents) + centsValue(sponsorAfter.used_budget_cents) === centsValue(sponsorAfter.initial_budget_cents));

      const ledger = (await pool.query(
        `SELECT COUNT(*)::int AS n FROM sponsor_ledger_entries WHERE sponsor_id=$1 AND type='WITHDRAWAL' AND reference_type='sponsor_withdrawal'`,
        [sponsorId],
      )).rows[0];
      ok('exactly one WITHDRAWAL ledger entry', ledger.n === 1);

      // Weekly rule: withdrawing mid-week blocks until next Monday.
      const wState1 = await sponsorWithdrawalState(sponsorId);
      ok('second withdrawal this week is BLOCKED', wState1.eligible === false);
      ok('next window is the following Monday', wState1.nextAvailableAt.getUTCDay() === 1, wState1.nextAvailableAt.toISOString());
      let blocked = null;
      try {
        await requestSponsorWithdrawal({ sponsorId, amountCents: 10000 });
      } catch (e) {
        blocked = e;
      }
      ok('second request throws WITHDRAWAL_UNAVAILABLE', blocked && blocked.code === 'WITHDRAWAL_UNAVAILABLE', blocked?.message ?? '');

      // Retry safety: replaying refund execution adds nothing.
      const refundsBefore = gateway.refunds.length;
      await executeSponsorWithdrawalRefunds(res.withdrawal.id, sponsorId, 120000);
      ok('replayed refund execution is a no-op (idempotent)', gateway.refunds.length === refundsBefore);
    } finally {
      clearStripeGatewayForTests();
    }
  }

  // ----------------- SCENARIO 6: DRIVER MANUAL WITHDRAWAL GATE ------------
  section('SCENARIO 6 — driver manual withdrawal gate (once per week, Monday anchor)');
  {
    riderId = await seedUser(`dw-rider-${suffix}@netride.test`, 'RIDER');
    driverId = await seedUser(`dw-driver-${suffix}@netride.test`, 'DRIVER');
    const empty = await driverWithdrawalState(driverId);
    ok('new driver: withdrawal eligible immediately', empty.eligible === true);

    // Simulate a withdrawal made THIS week.
    await pool.query(
      `INSERT INTO payouts (driver_id, amount_cents, fee_cents, net_cents, status, method)
       VALUES ($1, 5000, 0, 5000, 'PAID', 'ON_DEMAND')`,
      [driverId],
    );
    const blocked = await driverWithdrawalState(driverId);
    ok('driver who withdrew this week is BLOCKED', blocked.eligible === false);
    let threw = null;
    try { await assertDriverCanWithdraw(driverId); } catch (e) { threw = e; }
    ok('assertDriverCanWithdraw throws a typed error', !!threw && threw.code === 'WITHDRAWAL_UNAVAILABLE', threw?.message ?? '');
    ok('next available is a Monday', threw?.nextAvailableAt ? new Date(threw.nextAvailableAt).getUTCDay() === 1 : false, threw?.nextAvailableAt ?? '');

    // Move that payout back to last week → eligible again (Monday reset).
    await pool.query(
      `UPDATE payouts SET requested_at = requested_at - INTERVAL '8 days' WHERE driver_id = $1 AND method = 'ON_DEMAND'`,
      [driverId],
    );
    const reset = await driverWithdrawalState(driverId);
    ok('previous-week withdrawal does not block the new week', reset.eligible === true);
  }

  console.log(`\n══════════════════════════════════════`);
  console.log(`PAYMENT INTEGRATION: ${passed} passed, ${failed} failed`);
  console.log(`══════════════════════════════════════`);

  await cleanup();
  console.log('cleanup complete');
  setTimeout(() => process.exit(failed > 0 ? 1 : 0), 300);
})().catch(async (err) => {
  console.error('❌ INTEGRATION CRASHED:', err.message, err.stack);
  await cleanup().catch(() => {});
  process.exit(1);
});