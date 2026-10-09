// backend/src/modules/payments/payments.controller.ts
//
// HTTP surface for the payment module. Every financial answer is computed
// server-side; clients can only express intent. All rider/driver endpoints
// are scoped to the authenticated principal.

import { Response } from 'express';
import { z } from 'zod';
import { pool } from '../../config/database';
import { env } from '../../config/env';
import { PaymentsService, WALLET_TOPUP_MIN_CENTS, WALLET_TOPUP_MAX_CENTS } from './payments.service';
import { ConnectService } from './connect.service';
import { getFareBreakdown } from './fare-breakdown.service';
import { StripeWebhookService } from './webhook.service';
import { tryGetStripeGateway } from './stripe.gateway';
import type { AuthRequest } from '../../middleware/auth.middleware';

function publicBaseUrl(): string {
  return (env.PUBLIC_BACKEND_URL || env.APP_URL || '').replace(/\/$/, '');
}

function returnUrl(kind: 'card' | 'topup'): string {
  return `${publicBaseUrl()}/api/payments/return?kind=${kind}&state=success`;
}

function cancelUrl(kind: 'card' | 'topup'): string {
  return `${publicBaseUrl()}/api/payments/return?kind=${kind}&state=cancel`;
}

const SetupSessionSchema = z.object({
  consent: z.boolean().default(false),
});

const TopUpSchema = z.object({
  amountCents: z.number().int().min(WALLET_TOPUP_MIN_CENTS).max(WALLET_TOPUP_MAX_CENTS),
  idempotencyKey: z.string().trim().min(8).max(128).optional(),
});

export class PaymentsController {
  /** GET /api/payments/config — non-secret Stripe configuration. */
  static async config(_req: AuthRequest, res: Response) {
    res.json(PaymentsService.config());
  }

  /** GET /api/payments/profile — saved card + consent for the current user. */
  static async profile(req: AuthRequest, res: Response) {
    res.json(await PaymentsService.getPaymentProfile(req.user!.id));
  }

