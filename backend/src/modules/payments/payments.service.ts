// backend/src/modules/payments/payments.service.ts
//
// RIDER PAYMENTS + SPONSOR FUNDING (platform-side Stripe collections).
// ---------------------------------------------------------------------------
// The internal rider wallet stays the primary stored-value rail; Stripe is
// the real-money rail behind it:
//   * wallet top-up          → Checkout (mode=payment) → wallet credit
//   * card on file           → Checkout (mode=setup)   → saved PM + consent
//   * fare / additional charge → off-session PaymentIntent on the saved PM
//   * sponsor budget top-up  → Checkout (mode=payment) → sponsor ledger credit
//
// Nothing here is trusted from the client except intent (amounts are
// validated server-side). Local state is only advanced from a verified
// webhook or an explicit server-side reconciliation read of the Stripe
// object — never from a client "success" callback.

import { pool } from '../../config/database';
import { env } from '../../config/env';
import { WalletService } from '../wallet/wallet.service';
import { SponsorService } from '../sponsor/sponsor.service';
import { tryGetStripeGateway, type StripeGateway } from './stripe.gateway';
import { isStripeConfigured, stripeMode } from './stripe.client';
import { isTestEmail } from '../../utils/testUser';

export type StripePaymentPurpose =
  | 'RIDER_WALLET_TOPUP'
  | 'SPONSOR_BUDGET_TOPUP'
  | 'RIDE_CHARGE'
  | 'RIDE_ADDITIONAL_CHARGE';

export const WALLET_TOPUP_MIN_CENTS = 100; // $1.00
export const WALLET_TOPUP_MAX_CENTS = 500_000; // $5,000.00

/** Booking gate: the rider must have a saved card before requesting a ride. */
export class PaymentMethodRequiredError extends Error {
  readonly code = 'PAYMENT_METHOD_REQUIRED';
  constructor() {
    super('Add a payment card to your account before requesting a ride');
  }
}

export interface OffSessionChargeResult {
  ok: boolean;
  reason?: 'no_customer' | 'no_payment_method' | 'consent_required' | 'declined' | 'requires_action' | 'stripe_unavailable' | 'already_exists';
  paymentRowId?: string;
  paymentIntentId?: string | null;
  chargeId?: string | null;
  failureReason?: string | null;
  requiresAction?: boolean;
}

function gatewayOrNull(): StripeGateway | null {
  return tryGetStripeGateway();
}

export class PaymentsService {
  /** Safe, non-secret configuration for authenticated UIs. */
  static config() {
    return {
      configured: isStripeConfigured(),
      mode: stripeMode(),
      publishableKey: env.STRIPE_PUBLISHABLE_KEY ?? null,
      currency: env.STRIPE_CURRENCY,
      walletTopupMinCents: WALLET_TOPUP_MIN_CENTS,
      walletTopupMaxCents: WALLET_TOPUP_MAX_CENTS,
    };
  }

  /**
   * Booking gate: every ride request requires a saved payment card.
   *   * when Stripe is not configured (legacy dev environments) the wallet
   *     rail remains usable — there is no card rail to require;
   *   * seeded TEST accounts (@netride.test etc.) keep the legacy wallet
   *     rail so the sandbox works without cards;
   *   * every other rider must have a Stripe customer with a default
   *     payment method or booking is refused with PAYMENT_METHOD_REQUIRED.
   */
  static async assertRiderPaymentMethod(riderId: string): Promise<void> {
    if (!isStripeConfigured()) return;
    const user = await pool.query(`SELECT email FROM users WHERE id = $1`, [riderId]);
    if (isTestEmail(user.rows[0]?.email)) return;
    const profile = await this.getPaymentProfile(riderId);
    if (!profile.stripeCustomerId || !profile.defaultPaymentMethodId) {
      throw new PaymentMethodRequiredError();
    }
  }

  // -------------------------------------------------------- customers / PM

