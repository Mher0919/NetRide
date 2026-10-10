// backend/src/modules/payments/stripe.gateway.ts
//
// Narrow, testable boundary around the Stripe SDK.
// ---------------------------------------------------------------------------
// Services depend on this interface, never on the SDK directly, so:
//   * unit/integration tests can inject a fake gateway
//     (`setStripeGatewayForTests`) without network or credentials;
//   * the production adapter is the only place Stripe object shapes are read;
//   * the test override is impossible to install when NODE_ENV=production.
//
// All amounts crossing this boundary are integer minor units (cents).

import type Stripe from 'stripe';
import { env } from '../../config/env';
import { getStripe } from './stripe.client';

export interface StripeWebhookEvent {
  id: string;
  type: string;
  data: { object: Record<string, any> };
}

export interface StripeSavedCard {
  id: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
}

export interface StripeCheckoutSession {
  id: string;
  status: string | null;
  paymentStatus: string | null;
  mode: string | null;
  paymentIntentId: string | null;
  setupIntentId: string | null;
  customerId: string | null;
  amountTotalCents: number;
  metadata: Record<string, string>;
}

export interface StripeGateway {
  ensureCustomer(params: { userId: string; email: string; name?: string | null }): Promise<{ customerId: string }>;

  createCheckoutSession(params: {
    mode: 'setup' | 'payment';
    customerId: string;
    successUrl: string;
    cancelUrl: string;
    amountCents?: number;
    currency?: string;
    productName?: string;
    metadata?: Record<string, string>;
    idempotencyKey?: string;
  }): Promise<{ id: string; url: string | null }>;

  retrieveCheckoutSession(id: string): Promise<StripeCheckoutSession>;

  retrieveSetupIntent(id: string): Promise<{
    id: string;
    status: string;
    customerId: string | null;
    paymentMethodId: string | null;
    paymentMethod: StripeSavedCard | null;
    clientSecret: string | null;
  }>;

  /** Creates a SetupIntent for the in-app card-entry surfaces. */
  createSetupIntent(params: {
    customerId: string;
    usage?: 'on_session' | 'off_session';
    metadata?: Record<string, string>;
    idempotencyKey?: string;
  }): Promise<{ setupIntentId: string; clientSecret: string | null; status: string }>;

  /** Ephemeral key for mobile PaymentSheet access to a customer's PMs. */
  createEphemeralKey(params: { customerId: string }): Promise<{ keySecret: string }>;

  /** Points the customer's Stripe-level default payment method. */
  setDefaultPaymentMethod(customerId: string, paymentMethodId: string): Promise<void>;

  /** Off-session payment aimed at a customer's saved default method. */
  createPaymentIntent(params: {
    customerId: string;
    paymentMethodId?: string | null;
    amountCents: number;
    currency: string;
    description?: string;
    metadata?: Record<string, string>;
    idempotencyKey?: string;
    offSession?: boolean;
    setupFutureUsage?: 'on_session' | 'off_session';
    confirm?: boolean;
  }): Promise<{
    paymentIntentId: string;
    clientSecret: string | null;
    status: string;
    chargeId: string | null;
    failureReason: string | null;
    requiresAction: boolean;
  }>;

  retrievePaymentIntent(id: string): Promise<{
    id: string;
    status: string;
    amountCents: number;
    amountReceivedCents: number;
    chargeId: string | null;
    customerId: string | null;
    paymentMethodId: string | null;
    metadata: Record<string, string>;
    lastPaymentError: string | null;
    clientSecret: string | null;
  }>;

  createOffSessionCharge(params: {
    customerId: string;
    paymentMethodId: string | null;
    amountCents: number;
    currency: string;
    description?: string;
    metadata?: Record<string, string>;
    idempotencyKey?: string;
  }): Promise<{
    paymentIntentId: string;
    status: string;
    chargeId: string | null;
    failureReason: string | null;
    requiresAction: boolean;
  }>;

  createRefund(params: {
    paymentIntentId: string;
    amountCents?: number;
    reason?: string;
    idempotencyKey?: string;
  }): Promise<{ refundId: string; status: string | null }>;

  createExpressAccount(params: { driverId: string; email?: string | null; country?: string }): Promise<{ accountId: string }>;

  createAccountLink(params: { accountId: string; refreshUrl: string; returnUrl: string }): Promise<{ url: string; expiresAt: number | null }>;

