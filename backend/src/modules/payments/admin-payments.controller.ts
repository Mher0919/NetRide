// backend/src/modules/payments/admin-payments.controller.ts
//
// Admin payment oversight: reconciliation views, failed/unresolved items,
// retry and refund actions. Admin-guarded by the router. Every sensitive
// action is audit-logged with the acting admin.

import { Response } from 'express';
import { z } from 'zod';
import { pool } from '../../config/database';
import { PaymentsService } from './payments.service';
import { ConnectService } from './connect.service';
import { RideSettlementService } from './ride-settlement.service';
import { AuditEventsService } from '../../services/audit-events.service';
import { stripeMode, isStripeConfigured } from './stripe.client';
import type { AuthRequest } from '../../middleware/auth.middleware';

function num(v: any): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

const RefundSchema = z.object({
  amountCents: z.number().int().positive().optional(),
  reason: z.string().trim().max(200).optional(),
});

export class AdminPaymentsController {
  static async overview(_req: AuthRequest, res: Response) {
    const [payments, exceptions, events] = await Promise.all([
      pool.query(
        `SELECT purpose, status, COUNT(*)::int AS count, COALESCE(SUM(amount_cents),0)::bigint AS amount_cents
         FROM stripe_payments GROUP BY purpose, status ORDER BY purpose, status`,
      ),
      pool.query(
        `SELECT COUNT(*)::int AS count FROM ride_fare_breakdowns
         WHERE settlement_status = 'EXCEPTION'
            OR additional_charge_status IN ('REQUIRED','FAILED')
            OR (sponsor_contribution_status = 'RESERVED' AND created_at < NOW() - INTERVAL '48 hours')`,
      ),
      pool.query(
        `SELECT COUNT(*)::int AS count FROM stripe_webhook_events WHERE status = 'FAILED'`,
      ),
    ]);
    res.json({
      stripe: { configured: isStripeConfigured(), mode: stripeMode() },
      payments: payments.rows.map((r: any) => ({
        purpose: r.purpose,
        status: r.status,
        count: Number(r.count),
        amountCents: Number(r.amount_cents),
      })),
      exceptionCount: Number(exceptions.rows[0]?.count ?? 0),
      failedWebhookCount: Number(events.rows[0]?.count ?? 0),
    });
  }