  /**
   * Maps a local user to a Stripe Customer. Returns null when Stripe is not
   * configured (callers degrade to the legacy wallet-only rail). Idempotent
   * on both the local row and the Stripe idempotency key.
   */
  static async ensureStripeCustomer(
    userId: string,
    opts: { email?: string | null; name?: string | null } = {},
  ): Promise<{ customerId: string } | null> {
    const existing = await pool.query(
      `SELECT stripe_customer_id FROM stripe_customers WHERE user_id = $1`,
      [userId],
    );
    if (existing.rows[0]?.stripe_customer_id) {
      return { customerId: existing.rows[0].stripe_customer_id };
    }
    const gateway = gatewayOrNull();
    if (!gateway) return null;

    let email = opts.email ?? null;
    let name = opts.name ?? null;
    if (!email) {
      const u = await pool.query(`SELECT email, full_name FROM users WHERE id = $1`, [userId]);
      email = u.rows[0]?.email ?? null;
      name = name ?? u.rows[0]?.full_name ?? null;
    }
    if (!email) throw new Error('Cannot create a payment profile without an email address');

    const { customerId } = await gateway.ensureCustomer({ userId, email, name });
    await pool.query(
      `INSERT INTO stripe_customers (user_id, stripe_customer_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId, customerId],
    );
    const row = await pool.query(
      `SELECT stripe_customer_id FROM stripe_customers WHERE user_id = $1`,
      [userId],
    );
    return { customerId: row.rows[0]?.stripe_customer_id ?? customerId };
  }

  static async getPaymentProfile(userId: string): Promise<{
    configured: boolean;
    mode: string;
    stripeCustomerId: string | null;
    defaultPaymentMethodId: string | null;
    card: { brand: string | null; last4: string | null; expMonth: number | null; expYear: number | null } | null;
    offSessionConsent: boolean;
    offSessionConsentAt: Date | null;
  }> {
    const res = await pool.query(
      `SELECT stripe_customer_id, default_payment_method_id, card_brand, card_last4,
              card_exp_month, card_exp_year, off_session_consent, off_session_consent_at
       FROM stripe_customers WHERE user_id = $1`,
      [userId],
    );
    const r = res.rows[0];
    return {
      configured: isStripeConfigured(),
      mode: stripeMode(),
      stripeCustomerId: r?.stripe_customer_id ?? null,
      defaultPaymentMethodId: r?.default_payment_method_id ?? null,
      card: r?.card_last4
        ? { brand: r.card_brand, last4: r.card_last4, expMonth: r.card_exp_month, expYear: r.card_exp_year }
        : null,
      offSessionConsent: r?.off_session_consent === true,
      offSessionConsentAt: r?.off_session_consent_at ?? null,
    };
  }

  static async listPaymentMethods(userId: string) {
    const profile = await this.getPaymentProfile(userId);
    const gateway = gatewayOrNull();
    if (!gateway || !profile.stripeCustomerId) return [];
    const methods = await gateway.listPaymentMethods(profile.stripeCustomerId);
    return methods.map((m) => ({ ...m, isDefault: m.id === profile.defaultPaymentMethodId }));
  }

  static async detachPaymentMethod(userId: string, paymentMethodId: string): Promise<void> {
    const profile = await this.getPaymentProfile(userId);
    if (profile.defaultPaymentMethodId === paymentMethodId) {
      throw new Error('The default payment method cannot be removed while it is in use');
    }
    const gateway = gatewayOrNull();
    if (!gateway) throw new Error('Stripe is not configured');
    if (!profile.stripeCustomerId) throw new Error('No payment profile');
    const methods = await gateway.listPaymentMethods(profile.stripeCustomerId);
    if (!methods.some((m) => m.id === paymentMethodId)) {
      throw new Error('Payment method not found for this account');
    }
    await gateway.detachPaymentMethod(paymentMethodId);
    if (profile.defaultPaymentMethodId === paymentMethodId) {
      await pool.query(
        `UPDATE stripe_customers
         SET default_payment_method_id = NULL, card_brand = NULL, card_last4 = NULL,
             card_exp_month = NULL, card_exp_year = NULL, updated_at = NOW()
         WHERE user_id = $1`,
        [userId],
      );
    }
  }

  /** Changes the default saved card for the authenticated rider. */
  static async setDefaultPaymentMethod(userId: string, paymentMethodId: string): Promise<void> {
    const profile = await this.getPaymentProfile(userId);
    const gateway = gatewayOrNull();
    if (!gateway) throw new Error('Stripe is not configured');
    if (!profile.stripeCustomerId) throw new Error('No payment profile');
    const methods = await gateway.listPaymentMethods(profile.stripeCustomerId);
    const chosen = methods.find((m) => m.id === paymentMethodId);
    if (!chosen) throw new Error('Payment method not found for this account');

    await gateway.setDefaultPaymentMethod(profile.stripeCustomerId, paymentMethodId);
    await pool.query(
      `UPDATE stripe_customers
       SET default_payment_method_id = $2,
           card_brand = $3, card_last4 = $4, card_exp_month = $5, card_exp_year = $6,
           updated_at = NOW()
       WHERE user_id = $1`,
      [userId, paymentMethodId, chosen.brand, chosen.last4, chosen.expMonth, chosen.expYear],
    );
  }

  /**
   * Creates a SetupIntent for the in-app PaymentSheet card-entry flow.
   * Keeps all secrets server-side: the client only receives the
   * client_secret + an ephemeral key scoped to this customer.
   */
  static async createRiderSetupIntent(args: {
    userId: string;
    consent?: boolean;
  }): Promise<{
    setupIntentId: string;
    setupIntentClientSecret: string;
    ephemeralKey: string;
    customerId: string;
    publishableKey: string | null;
    mode: string;
    consentRecorded: boolean;
  }> {
    const gateway = gatewayOrNull();
    if (!gateway) throw new Error('Stripe is not configured');
    const customer = await this.ensureStripeCustomer(args.userId);
    if (!customer) throw new Error('Stripe is not configured');

    const consent = args.consent !== false;
    const si = await gateway.createSetupIntent({
      customerId: customer.customerId,
      // Cards saved here may be charged off-session later (ride fares, the
      // Special additional charge) — Stripe requires usage=off_session to
      // keep them MIT-eligible.
      usage: 'off_session',
      metadata: {
        kind: 'CARD_SETUP',
        user_id: args.userId,
        off_session_consent: consent ? 'true' : 'false',
      },
      idempotencyKey: `rider-setup:${args.userId}:${Date.now()}`,
    });
    if (!si.clientSecret) throw new Error('Stripe did not return a SetupIntent');
    const key = await gateway.createEphemeralKey({ customerId: customer.customerId });

    if (consent) {
      await this.recordOffSessionConsent(args.userId).catch(() => undefined);
    }

    return {
      setupIntentId: si.setupIntentId,
      setupIntentClientSecret: si.clientSecret,
      ephemeralKey: key.keySecret,
      customerId: customer.customerId,
      publishableKey: env.STRIPE_PUBLISHABLE_KEY ?? null,
      mode: stripeMode(),
      consentRecorded: consent,
    };
  }

  /**
   * Server-side confirmation of a completed SetupIntent. Called by the app
   * right after the PaymentSheet succeeds (instant feedback) AND by the
   * verified webhook — both paths are idempotent.
   */
  static async applySetupIntentSucceeded(setupIntentId: string): Promise<{ applied: boolean }> {
    const gateway = gatewayOrNull();
    if (!gateway) return { applied: false };
    const si = await gateway.retrieveSetupIntent(setupIntentId);
    if (si.status !== 'succeeded') return { applied: false };
    await this.applySetupIntentResult(si);
    return { applied: true };
  }

  /**
   * Persists the card + default flag + consent from a succeeded SetupIntent.
   * Shared by the webhook path and the in-app confirmation path.
   */
  static async applySetupIntentResult(si: {
    customerId: string | null;
    paymentMethodId: string | null;
    paymentMethod: { brand: string | null; last4: string | null; expMonth: number | null; expYear: number | null } | null;
  }): Promise<void> {
    const row = await pool.query(
      `SELECT user_id FROM stripe_customers WHERE stripe_customer_id = $1`,
      [si.customerId],
    );
    if (row.rows[0]?.user_id) {
      await pool.query(
        `UPDATE stripe_customers
         SET default_payment_method_id = COALESCE($2, default_payment_method_id),
             card_brand = $3, card_last4 = $4,
             card_exp_month = $5, card_exp_year = $6,
             updated_at = NOW()
         WHERE user_id = $1`,
        [row.rows[0].user_id, si.paymentMethodId, si.paymentMethod?.brand ?? null, si.paymentMethod?.last4 ?? null, si.paymentMethod?.expMonth ?? null, si.paymentMethod?.expYear ?? null],
      );
      return;
    }
    const sponsorRow = await pool.query(
      `SELECT id FROM sponsors WHERE stripe_customer_id = $1`,
      [si.customerId],
    );
    if (sponsorRow.rows[0]?.id) {
      await pool.query(
        `UPDATE sponsors
         SET default_payment_method_id = COALESCE($2, default_payment_method_id),
             card_brand = $3, card_last4 = $4,
             card_exp_month = $5, card_exp_year = $6,
             updated_payment_at = NOW(), updated_at = NOW()
         WHERE stripe_customer_id = $1`,
        [si.customerId, si.paymentMethodId, si.paymentMethod?.brand ?? null, si.paymentMethod?.last4 ?? null, si.paymentMethod?.expMonth ?? null, si.paymentMethod?.expYear ?? null],
      );
    }
  }

  /** Explicit rider consent to conditional off-session charges. */
  static async recordOffSessionConsent(userId: string): Promise<boolean> {
    const res = await pool.query(
      `UPDATE stripe_customers
       SET off_session_consent = TRUE, off_session_consent_at = NOW(), updated_at = NOW()
       WHERE user_id = $1 RETURNING user_id`,
      [userId],
    );
    return res.rows.length > 0;
  }

  // ------------------------------------------------------- checkout sessions

  /** Hosted Stripe Checkout (mode=setup) to save a card without a client SDK. */
  static async createCardSetupSession(args: {
    userId: string;
    successUrl: string;
    cancelUrl: string;
    consent: boolean;
  }): Promise<{ url: string }> {
    const gateway = gatewayOrNull();
    if (!gateway) throw new Error('Stripe is not configured');
    const customer = await this.ensureStripeCustomer(args.userId);
    if (!customer) throw new Error('Stripe is not configured');
    const session = await gateway.createCheckoutSession({
      mode: 'setup',
      customerId: customer.customerId,
      successUrl: args.successUrl,
      cancelUrl: args.cancelUrl,
      productName: 'NetRide saved payment method',
      metadata: {
        kind: 'CARD_SETUP',
        user_id: args.userId,
        off_session_consent: args.consent ? 'true' : 'false',
      },
    });
    if (!session.url) throw new Error('Stripe did not return a setup URL');
    return { url: session.url };
  }

  /** Hosted Stripe Checkout (mode=payment) to top up the rider wallet. */
  static async createWalletTopUpSession(args: {
    userId: string;
    amountCents: number;
    successUrl: string;
    cancelUrl: string;
    idempotencyKey?: string;
  }): Promise<{ url: string; paymentRowId: string }> {
    const amountCents = Math.round(args.amountCents);
    if (!Number.isFinite(amountCents) || amountCents < WALLET_TOPUP_MIN_CENTS || amountCents > WALLET_TOPUP_MAX_CENTS) {
      throw new Error(`Top-up amount must be between $${WALLET_TOPUP_MIN_CENTS / 100} and $${WALLET_TOPUP_MAX_CENTS / 100}`);
    }
    const gateway = gatewayOrNull();
    if (!gateway) throw new Error('Stripe is not configured');
    const customer = await this.ensureStripeCustomer(args.userId);
    if (!customer) throw new Error('Stripe is not configured');

    const idempotencyKey = args.idempotencyKey ?? `wallet-topup:${args.userId}:${Date.now()}`;
    const insert = await pool.query(
      `INSERT INTO stripe_payments
         (purpose, user_id, amount_cents, currency, status, stripe_customer_id, idempotency_key)
       VALUES ('RIDER_WALLET_TOPUP', $1, $2, $3, 'PENDING', $4, $5)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [args.userId, amountCents, env.STRIPE_CURRENCY, customer.customerId, idempotencyKey],
    );
    if (insert.rows.length === 0) {
      const existing = await pool.query(
        `SELECT id, metadata->>'url' AS url, status FROM stripe_payments WHERE idempotency_key = $1`,
        [idempotencyKey],
      );
      const row = existing.rows[0];
      if (row?.url) return { url: row.url, paymentRowId: row.id };
      throw new Error('A top-up with this idempotency key is already being processed');
    }
    const paymentRowId = insert.rows[0].id;

    try {
      const session = await gateway.createCheckoutSession({
        mode: 'payment',
        customerId: customer.customerId,
        successUrl: args.successUrl,
        cancelUrl: args.cancelUrl,
        amountCents,
        currency: env.STRIPE_CURRENCY,
        productName: 'NetRide wallet top-up',
        metadata: { purpose: 'RIDER_WALLET_TOPUP', stripe_payment_id: paymentRowId, user_id: args.userId },
        idempotencyKey: `checkout-${paymentRowId}`,
      });
      await pool.query(
        `UPDATE stripe_payments
         SET stripe_checkout_session_id = $2, metadata = COALESCE(metadata,'{}'::jsonb) || $3::jsonb, updated_at = NOW()
         WHERE id = $1`,
        [paymentRowId, session.id, JSON.stringify({ url: session.url })],
      );
      if (!session.url) throw new Error('Stripe did not return a checkout URL');
      return { url: session.url, paymentRowId };
    } catch (err: any) {
      await pool.query(
        `UPDATE stripe_payments SET status = 'FAILED', failure_reason = $2, updated_at = NOW() WHERE id = $1`,
        [paymentRowId, String(err.message).slice(0, 300)],
      );
      throw err;
    }
  }