  retrieveAccount(id: string): Promise<{
    accountId: string;
    detailsSubmitted: boolean;
    payoutsEnabled: boolean;
    chargesEnabled: boolean;
    requirementsDue: string[];
    disabledReason: string | null;
  }>;

  createTransfer(params: {
    amountCents: number;
    currency: string;
    destination: string;
    description?: string;
    metadata?: Record<string, string>;
    idempotencyKey?: string;
  }): Promise<{ transferId: string }>;

  retrieveBalanceTransaction(id: string): Promise<{ feeCents: number; netCents: number; currency: string }>;

  retrieveCharge(id: string): Promise<{ id: string; balanceTransactionId: string | null; refundedAmountCents: number; amountCents: number }>;

  retrievePaymentMethod(id: string): Promise<StripeSavedCard>;

  listPaymentMethods(customerId: string): Promise<StripeSavedCard[]>;

  detachPaymentMethod(id: string): Promise<void>;

  constructWebhookEvent(rawBody: Buffer, signature: string): StripeWebhookEvent;
}

// ---------------------------------------------------------------------------
// Real adapter
// ---------------------------------------------------------------------------

function cardFromPaymentMethod(pm: any): StripeSavedCard | null {
  if (!pm || typeof pm === 'string') return null;
  return {
    id: pm.id,
    brand: pm.card?.brand ?? null,
    last4: pm.card?.last4 ?? null,
    expMonth: pm.card?.exp_month ?? null,
    expYear: pm.card?.exp_year ?? null,
  };
}