  /** POST /api/payments/setup-session — save a card via Stripe Checkout. */
  static async setupSession(req: AuthRequest, res: Response) {
    try {
      const body = SetupSessionSchema.parse(req.body ?? {});
      const result = await PaymentsService.createCardSetupSession({
        userId: req.user!.id,
        successUrl: returnUrl('card'),
        cancelUrl: cancelUrl('card'),
        consent: body.consent,
      });
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }

  /** POST /api/payments/wallet/topup-session — Stripe Checkout wallet top-up. */
  static async walletTopUpSession(req: AuthRequest, res: Response) {
    try {
      const body = TopUpSchema.parse(req.body ?? {});
      const result = await PaymentsService.createWalletTopUpSession({
        userId: req.user!.id,
        amountCents: body.amountCents,
        successUrl: returnUrl('topup'),
        cancelUrl: cancelUrl('topup'),
        idempotencyKey: body.idempotencyKey,
      });
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }

  /** GET /api/payments/methods — saved cards. */
  static async listMethods(req: AuthRequest, res: Response) {
    res.json({ methods: await PaymentsService.listPaymentMethods(req.user!.id) });
  }

  /** DELETE /api/payments/methods/:id */
  static async detachMethod(req: AuthRequest, res: Response) {
    try {
      await PaymentsService.detachPaymentMethod(req.user!.id, req.params.id);
      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }

  /** POST /api/payments/consent — explicit off-session charge consent. */
  static async consent(req: AuthRequest, res: Response) {
    const recorded = await PaymentsService.recordOffSessionConsent(req.user!.id);
    res.json({ recorded });
  }

  /**
   * GET /api/payments/ride/:rideId/status — the rider's own view of a ride's
   * payment/settlement state (authorization enforced: only the rider or the
   * assigned driver may read it).
   */
  static async rideStatus(req: AuthRequest, res: Response) {
    const rideId = req.params.rideId;
    const ride = await pool.query(
      `SELECT id, rider_id, driver_id, status, fare_amount, final_payment_cents
       FROM rides WHERE id = $1`,
      [rideId],
    );
    const row = ride.rows[0];
    if (!row) return res.status(404).json({ error: 'Ride not found' });
    if (row.rider_id !== req.user!.id && row.driver_id !== req.user!.id && req.user!.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Access denied' });
    }
    const breakdown = await getFareBreakdown(rideId);
    res.json({
      rideId,
      rideStatus: row.status,
      breakdown: breakdown
        ? {
            currency: breakdown.currency,
            originalFareCents: Number(breakdown.original_fare_cents),
            promoDiscountCents: Number(breakdown.promo_discount_cents),
            creditsAppliedCents: Number(breakdown.credits_applied_cents),
            sponsorSubsidyCents: Number(breakdown.sponsor_subsidy_cents),
            riderShareCents: Number(breakdown.rider_share_cents),
            riderCollectedCents: Number(breakdown.rider_collected_cents),
            additionalRiderChargeCents: Number(breakdown.additional_rider_charge_cents),
            additionalChargeStatus: breakdown.additional_charge_status,
            sponsorContributionStatus: breakdown.sponsor_contribution_status,
            settlementStatus: breakdown.settlement_status,
          }
        : null,
    });
  }

  /** GET /api/payments/history — the user's Stripe payment attempts. */
  static async history(req: AuthRequest, res: Response) {
    const resq = await pool.query(
      `SELECT id, purpose, ride_id, amount_cents, currency, status,
              stripe_payment_intent_id, failure_reason, created_at, succeeded_at
       FROM stripe_payments
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [req.user!.id],
    );
    res.json({
      payments: resq.rows.map((r: any) => ({ ...r, amount_cents: Number(r.amount_cents) })),
    });
  }

  /**
   * GET /api/payments/return — Stripe Checkout return landing page. Reconciles
   * the session server-side (never trusts the redirect alone), then hands the
   * user back to the app deep link.
   */
  static async returnHandler(req: AuthRequest, res: Response) {
    const kind = typeof req.query.kind === 'string' ? req.query.kind : 'card';
    const state = typeof req.query.state === 'string' ? req.query.state : 'success';
    const sessionId = typeof req.query.session_id === 'string' ? req.query.session_id : null;
    if (sessionId && state === 'success') {
      try {
        const row = await pool.query(
          `SELECT id FROM stripe_payments WHERE stripe_checkout_session_id = $1`,
          [sessionId],
        );
        if (row.rows[0]?.id) {
          await PaymentsService.reconcilePayment(row.rows[0].id);
        }
      } catch {
        // Best-effort: the webhook remains the source of truth.
      }
    }
    const deepLink = `${env.MOBILE_PAYMENT_RETURN_URL}?kind=${encodeURIComponent(kind)}&state=${encodeURIComponent(state)}`;
    res.redirect(302, deepLink);
  }

  // ------------------------------------------------------------- driver

  /** GET /api/payments/connect/status — pass ?sync=true to pull real state. */
  static async connectStatus(req: AuthRequest, res: Response) {
    try {
      if (req.query.sync === 'true') {
        res.json(await ConnectService.syncAccountStatus(req.user!.id));
        return;
      }
    } catch (err: any) {
      // Fall through to the persisted state with the sync error attached.
      const status = await ConnectService.getStatus(req.user!.id);
      return res.json({ ...status, syncError: err.message });
    }
    res.json(await ConnectService.getStatus(req.user!.id));
  }

  /** POST /api/payments/connect/onboarding — Stripe-hosted onboarding link. */
  static async connectOnboarding(req: AuthRequest, res: Response) {
    try {
      const result = await ConnectService.createOnboardingLink(req.user!.id, {
        refreshUrl: `${publicBaseUrl()}/api/payments/connect/refresh`,
        returnUrl: `${publicBaseUrl()}/api/payments/connect/return`,
      });
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }

  /**
   * Public Stripe onboarding redirects (no app auth header in a browser
   * navigation). They only hand the user back to the app; the app then calls
   * the authenticated status endpoint with ?sync=true.
   */
  static async connectRefresh(_req: AuthRequest, res: Response) {
    res.redirect(302, `${env.MOBILE_PAYMENT_RETURN_URL}?kind=driver_onboarding&state=refresh`);
  }

  static async connectReturn(_req: AuthRequest, res: Response) {
    res.redirect(302, `${env.MOBILE_PAYMENT_RETURN_URL}?kind=driver_onboarding&state=done`);
  }

  // ------------------------------------------------------------- webhook

  /**
   * POST /api/payments/webhook — registered with express.raw BEFORE the
   * global JSON body parser so the raw bytes are available for Stripe's
   * signature verification.
   */
  static async webhook(req: any, res: Response) {
    const signature = req.headers['stripe-signature'];
    if (!signature) return res.status(400).json({ error: 'Missing stripe-signature header' });
    const gateway = tryGetStripeGateway();
    if (!gateway) return res.status(503).json({ error: 'Stripe is not configured' });

    let event;
    try {
      event = gateway.constructWebhookEvent(req.body as Buffer, String(signature));
    } catch (err: any) {
      console.warn(`[STRIPE] ⚠️ webhook signature verification failed: ${err.message}`);
      return res.status(400).json({ error: 'Invalid signature' });
    }

    try {
      const outcome = await StripeWebhookService.handleEvent(event);
      return res.json({ received: true, outcome });
    } catch (err: any) {
      console.error(`[STRIPE] ❌ webhook ${event.type} (${event.id}) failed: ${err.message}`);
      // 500 → Stripe retries the delivery (idempotency makes the retry safe).
      return res.status(500).json({ error: 'Webhook processing failed' });
    }
  }
}