  /** Managed card (Stripe Checkout mode=setup) on the sponsor's customer. */
  static async createSponsorCardSetupSession(args: {
    sponsorId: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ url: string }> {
    const gateway = gatewayOrNull();
    if (!gateway) throw new Error('Stripe is not configured');
    const customer = await this.ensureSponsorStripeCustomer(args.sponsorId);
    const session = await gateway.createCheckoutSession({
      mode: 'setup',
      customerId: customer,
      successUrl: args.successUrl,
      cancelUrl: args.cancelUrl,
      productName: 'NetRide sponsor saved payment method',
      metadata: {
        kind: 'SPONSOR_CARD_SETUP',
        sponsor_id: args.sponsorId,
      },
    });
    if (!session.url) throw new Error('Stripe did not return a setup URL');
    return { url: session.url };
  }

  /** Resolves (creating once) the Stripe Customer for a sponsor. */
  static async ensureSponsorStripeCustomer(sponsorId: string): Promise<string> {
    const sponsor = await pool.query(
      `SELECT stripe_customer_id, business_name FROM sponsors WHERE id = $1`,
      [sponsorId],
    );
    const row = sponsor.rows[0];
    if (!row) throw new Error('Sponsor not found');
    if (row.stripe_customer_id) return row.stripe_customer_id;

    const gateway = gatewayOrNull();
    if (!gateway) throw new Error('Stripe is not configured');
    const created = await gateway.ensureCustomer({
      userId: `sponsor:${sponsorId}`,
      email: `sponsor+${sponsorId}@netride.org`,
      name: row.business_name,
    });
    await pool.query(
      `UPDATE sponsors SET stripe_customer_id = $2, updated_at = NOW() WHERE id = $1`,
      [sponsorId, created.customerId],
    );
    return created.customerId;
  }

  // ---------------------------------------------- sponsor in-app card entry

  static async sponsorPaymentProfile(sponsorId: string): Promise<{
    configured: boolean;
    mode: string;
    stripeCustomerId: string | null;
    defaultPaymentMethodId: string | null;
    card: { brand: string | null; last4: string | null; expMonth: number | null; expYear: number | null } | null;
    methods: Array<{ id: string; brand: string | null; last4: string | null; expMonth: number | null; expYear: number | null; isDefault: boolean }>;
  }> {
    const row = await pool.query(
      `SELECT stripe_customer_id, default_payment_method_id, card_brand, card_last4,
              card_exp_month, card_exp_year
       FROM sponsors WHERE id = $1`,
      [sponsorId],
    );
    const r = row.rows[0];
    const gateway = gatewayOrNull();
    let methods: Array<any> = [];
    if (gateway && r?.stripe_customer_id) {
      const list = await gateway.listPaymentMethods(r.stripe_customer_id);
      methods = list.map((m) => ({ ...m, isDefault: m.id === r.default_payment_method_id }));
    }
    return {
      configured: isStripeConfigured(),
      mode: stripeMode(),
      stripeCustomerId: r?.stripe_customer_id ?? null,
      defaultPaymentMethodId: r?.default_payment_method_id ?? null,
      card: r?.card_last4
        ? { brand: r.card_brand, last4: r.card_last4, expMonth: r.card_exp_month, expYear: r.card_exp_year }
        : null,
      methods,
    };
  }

  /** SetupIntent for the in-dashboard Payment Element card-entry flow. */
  static async createSponsorSetupIntent(sponsorId: string): Promise<{
    setupIntentClientSecret: string;
    customerId: string;
    publishableKey: string | null;
    mode: string;
  }> {
    const gateway = gatewayOrNull();
    if (!gateway) throw new Error('Stripe is not configured');
    const customerId = await this.ensureSponsorStripeCustomer(sponsorId);
    const si = await gateway.createSetupIntent({
      customerId,
      usage: 'off_session',
      metadata: {
        kind: 'SPONSOR_CARD_SETUP',
        sponsor_id: sponsorId,
      },
      idempotencyKey: `sponsor-setup:${sponsorId}:${Date.now()}`,
    });
    if (!si.clientSecret) throw new Error('Stripe did not return a SetupIntent');
    return {
      setupIntentClientSecret: si.clientSecret,
      customerId,
      publishableKey: env.STRIPE_PUBLISHABLE_KEY ?? null,
      mode: stripeMode(),
    };
  }

  /** Changes the sponsor's default saved card (used for funding/refunds). */
  static async setSponsorDefaultPaymentMethod(sponsorId: string, paymentMethodId: string): Promise<void> {
    const gateway = gatewayOrNull();
    if (!gateway) throw new Error('Stripe is not configured');
    const row = await pool.query(
      `SELECT stripe_customer_id FROM sponsors WHERE id = $1`,
      [sponsorId],
    );
    const customerId = row.rows[0]?.stripe_customer_id;
    if (!customerId) throw new Error('No payment profile');
    const methods = await gateway.listPaymentMethods(customerId);
    const chosen = methods.find((m) => m.id === paymentMethodId);
    if (!chosen) throw new Error('Payment method not found for this account');

    await gateway.setDefaultPaymentMethod(customerId, paymentMethodId);
    await pool.query(
      `UPDATE sponsors
       SET default_payment_method_id = $2,
           card_brand = $3, card_last4 = $4, card_exp_month = $5, card_exp_year = $6,
           updated_payment_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [sponsorId, paymentMethodId, chosen.brand, chosen.last4, chosen.expMonth, chosen.expYear],
    );
  }

  /** Removes an eligible saved sponsor card (the default may not be removed). */
  static async detachSponsorPaymentMethod(sponsorId: string, paymentMethodId: string): Promise<void> {
    const gateway = gatewayOrNull();
    if (!gateway) throw new Error('Stripe is not configured');
    const row = await pool.query(
      `SELECT stripe_customer_id, default_payment_method_id FROM sponsors WHERE id = $1`,
      [sponsorId],
    );
    const r = row.rows[0];
    if (!r?.stripe_customer_id) throw new Error('No payment profile');
    if (r.default_payment_method_id === paymentMethodId) {
      throw new Error('The default payment method cannot be removed while it is in use');
    }
    const methods = await gateway.listPaymentMethods(r.stripe_customer_id);
    if (!methods.some((m) => m.id === paymentMethodId)) {
      throw new Error('Payment method not found for this account');
    }
    await gateway.detachPaymentMethod(paymentMethodId);
  }

  /**
   * Creates the PaymentIntent behind the in-dashboard "Add funds" flow.
   * The sponsor customer is attached so the card used is a saved/default
   * method; the webhook (`payment_intent.succeeded` + metadata) credits the
   * budget exactly like the existing Checkout flow — nothing is credited
   * from a client callback.
   */
  static async createSponsorFundingIntent(args: {
    sponsorId: string;
    amountCents: number;
    idempotencyKey?: string;
    paymentMethodId?: string | null;
  }): Promise<{ paymentRowId: string; clientSecret: string; paymentIntentId: string }> {
    const amountCents = Math.round(args.amountCents);
    if (!Number.isFinite(amountCents) || amountCents <= 0 || amountCents > 10_000_000) {
      throw new Error('Invalid funding amount');
    }
    const gateway = gatewayOrNull();
    if (!gateway) throw new Error('Stripe is not configured');

    const sponsor = await pool.query(`SELECT id, business_name FROM sponsors WHERE id = $1`, [args.sponsorId]);
    if (sponsor.rows.length === 0) throw new Error('Sponsor not found');
    const customerId = await this.ensureSponsorStripeCustomer(args.sponsorId);

    const idempotencyKey = args.idempotencyKey ?? `sponsor-intent:${args.sponsorId}:${Date.now()}`;
    const insert = await pool.query(
      `INSERT INTO stripe_payments
         (purpose, sponsor_id, amount_cents, currency, status, stripe_customer_id, idempotency_key)
       VALUES ('SPONSOR_BUDGET_TOPUP', $1, $2, $3, 'PENDING', $4, $5)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [args.sponsorId, amountCents, env.STRIPE_CURRENCY, customerId, idempotencyKey],
    );
    if (insert.rows.length === 0) {
      const existing = await pool.query(
        `SELECT id, stripe_payment_intent_id FROM stripe_payments WHERE idempotency_key = $1`,
        [idempotencyKey],
      );
      const row = existing.rows[0];
      if (!row?.stripe_payment_intent_id) throw new Error('A funding payment with this idempotency key is already being processed');
      const intent = await gateway.retrievePaymentIntent(row.stripe_payment_intent_id);
      if (!intent.clientSecret) throw new Error('Funding payment already confirmed');
      return { paymentRowId: row.id, clientSecret: intent.clientSecret, paymentIntentId: row.stripe_payment_intent_id };
    }
    const paymentRowId = insert.rows[0].id;

    try {
      const intent = await gateway.createPaymentIntent({
        customerId,
        paymentMethodId: args.paymentMethodId ?? null,
        amountCents,
        currency: env.STRIPE_CURRENCY,
        description: `Sponsor budget funding — ${sponsor.rows[0].business_name}`,
        metadata: {
          purpose: 'SPONSOR_BUDGET_TOPUP',
          stripe_payment_id: paymentRowId,
          sponsor_id: args.sponsorId,
        },
        idempotencyKey: `sponsor-pi:${paymentRowId}`,
        setupFutureUsage: args.paymentMethodId ? 'off_session' : undefined,
      });
      if (!intent.clientSecret) throw new Error('Stripe did not return a PaymentIntent');
      await pool.query(
        `UPDATE stripe_payments
         SET stripe_payment_intent_id = $2, updated_at = NOW()
         WHERE id = $1`,
        [paymentRowId, intent.paymentIntentId],
      );
      return { paymentRowId, clientSecret: intent.clientSecret, paymentIntentId: intent.paymentIntentId };
    } catch (err: any) {
      await pool.query(
        `UPDATE stripe_payments SET status = 'FAILED', failure_reason = $2, updated_at = NOW() WHERE id = $1`,
        [paymentRowId, String(err.message).slice(0, 300)],
      );
      throw err;
    }
  }

  /**
   * Reconciles a sponsor funding PaymentIntent after the Elements flow
   * confirms it in-browser (webhook remains the source of truth; this adds
   * instant feedback and covers webhook-delivery gaps in dev/test).
   */
  static async reconcileSponsorFundingIntent(paymentRowId: string, paymentIntentId: string | null): Promise<{ status: string }> {
    const gateway = gatewayOrNull();
    if (!gateway) return { status: 'unknown' };
    if (!paymentIntentId) return { status: 'unknown' };
    const intent = await gateway.retrievePaymentIntent(paymentIntentId);
    if (intent.status === 'succeeded') {
      await this.applySponsorBudgetTopup({ stripePaymentId: paymentRowId, paymentIntentId });
      return { status: 'SUCCEEDED' };
    }
    if (['requires_payment_method', 'canceled'].includes(intent.status)) {
      await pool.query(
        `UPDATE stripe_payments SET status = 'FAILED', failure_reason = $2, updated_at = NOW()
         WHERE id = $1 AND status NOT IN ('SUCCEEDED','REFUNDED')`,
        [paymentRowId, intent.lastPaymentError ?? intent.status],
      );
      return { status: 'FAILED' };
    }
    return { status: intent.status };
  }

  /** Stripe Checkout (mode=payment) funding a sponsor's prepaid budget. */
  static async createSponsorTopUpSession(args: {
    sponsorId: string;
    amountCents: number;
    successUrl: string;
    cancelUrl: string;
    createdByUserId?: string | null;
    idempotencyKey?: string;
  }): Promise<{ url: string; paymentRowId: string }> {
    const amountCents = Math.round(args.amountCents);
    if (!Number.isFinite(amountCents) || amountCents <= 0 || amountCents > 10_000_000) {
      throw new Error('Invalid funding amount');
    }
    const gateway = gatewayOrNull();
    if (!gateway) throw new Error('Stripe is not configured');

    const sponsor = await pool.query(`SELECT id, business_name, status FROM sponsors WHERE id = $1`, [args.sponsorId]);
    if (sponsor.rows.length === 0) throw new Error('Sponsor not found');

    const idempotencyKey = args.idempotencyKey ?? `sponsor-topup:${args.sponsorId}:${Date.now()}`;
    // Sponsors are not NetRide user accounts: create/dedupe their Stripe
    // Customer (cached on the sponsor row for repeat fundings and the
    // managed card).
    const platformCustomer = await this.ensureSponsorStripeCustomer(args.sponsorId);
    if (!platformCustomer) throw new Error('Stripe is not configured');

    const insert = await pool.query(
      `INSERT INTO stripe_payments
         (purpose, sponsor_id, amount_cents, currency, status, stripe_customer_id, idempotency_key)
       VALUES ('SPONSOR_BUDGET_TOPUP', $1, $2, $3, 'PENDING', $4, $5)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [args.sponsorId, amountCents, env.STRIPE_CURRENCY, platformCustomer, idempotencyKey],
    );
    if (insert.rows.length === 0) {
      const existing = await pool.query(
        `SELECT id, metadata->>'url' AS url FROM stripe_payments WHERE idempotency_key = $1`,
        [idempotencyKey],
      );
      if (existing.rows[0]?.url) return { url: existing.rows[0].url, paymentRowId: existing.rows[0].id };
      throw new Error('A funding payment with this idempotency key is already being processed');
    }
    const paymentRowId = insert.rows[0].id;

    try {
      const session = await gateway.createCheckoutSession({
        mode: 'payment',
        customerId: platformCustomer,
        successUrl: args.successUrl,
        cancelUrl: args.cancelUrl,
        amountCents,
        currency: env.STRIPE_CURRENCY,
        productName: `Sponsor budget funding — ${sponsor.rows[0].business_name}`,
        metadata: { purpose: 'SPONSOR_BUDGET_TOPUP', stripe_payment_id: paymentRowId, sponsor_id: args.sponsorId },
        idempotencyKey: `checkout-${paymentRowId}`,
      });
      await pool.query(
        `UPDATE stripe_payments
         SET stripe_checkout_session_id = $2, metadata = COALESCE(metadata,'{}'::jsonb) || $3::jsonb, updated_at = NOW()
         WHERE id = $1`,
        [paymentRowId, session.id, JSON.stringify({ url: session.url })],
      );
      if (!session.url) throw new Error('Stripe did not return a checkout URL');
      return { url: session.url, paymentRowId };
    } catch (err: any) {
      await pool.query(
        `UPDATE stripe_payments SET status = 'FAILED', failure_reason = $2, updated_at = NOW() WHERE id = $1`,
        [paymentRowId, String(err.message).slice(0, 300)],
      );
      throw err;
    }
  }

  // ------------------------------------------------------- off-session charge

  /**
   * Charges the rider's saved card off-session (MIT). Enforces explicit
   * consent for the no-show additional charge. Returns a structured result;
   * declines are recorded truthfully and never reported as success.
   */
  static async chargeRiderOffSession(args: {
    riderId: string;
    amountCents: number;
    purpose: 'RIDE_CHARGE' | 'RIDE_ADDITIONAL_CHARGE';
    rideId?: string | null;
    description?: string;
    idempotencyKey: string;
    requireConsent?: boolean;
  }): Promise<OffSessionChargeResult> {
    const amountCents = Math.round(args.amountCents);
    if (amountCents <= 0) return { ok: false, reason: 'declined', failureReason: 'Non-positive charge amount' };

    const gateway = gatewayOrNull();
    if (!gateway) return { ok: false, reason: 'stripe_unavailable' };

    const profile = await this.getPaymentProfile(args.riderId);
    if (!profile.stripeCustomerId) return { ok: false, reason: 'no_customer' };
    if (args.requireConsent && !profile.offSessionConsent) {
      // Fall back to the per-ride consent record; the customer-level consent
      // flag is the durable proof but legacy rides may only carry the ride
      // timestamp.
      if (args.rideId) {
        const rideConsent = await pool.query(
          `SELECT special_terms_accepted_at FROM rides WHERE id = $1`,
          [args.rideId],
        );
        if (!rideConsent.rows[0]?.special_terms_accepted_at) {
          return { ok: false, reason: 'consent_required' };
        }
      } else {
        return { ok: false, reason: 'consent_required' };
      }
    }

    // Local idempotency: a repeated request replays the existing row and
    // never creates a second PaymentIntent.
    const claimed = await pool.query(
      `INSERT INTO stripe_payments
         (purpose, user_id, ride_id, amount_cents, currency, status,
          stripe_customer_id, idempotency_key, metadata)
       VALUES ($1, $2, $3, $4, $5, 'PENDING', $6, $7, $8::jsonb)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [
        args.purpose,
        args.riderId,
        args.rideId ?? null,
        amountCents,
        env.STRIPE_CURRENCY,
        profile.stripeCustomerId,
        args.idempotencyKey,
        JSON.stringify({ description: args.description ?? null }),
      ],
    );
    if (claimed.rows.length === 0) {
      const existing = await pool.query(
        `SELECT id, status, stripe_payment_intent_id, failure_reason FROM stripe_payments WHERE idempotency_key = $1`,
        [args.idempotencyKey],
      );
      const row = existing.rows[0];
      return {
        ok: row?.status === 'SUCCEEDED',
        reason: row?.status === 'SUCCEEDED' ? 'already_exists' : 'declined',
        paymentRowId: row?.id,
        paymentIntentId: row?.stripe_payment_intent_id ?? null,
        failureReason: row?.failure_reason ?? null,
      };
    }
    const paymentRowId = claimed.rows[0].id;

    try {
      const result = await gateway.createOffSessionCharge({
        customerId: profile.stripeCustomerId,
        paymentMethodId: profile.defaultPaymentMethodId,
        amountCents,
        currency: env.STRIPE_CURRENCY,
        description: args.description,
        metadata: {
          purpose: args.purpose,
          stripe_payment_id: paymentRowId,
          ride_id: args.rideId ?? '',
          rider_id: args.riderId,
        },
        idempotencyKey: `charge-${paymentRowId}`,
      });

      const status = result.status === 'succeeded' ? 'SUCCEEDED'
        : result.requiresAction ? 'REQUIRES_ACTION'
        : 'FAILED';
      await pool.query(
        `UPDATE stripe_payments
         SET status = $2, stripe_payment_intent_id = $3, stripe_charge_id = $4,
             failure_reason = $5, succeeded_at = CASE WHEN $2 = 'SUCCEEDED' THEN NOW() ELSE succeeded_at END,
             updated_at = NOW()
         WHERE id = $1`,
        [paymentRowId, status, result.paymentIntentId, result.chargeId, result.failureReason],
      );

      if (status === 'SUCCEEDED') {
        void this.recordPaymentFee(paymentRowId, result.chargeId).catch(() => undefined);
      }

      return {
        ok: status === 'SUCCEEDED',
        reason: status === 'SUCCEEDED' ? undefined : result.requiresAction ? 'requires_action' : 'declined',
        paymentRowId,
        paymentIntentId: result.paymentIntentId,
        chargeId: result.chargeId,
        failureReason: result.failureReason,
        requiresAction: result.requiresAction,
      };
    } catch (err: any) {
      const pi: any = err?.payment_intent;
      const status = pi?.status === 'requires_action' ? 'REQUIRES_ACTION' : 'FAILED';
      await pool.query(
        `UPDATE stripe_payments
         SET status = $2, stripe_payment_intent_id = $3, failure_reason = $4, updated_at = NOW()
         WHERE id = $1`,
        [paymentRowId, status, pi?.id ?? null, String(err?.message ?? 'charge failed').slice(0, 300)],
      );
      return {
        ok: false,
        reason: status === 'REQUIRES_ACTION' ? 'requires_action' : 'declined',
        paymentRowId,
        paymentIntentId: pi?.id ?? null,
        failureReason: err?.message ?? 'charge failed',
        requiresAction: status === 'REQUIRES_ACTION',
      };
    }
  }

  /** Best-effort processing-fee capture for reconciliation (never blocks). */
  private static async recordPaymentFee(stripePaymentId: string, chargeId: string | null): Promise<void> {
    if (!chargeId) return;
    const gateway = gatewayOrNull();
    if (!gateway) return;
    const charge = await gateway.retrieveCharge(chargeId);
    if (!charge.balanceTransactionId) return;
    const bt = await gateway.retrieveBalanceTransaction(charge.balanceTransactionId);
    await pool.query(
      `UPDATE stripe_payments SET stripe_fee_cents = $2, updated_at = NOW() WHERE id = $1`,
      [stripePaymentId, bt.feeCents],
    );
  }

  // ------------------------------------------------------------ refunds

  /** Refund (or partially refund) a collected payment. Idempotent per call. */
  static async refundPayment(args: {
    stripePaymentId: string;
    amountCents?: number;
    reason?: string;
    idempotencyKey?: string;
  }): Promise<{ ok: boolean; refundId?: string; status?: string | null; reason?: string }> {
    const gateway = gatewayOrNull();
    if (!gateway) return { ok: false, reason: 'stripe_unavailable' };

    const res = await pool.query(`SELECT * FROM stripe_payments WHERE id = $1`, [args.stripePaymentId]);
    const row = res.rows[0];
    if (!row) return { ok: false, reason: 'not_found' };
    if (!row.stripe_payment_intent_id) return { ok: false, reason: 'no_payment_intent' };
    if (row.status !== 'SUCCEEDED') return { ok: false, reason: 'not_collected' };

    const idempotencyKey = args.idempotencyKey ?? `refund:${args.stripePaymentId}`;
    const refund = await gateway.createRefund({
      paymentIntentId: row.stripe_payment_intent_id,
      amountCents: args.amountCents,
      reason: args.reason,
      idempotencyKey,
    });
    await pool.query(
      `UPDATE stripe_payments SET status = 'REFUNDED', updated_at = NOW() WHERE id = $1`,
      [args.stripePaymentId],
    );
    return { ok: true, refundId: refund.refundId, status: refund.status };
  }

  // ------------------------------------------------ webhook state application

  /**
   * Applies a completed Checkout Session. Never trusts the client redirect —
   * this runs from verified webhooks (or explicit reconciliation).
   */
  static async applyCheckoutSessionCompleted(session: {
    id: string;
    mode: string | null;
    paymentIntentId: string | null;
    setupIntentId: string | null;
    metadata: Record<string, string>;
    amountTotalCents: number;
  }): Promise<void> {
    const gateway = gatewayOrNull();
    if (!gateway) return;

    if (session.mode === 'setup') {
      const metadata = session.metadata ?? {};
      if (metadata.kind === 'SPONSOR_CARD_SETUP') {
        if (metadata.sponsor_id && session.setupIntentId) {
          const si = await gateway.retrieveSetupIntent(session.setupIntentId);
          if (si.status === 'succeeded') {
            const card = si.paymentMethod;
            await pool.query(
              `UPDATE sponsors
               SET stripe_customer_id = COALESCE($2, stripe_customer_id),
                   default_payment_method_id = $3,
                   card_brand = $4, card_last4 = $5,
                   card_exp_month = $6, card_exp_year = $7,
                   updated_payment_at = NOW(), updated_at = NOW()
               WHERE id = $1`,
              [metadata.sponsor_id, si.customerId, si.paymentMethodId, card?.brand ?? null, card?.last4 ?? null, card?.expMonth ?? null, card?.expYear ?? null],
            );
          }
        }
        return;
      }
      if (metadata.kind !== 'CARD_SETUP' || !metadata.user_id) return;
      if (!session.setupIntentId) return;
      const si = await gateway.retrieveSetupIntent(session.setupIntentId);
      if (si.status !== 'succeeded') return;
      const consent = metadata.off_session_consent === 'true';
      const card = si.paymentMethod;
      await pool.query(
        `UPDATE stripe_customers
         SET default_payment_method_id = $2,
             card_brand = $3, card_last4 = $4, card_exp_month = $5, card_exp_year = $6,
             off_session_consent = CASE WHEN $7 THEN TRUE ELSE off_session_consent END,
             off_session_consent_at = CASE WHEN $7 THEN NOW() ELSE off_session_consent_at END,
             updated_at = NOW()
         WHERE user_id = $1`,
        [metadata.user_id, si.paymentMethodId, card?.brand ?? null, card?.last4 ?? null, card?.expMonth ?? null, card?.expYear ?? null, consent],
      );
      return;
    }

    if (session.mode === 'payment') {
      const metadata = session.metadata ?? {};
      const paymentRowId = metadata.stripe_payment_id;
      if (!paymentRowId) return;
      if (metadata.purpose === 'RIDER_WALLET_TOPUP') {
        await this.applyRiderWalletTopup({
          stripePaymentId: paymentRowId,
          paymentIntentId: session.paymentIntentId,
        });
      } else if (metadata.purpose === 'SPONSOR_BUDGET_TOPUP') {
        await this.applySponsorBudgetTopup({
          stripePaymentId: paymentRowId,
          paymentIntentId: session.paymentIntentId,
        });
      }
    }
  }

  /** Credits the rider wallet once, idempotently (webhook-safe). */
  static async applyRiderWalletTopup(args: {
    stripePaymentId: string;
    paymentIntentId: string | null;
  }): Promise<{ credited: boolean; amountCents: number }> {
    // The claim tolerates a row already flipped to SUCCEEDED by an earlier
    // webhook delivery as long as it was never credited (ledger/wallet ref
    // missing): the webhook's generic status update and this credit path can
    // legitimately interleave, and the idempotent post() below guarantees
    // only one wallet credit per row no matter how many times this runs.
    const claim = await pool.query(
      `UPDATE stripe_payments
       SET status = 'PROCESSING', stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, $2), updated_at = NOW()
       WHERE id = $1 AND purpose = 'RIDER_WALLET_TOPUP'
         AND (status IN ('PENDING','REQUIRES_ACTION','FAILED')
              OR (status = 'SUCCEEDED' AND NOT EXISTS (
                    SELECT 1 FROM wallet_transactions wt
                    WHERE wt.idempotency_key = 'wallet-topup:' || stripe_payments.id)))
       RETURNING id, user_id, amount_cents`,
      [args.stripePaymentId, args.paymentIntentId],
    );
    if (claim.rows.length === 0) {
      const row = await pool.query(`SELECT amount_cents FROM stripe_payments WHERE id = $1`, [args.stripePaymentId]);
      return { credited: false, amountCents: Number(row.rows[0]?.amount_cents ?? 0) };
    }
    const row = claim.rows[0];

    await WalletService.post(row.user_id, Number(row.amount_cents), 'WALLET_TOPUP', {
      idempotencyKey: `wallet-topup:${row.id}`,
      description: 'Wallet top-up via Stripe',
      referenceType: 'stripe_payment',
      referenceId: row.id,
      stripePaymentIntentId: args.paymentIntentId ?? undefined,
    });

    await pool.query(
      `UPDATE stripe_payments SET status = 'SUCCEEDED', succeeded_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [row.id],
    );
    if (args.paymentIntentId) {
      const intent = await gatewayOrNull()?.retrievePaymentIntent(args.paymentIntentId).catch(() => null);
      if (intent?.chargeId) {
        void this.recordPaymentFee(row.id, intent.chargeId).catch(() => undefined);
      }
    }
    return { credited: true, amountCents: Number(row.amount_cents) };
  }

  /** Credits the sponsor's prepaid budget once, idempotently (webhook-safe). */
  static async applySponsorBudgetTopup(args: {
    stripePaymentId: string;
    paymentIntentId: string | null;
  }): Promise<{ credited: boolean; amountCents: number }> {
    // Same claim tolerance as applyRiderWalletTopup: a webhook may have
    // flipped the row to SUCCEEDED before this credit path ran; the ledger
    // idempotency key guarantees a single budget credit per payment.
    const claim = await pool.query(
      `UPDATE stripe_payments
       SET status = 'PROCESSING', stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, $2), updated_at = NOW()
       WHERE id = $1 AND purpose = 'SPONSOR_BUDGET_TOPUP'
         AND (status IN ('PENDING','REQUIRES_ACTION','FAILED')
              OR (status = 'SUCCEEDED' AND ledger_entry_id IS NULL))
       RETURNING id, sponsor_id, amount_cents`,
      [args.stripePaymentId, args.paymentIntentId],
    );
    if (claim.rows.length === 0) {
      const row = await pool.query(`SELECT amount_cents FROM stripe_payments WHERE id = $1`, [args.stripePaymentId]);
      return { credited: false, amountCents: Number(row.rows[0]?.amount_cents ?? 0) };
    }
    const row = claim.rows[0];
    const amountCents = Number(row.amount_cents);

    const ledgerEntryId = await SponsorService.creditFundedBudget(row.sponsor_id, amountCents, {
      reason: 'Stripe budget funding',
      referenceType: 'stripe_payment',
      referenceId: row.id,
      idempotencyKey: `sponsor-funding:${row.id}`,
      actorRole: 'SPONSOR',
    });

    await pool.query(
      `UPDATE stripe_payments
       SET status = 'SUCCEEDED', ledger_entry_id = $2, succeeded_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [row.id, ledgerEntryId],
    );
    if (args.paymentIntentId) {
      const intent = await gatewayOrNull()?.retrievePaymentIntent(args.paymentIntentId).catch(() => null);
      if (intent?.chargeId) {
        void this.recordPaymentFee(row.id, intent.chargeId).catch(() => undefined);
      }
    }
    return { credited: true, amountCents };
  }