  static async listPayments(req: AuthRequest, res: Response) {
    const status = typeof req.query.status === 'string' ? req.query.status : null;
    const purpose = typeof req.query.purpose === 'string' ? req.query.purpose : null;
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 200);
    const offset = Math.max(Number(req.query.offset ?? 0), 0);
    const resq = await pool.query(
      `SELECT p.*, u.email AS user_email, s.business_name AS sponsor_name
       FROM stripe_payments p
       LEFT JOIN users u ON u.id = p.user_id
       LEFT JOIN sponsors s ON s.id = p.sponsor_id
       WHERE ($1::text IS NULL OR p.status = $1)
         AND ($2::text IS NULL OR p.purpose = $2)
       ORDER BY p.created_at DESC
       LIMIT $3 OFFSET $4`,
      [status, purpose, limit, offset],
    );
    res.json({
      payments: resq.rows.map((r: any) => ({ ...r, amount_cents: num(r.amount_cents), stripe_fee_cents: num(r.stripe_fee_cents) })),
    });
  }

  /** Reconciliation: local ride settlement components + Stripe references. */
  static async listSettlements(req: AuthRequest, res: Response) {
    const settlement = typeof req.query.settlementStatus === 'string' ? req.query.settlementStatus : null;
    const onlyIssues = req.query.issues === 'true';
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 200);
    const offset = Math.max(Number(req.query.offset ?? 0), 0);
    const resq = await pool.query(
      `SELECT b.*, r.status AS ride_status, r.fare_amount,
              ft.status AS ledger_status, ft.stripe_fee_cents
       FROM ride_fare_breakdowns b
       JOIN rides r ON r.id = b.ride_id
       LEFT JOIN financial_transactions ft ON ft.ride_id = b.ride_id
       WHERE ($1::text IS NULL OR b.settlement_status = $1)
         AND (NOT $2 OR b.settlement_status = 'EXCEPTION'
              OR b.additional_charge_status IN ('REQUIRED','FAILED')
              OR (b.sponsor_contribution_status = 'RESERVED' AND b.created_at < NOW() - INTERVAL '48 hours'))
       ORDER BY b.created_at DESC
       LIMIT $3 OFFSET $4`,
      [settlement, onlyIssues, limit, offset],
    );
    res.json({
      settlements: resq.rows.map((r: any) => ({
        rideId: r.ride_id,
        rideStatus: r.ride_status,
        currency: r.currency,
        originalFareCents: num(r.original_fare_cents),
        promoDiscountCents: num(r.promo_discount_cents),
        creditsAppliedCents: num(r.credits_applied_cents),
        sponsorSubsidyCents: num(r.sponsor_subsidy_cents),
        riderShareCents: num(r.rider_share_cents),
        riderCollectedCents: num(r.rider_collected_cents),
        sponsorCollectedCents: num(r.sponsor_collected_cents),
        additionalRiderChargeCents: num(r.additional_rider_charge_cents),
        additionalChargeStatus: r.additional_charge_status,
        sponsorContributionStatus: r.sponsor_contribution_status,
        driverEarningsCents: num(r.driver_earnings_cents),
        driverSettledCents: num(r.driver_settled_cents),
        platformCommissionCents: num(r.platform_commission_cents),
        settlementStatus: r.settlement_status,
        ledgerStatus: r.ledger_status,
        stripeFeeCents: num(r.stripe_fee_cents),
        stripePaymentIntentId: r.rider_payment_intent_id,
        additionalChargePaymentIntentId: r.additional_charge_payment_intent_id,
        reconciliationNote: r.reconciliation_note,
        createdAt: r.created_at,
      })),
    });
  }

  static async listEvents(_req: AuthRequest, res: Response) {
    const resq = await pool.query(
      `SELECT stripe_event_id, type, status, error, received_at, processed_at
       FROM stripe_webhook_events ORDER BY received_at DESC LIMIT 100`,
    );
    res.json({ events: resq.rows });
  }

  static async reconcile(req: AuthRequest, res: Response) {
    try {
      const result = await PaymentsService.reconcilePayment(req.params.id);
      await AuditEventsService.record({
        actorId: req.user?.id ?? null,
        actorRole: 'ADMIN',
        action: 'stripe_payment_reconciled',
        entityType: 'stripe_payment',
        entityId: req.params.id,
        details: result,
      }).catch(() => undefined);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }

  static async retryAdditionalCharge(req: AuthRequest, res: Response) {
    try {
      const result = await RideSettlementService.retryAdditionalCharge(req.params.rideId);
      await AuditEventsService.record({
        actorId: req.user?.id ?? null,
        actorRole: 'ADMIN',
        action: 'special_additional_charge_retried',
        entityType: 'ride',
        entityId: req.params.rideId,
        details: result,
      }).catch(() => undefined);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }

  static async refund(req: AuthRequest, res: Response) {
    try {
      const body = RefundSchema.parse(req.body ?? {});
      const result = await PaymentsService.refundPayment({
        stripePaymentId: req.params.id,
        amountCents: body.amountCents,
        reason: body.reason,
        idempotencyKey: `admin-refund:${req.params.id}:${body.amountCents ?? 'full'}`,
      });
      if (!result.ok) return res.status(400).json({ error: result.reason });
      await AuditEventsService.record({
        actorId: req.user?.id ?? null,
        actorRole: 'ADMIN',
        action: 'stripe_payment_refunded',
        entityType: 'stripe_payment',
        entityId: req.params.id,
        details: { amountCents: body.amountCents ?? null, refundId: result.refundId },
      }).catch(() => undefined);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }

  /**
   * Executes the real Stripe Transfer for an approved payout. Only applies to
   * payout rows; the transfer amount is the row's persisted net amount, never
   * a client-supplied number.
   */
  static async transferPayout(req: AuthRequest, res: Response) {
    try {
      const payout = await pool.query(
        `SELECT id, driver_id, net_cents, amount_cents, status, method, stripe_transfer_id
         FROM payouts WHERE id = $1`,
        [req.params.payoutId],
      );
      const row = payout.rows[0];
      if (!row) return res.status(404).json({ error: 'Payout not found' });
      if (row.status === 'PAID' && row.stripe_transfer_id) {
        return res.json({ transferred: true, transferId: row.stripe_transfer_id, alreadyTransferred: true });
      }
      const amountCents = num(row.net_cents || row.amount_cents);
      const result = await ConnectService.transferPayout({
        payoutId: row.id,
        driverId: row.driver_id,
        amountCents,
        description: `NetRide ${row.method} payout`,
      });
      if (result.transferred) {
        await pool.query(
          `UPDATE payouts SET status = 'PAID', processed_at = COALESCE(processed_at, NOW()) WHERE id = $1`,
          [row.id],
        );
      }
      await AuditEventsService.record({
        actorId: req.user?.id ?? null,
        actorRole: 'ADMIN',
        action: 'driver_payout_transferred',
        entityType: 'payout',
        entityId: row.id,
        details: { amountCents, transferId: result.transferId ?? null, reason: result.reason ?? null },
      }).catch(() => undefined);
      if (!result.transferred) return res.status(400).json({ error: result.reason ?? 'transfer_failed' });
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }
}