const realGateway: StripeGateway = {
  async ensureCustomer({ userId, email, name }) {
    const stripe = getStripe();
    const customer = await stripe.customers.create(
      { email, name: name ?? undefined, metadata: { netride_user_id: userId } },
      { idempotencyKey: `netride-customer:${userId}` },
    );
    return { customerId: customer.id };
  },

  async createCheckoutSession(params) {
    const stripe = getStripe();
    const metadata = params.metadata ?? {};
    const session = await stripe.checkout.sessions.create(
      {
        mode: params.mode as any,
        customer: params.customerId,
        success_url: params.successUrl,
        cancel_url: params.cancelUrl,
        metadata,
        ...(params.mode === 'payment'
          ? {
              line_items: [
                {
                  quantity: 1,
                  price_data: {
                    currency: params.currency ?? env.STRIPE_CURRENCY,
                    unit_amount: params.amountCents,
                    product_data: { name: params.productName ?? 'NetRide payment' },
                  },
                },
              ],
              payment_intent_data: { metadata },
            }
          : {
              setup_intent_data: { metadata },
            }),
      },
      params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : undefined,
    );
    return { id: session.id, url: session.url ?? null };
  },

  async retrieveCheckoutSession(id) {
    const stripe = getStripe();
    const s: any = await stripe.checkout.sessions.retrieve(id, {
      expand: ['payment_intent', 'setup_intent'],
    });
    return {
      id: s.id,
      status: s.status ?? null,
      paymentStatus: s.payment_status ?? null,
      mode: s.mode ?? null,
      paymentIntentId: typeof s.payment_intent === 'string' ? s.payment_intent : s.payment_intent?.id ?? null,
      setupIntentId: typeof s.setup_intent === 'string' ? s.setup_intent : s.setup_intent?.id ?? null,
      customerId: typeof s.customer === 'string' ? s.customer : s.customer?.id ?? null,
      amountTotalCents: s.amount_total ?? 0,
      metadata: s.metadata ?? {},
    };
  },

  async retrieveSetupIntent(id) {
    const stripe = getStripe();
    const si: any = await stripe.setupIntents.retrieve(id, { expand: ['payment_method'] });
    return {
      id: si.id,
      status: si.status,
      customerId: typeof si.customer === 'string' ? si.customer : si.customer?.id ?? null,
      paymentMethodId: typeof si.payment_method === 'string' ? si.payment_method : si.payment_method?.id ?? null,
      paymentMethod: cardFromPaymentMethod(si.payment_method),
      clientSecret: si.client_secret ?? null,
    };
  },

  async createSetupIntent({ customerId, usage, metadata, idempotencyKey }) {
    const stripe = getStripe();
    const params: any = {
      customer: customerId,
      usage: usage ?? 'off_session',
      metadata,
      // Card-only entry, in-app: never hand the customer off to a
      // redirect-based payment method.
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
    };
    const si: any = await stripe.setupIntents.create(
      params,
      idempotencyKey ? { idempotencyKey } : undefined,
    );
    return { setupIntentId: si.id, clientSecret: si.client_secret ?? null, status: si.status };
  },

  async createEphemeralKey({ customerId }) {
    const stripe = getStripe();
    const key: any = await stripe.ephemeralKeys.create(
      { customer: customerId },
      // Must be pinned to the same API version the SDK was built with,
      // otherwise object shapes drift between the backend and the app.
      { apiVersion: '2026-09-30.endive' as Stripe.LatestApiVersion },
    );
    return { keySecret: key.secret };
  },

  async setDefaultPaymentMethod(customerId, paymentMethodId) {
    const stripe = getStripe();
    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });
  },

  async createPaymentIntent(params) {
    const stripe = getStripe();
    const pi: any = await stripe.paymentIntents.create(
      {
        amount: params.amountCents,
        currency: params.currency,
        customer: params.customerId,
        ...(params.paymentMethodId ? { payment_method: params.paymentMethodId } : {}),
        off_session: params.offSession === true ? true : undefined,
        confirm: params.confirm === true,
        capture_method: 'automatic',
        description: params.description,
        metadata: params.metadata,
        setup_future_usage: params.setupFutureUsage ?? undefined,
        automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      },
      params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : undefined,
    );
    return {
      paymentIntentId: pi.id,
      clientSecret: pi.client_secret ?? null,
      status: pi.status,
      chargeId: typeof pi.latest_charge === 'string' ? pi.latest_charge : pi.latest_charge?.id ?? null,
      failureReason: pi.last_payment_error?.message ?? null,
      requiresAction: pi.status === 'requires_action' || pi.status === 'requires_confirmation',
    };
  },

  async retrievePaymentIntent(id) {
    const stripe = getStripe();
    const pi: any = await stripe.paymentIntents.retrieve(id);
    return {
      id: pi.id,
      status: pi.status,
      amountCents: pi.amount ?? 0,
      amountReceivedCents: pi.amount_received ?? 0,
      chargeId: typeof pi.latest_charge === 'string' ? pi.latest_charge : pi.latest_charge?.id ?? null,
      customerId: typeof pi.customer === 'string' ? pi.customer : pi.customer?.id ?? null,
      paymentMethodId: typeof pi.payment_method === 'string' ? pi.payment_method : pi.payment_method?.id ?? null,
      metadata: pi.metadata ?? {},
      lastPaymentError: pi.last_payment_error?.message ?? null,
      clientSecret: pi.client_secret ?? null,
    };
  },

  async createOffSessionCharge(params) {
    const stripe = getStripe();
    const pi: any = await stripe.paymentIntents.create(
      {
        amount: params.amountCents,
        currency: params.currency,
        customer: params.customerId,
        ...(params.paymentMethodId ? { payment_method: params.paymentMethodId } : {}),
        off_session: true,
        confirm: true,
        capture_method: 'automatic',
        description: params.description,
        metadata: params.metadata,
        automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      },
      params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : undefined,
    );
    return {
      paymentIntentId: pi.id,
      status: pi.status,
      chargeId: typeof pi.latest_charge === 'string' ? pi.latest_charge : pi.latest_charge?.id ?? null,
      failureReason: pi.last_payment_error?.message ?? null,
      requiresAction: pi.status === 'requires_action' || pi.status === 'requires_confirmation',
    };
  },

  async createRefund(params) {
    const stripe = getStripe();
    const refund: any = await stripe.refunds.create(
      {
        payment_intent: params.paymentIntentId,
        ...(params.amountCents ? { amount: params.amountCents } : {}),
        reason: (params.reason as any) ?? undefined,
      },
      params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : undefined,
    );
    return { refundId: refund.id, status: refund.status ?? null };
  },

  async createExpressAccount({ driverId, email, country }) {
    const stripe = getStripe();
    try {
      const account = await stripe.accounts.create(
        {
          type: 'express',
          email: email ?? undefined,
          country: country ?? undefined,
          // Stripe-hosted onboarding; NetRide never stores identity documents.
          capabilities: { transfers: { requested: true }, card_payments: { requested: true } },
          metadata: { netride_driver_id: driverId },
        },
        { idempotencyKey: `netride-driver-account:${driverId}` },
      );
      return { accountId: account.id };
    } catch (err: any) {
      if (/Accounts v1|v2\/core\/accounts/.test(err?.message ?? '')) {
        throw new Error(
          'CONNECT_ACCOUNT_CREATION_BLOCKED: Stripe Connect account creation is disabled for this platform account. ' +
            'Enable "Accounts v1 support" in the Stripe Dashboard (Settings → Developers → API policies → Features) ' +
            'to onboard drivers for payouts.',
        );
      }
      throw err;
    }
  },

  async createAccountLink({ accountId, refreshUrl, returnUrl }) {
    const stripe = getStripe();
    const link = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: refreshUrl,
      return_url: returnUrl,
      type: 'account_onboarding',
    });
    return { url: link.url, expiresAt: link.expires_at ?? null };
  },

  async retrieveAccount(id) {
    const stripe = getStripe();
    const a: any = await stripe.accounts.retrieve(id);
    return {
      accountId: a.id,
      detailsSubmitted: a.details_submitted === true,
      payoutsEnabled: a.payouts_enabled === true,
      chargesEnabled: a.charges_enabled === true,
      requirementsDue: a.requirements?.currently_due ?? [],
      disabledReason: a.requirements?.disabled_reason ?? null,
    };
  },

  async createTransfer(params) {
    const stripe = getStripe();
    const tr: any = await stripe.transfers.create(
      {
        amount: params.amountCents,
        currency: params.currency,
        destination: params.destination,
        description: params.description,
        metadata: params.metadata,
      },
      params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : undefined,
    );
    return { transferId: tr.id };
  },

  async retrieveBalanceTransaction(id) {
    const stripe = getStripe();
    const bt: any = await stripe.balanceTransactions.retrieve(id);
    return {
      feeCents: bt.fee ?? 0,
      netCents: bt.net ?? 0,
      currency: String(bt.currency ?? env.STRIPE_CURRENCY),
    };
  },

  async retrieveCharge(id) {
    const stripe = getStripe();
    const ch: any = await stripe.charges.retrieve(id);
    return {
      id: ch.id,
      balanceTransactionId:
        typeof ch.balance_transaction === 'string' ? ch.balance_transaction : ch.balance_transaction?.id ?? null,
      refundedAmountCents: ch.amount_refunded ?? 0,
      amountCents: ch.amount ?? 0,
    };
  },

  async retrievePaymentMethod(id) {
    const stripe = getStripe();
    const pm = await stripe.paymentMethods.retrieve(id);
    return cardFromPaymentMethod(pm)!;
  },

  async listPaymentMethods(customerId) {
    const stripe = getStripe();
    const list = await stripe.paymentMethods.list({ customer: customerId, type: 'card' });
    return list.data.map((pm) => cardFromPaymentMethod(pm)!).filter(Boolean);
  },

  async detachPaymentMethod(id) {
    const stripe = getStripe();
    await stripe.paymentMethods.detach(id);
  },

  constructWebhookEvent(rawBody, signature) {
    const stripe = getStripe();
    const secret = env.STRIPE_WEBHOOK_SECRET;
    if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
    const event = stripe.webhooks.constructEvent(rawBody, signature, secret);
    return { id: event.id, type: event.type, data: event.data as any };
  },
};

// ---------------------------------------------------------------------------
// Test injection
// ---------------------------------------------------------------------------

let overrideGateway: StripeGateway | null = null;

/**
 * Install a test-only gateway. Refuses to operate outside test runs so a
 * fake payment adapter can never be activated accidentally in production.
 */
export function setStripeGatewayForTests(gateway: StripeGateway): void {
  if (env.NODE_ENV === 'production') {
    throw new Error('Refusing to install a test Stripe gateway in production');
  }
  overrideGateway = gateway;
}

export function clearStripeGatewayForTests(): void {
  overrideGateway = null;
}

/** Test override when installed, otherwise the real SDK adapter. */
export function getStripeGateway(): StripeGateway {
  if (overrideGateway) return overrideGateway;
  return realGateway;
}

/** Returns null when Stripe is not configured (callers degrade gracefully). */
export function tryGetStripeGateway(): StripeGateway | null {
  if (overrideGateway) return overrideGateway;
  if (!env.STRIPE_SECRET_KEY) return null;
  return realGateway;
}