  /**
   * Reconciles one local stripe_payments row against the Stripe API. Used by
   * the admin reconciliation view for rows stuck in PENDING/PROCESSING.
   */
  static async reconcilePayment(stripePaymentId: string): Promise<{ status: string; applied: boolean }> {
    const gateway = gatewayOrNull();
    const res = await pool.query(`SELECT * FROM stripe_payments WHERE id = $1`, [stripePaymentId]);
    const row = res.rows[0];
    if (!row) throw new Error('Payment record not found');
    if (!gateway) return { status: row.status, applied: false };
    if (row.status === 'SUCCEEDED' || row.status === 'REFUNDED') return { status: row.status, applied: false };

    let intentId = row.stripe_payment_intent_id;
    if (!intentId && row.stripe_checkout_session_id) {
      const session = await gateway.retrieveCheckoutSession(row.stripe_checkout_session_id);
      if (session.mode === 'payment' && session.paymentStatus === 'paid') {
        await this.applyCheckoutSessionCompleted(session);
        return { status: 'SUCCEEDED', applied: true };
      }
      intentId = session.paymentIntentId;
    }
    if (!intentId) return { status: row.status, applied: false };

    const intent = await gateway.retrievePaymentIntent(intentId);
    if (intent.status === 'succeeded') {
      if (row.purpose === 'RIDER_WALLET_TOPUP') {
        await this.applyRiderWalletTopup({ stripePaymentId: row.id, paymentIntentId: intentId });
      } else if (row.purpose === 'SPONSOR_BUDGET_TOPUP') {
        await this.applySponsorBudgetTopup({ stripePaymentId: row.id, paymentIntentId: intentId });
      } else {
        await pool.query(
          `UPDATE stripe_payments SET status = 'SUCCEEDED', stripe_charge_id = $3, succeeded_at = NOW(), updated_at = NOW()
           WHERE id = $1 AND status <> 'SUCCEEDED'`,
          [row.id, intentId, intent.chargeId],
        );
      }
      return { status: 'SUCCEEDED', applied: true };
    }
    if (['requires_payment_method', 'canceled'].includes(intent.status)) {
      await pool.query(
        `UPDATE stripe_payments SET status = 'FAILED', failure_reason = $2, updated_at = NOW()
         WHERE id = $1 AND status NOT IN ('SUCCEEDED','REFUNDED')`,
        [row.id, intent.lastPaymentError ?? intent.status],
      );
      return { status: 'FAILED', applied: true };
    }
    return { status: row.status, applied: false };
  }

  /** Marks a charge payment row canceled (e.g. PI canceled after ride cancel). */
  static async markPaymentCanceled(stripePaymentId: string, reason: string): Promise<void> {
    await pool.query(
      `UPDATE stripe_payments SET status = 'CANCELED', failure_reason = $2, updated_at = NOW()
       WHERE id = $1 AND status NOT IN ('SUCCEEDED','REFUNDED')`,
      [stripePaymentId, reason.slice(0, 300)],
    );
  }
}
