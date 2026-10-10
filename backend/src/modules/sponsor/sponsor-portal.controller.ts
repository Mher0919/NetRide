// backend/src/modules/sponsor/sponsor-portal.controller.ts
//
// SPONSOR PORTAL API — a sponsor sees ONLY their own data. Every handler
// scopes queries by req.sponsor.id (the JWT sponsorId claim), so sponsor A
// can never read sponsor B's customers or validations (spec §78-80).
//
// NOTE: authentication (login + email 2FA + password change) lives on the
// unified portal controller (/api/portal/auth/*). The legacy /sponsor/auth/*
// credential login was removed because it bypassed 2FA.

import { Request, Response } from 'express';
import { pool } from '../../config/database';
import { env } from '../../config/env';
import { centsValue } from '../../services/financial-ledger.service';
import { SponsorService, discountLabelFor } from './sponsor.service';
import { SpecialRedemptionService } from './special-redemption.service';
import { PaymentsService } from '../payments/payments.service';
import { stripeMode, isStripeConfigured } from '../payments/stripe.client';
import {
  sponsorWithdrawalState,
  listSponsorWithdrawals,
  requestSponsorWithdrawal,
} from '../payments/withdrawal.service';

export interface SponsorRequest extends Request {
  user?: { id: string; role: string; email: string };
  sponsor?: { id: string; userId: string; email: string };
}

const VALIDATION_BATCH_SIZE = 50;

export class SponsorPortalController {
  // ------------------------------------------------------------- overview

  static async dashboard(req: SponsorRequest, res: Response) {
    try {
      const sponsor = await SponsorService.findById(req.sponsor!.id);
      if (!sponsor) return res.status(404).json({ error: 'Sponsor not found' });

      const pending = await pool.query(
        `SELECT COUNT(*)::int AS n FROM special_redemptions
         WHERE sponsor_id = $1 AND status = 'WAITING_FOR_SPONSOR'`,
        [req.sponsor!.id],
      );
      const redeemed = await pool.query(
        `SELECT COUNT(*)::int AS n, COALESCE(SUM(calculated_discount_cents),0)::bigint AS cents
         FROM special_redemptions
         WHERE sponsor_id = $1 AND status IN ('REWARD_COMPLETED','SPONSOR_VALIDATED','REWARD_SELECTED')`,
        [req.sponsor!.id],
      );
      const credited = await pool.query(
        `SELECT COUNT(*)::int AS n,
                COALESCE(SUM(reward_amount_cents), 0)::bigint AS cents
         FROM special_redemptions
         WHERE sponsor_id = $1 AND status IN ('REWARD_COMPLETED','SPONSOR_VALIDATED','REWARD_SELECTED')`,
        [req.sponsor!.id],
      );

      res.json({
        sponsor: {
          id: sponsor.id,
          businessName: sponsor.business_name,
          businessType: sponsor.business_type,
          status: sponsor.status,
          discountLabel: discountLabelFor(sponsor),
          remainingBudgetCents: sponsor.remaining_budget_cents,
          usedBudgetCents: sponsor.used_budget_cents,
        },
        stats: {
          pendingValidations: pending.rows[0].n,
          redeemedCount: Number(redeemed.rows[0].n),
          redeemedDiscountCents: centsValue(redeemed.rows[0].cents),
          rewardAmountCents: centsValue(credited.rows[0].cents),
        },
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  // ----------------------------------------------------------- validations

  static async listValidations(req: SponsorRequest, res: Response) {
    try {
      const status = String(req.query.status ?? 'WAITING_FOR_SPONSOR').toUpperCase();
      const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 100);
      const offset = Math.max(Number(req.query.offset ?? 0), 0);
      const validStatuses = ['CREATED', 'RIDE_PENDING', 'WAITING_FOR_SPONSOR', 'SPONSOR_VALIDATED', 'REWARD_SELECTED', 'REWARD_COMPLETED', 'CANCELLED', 'EXPIRED', 'REWARD_FAILED'];
      const effectiveStatus = validStatuses.includes(status) ? status : 'WAITING_FOR_SPONSOR';

      const resq = await pool.query(
        `SELECT sr.id, sr.status, sr.sponsor_name, sr.discount_label,
                sr.calculated_discount_cents, sr.reward_choice,
                sr.reward_amount_cents, sr.sponsor_funded_cents,
                sr.driver_allocation_cents, sr.netride_allocation_cents,
                sr.ride_requested_at, sr.ride_completed_at,
                sr.sponsor_validated_at, sr.reward_processed_at,
                sr.cancellation_reason_code, sr.cancellation_reason_text,
                sr.validation_expires_at, sr.validation_attempts,
                sr.max_validation_attempts,
                u.full_name AS rider_name, u.id AS rider_id
         FROM special_redemptions sr
         JOIN users u ON u.id = sr.rider_id
         WHERE sr.sponsor_id = $1 AND sr.status = $2
         ORDER BY sr.created_at DESC
         LIMIT $3 OFFSET $4`,
        [req.sponsor!.id, effectiveStatus, limit, offset],
      );
      res.json({ validations: resq.rows.map((r: any) => ({ ...r, calculated_discount_cents: centsValue(r.calculated_discount_cents), reward_amount_cents: centsValue(r.reward_amount_cents), sponsor_funded_cents: centsValue(r.sponsor_funded_cents), driver_allocation_cents: centsValue(r.driver_allocation_cents), netride_allocation_cents: centsValue(r.netride_allocation_cents) })) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  static async validate(req: SponsorRequest, res: Response) {
    try {
      const { code, confirmed } = req.body ?? {};
      const redemption = await SpecialRedemptionService.sponsorValidate(req.sponsor!.id, code, { confirmed });
      res.json({ redemption, message: 'Visit validated. The rider can now collect their reward.' });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }

  static async cancel(req: SponsorRequest, res: Response) {
    try {
      const { reasonCode, reasonText, confirmed } = req.body ?? {};
      const redemption = await SpecialRedemptionService.sponsorCancel(
        req.sponsor!.id,
        req.params.id,
        reasonCode,
        reasonText,
        { confirmed },
      );
      res.json({ redemption, message: 'Validation cancelled.' });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }

  // ------------------------------------------------------------- customers

  static async listCustomers(req: SponsorRequest, res: Response) {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 100);
      const offset = Math.max(Number(req.query.offset ?? 0), 0);

      const resq = await pool.query(
        `SELECT u.id AS rider_id, u.full_name AS rider_name,
                COUNT(sr.id)::int AS visits,
                COUNT(sr.id) FILTER (WHERE sr.status = 'REWARD_COMPLETED')::int AS rewarded_visits,
                COALESCE(SUM(sr.calculated_discount_cents), 0)::bigint AS total_discount_cents,
                COALESCE(SUM(sr.reward_amount_cents), 0)::bigint AS total_reward_cents,
                MAX(sr.created_at) AS last_visit_at
         FROM special_redemptions sr
         JOIN users u ON u.id = sr.rider_id
         WHERE sr.sponsor_id = $1
         GROUP BY u.id, u.full_name
         ORDER BY last_visit_at DESC
         LIMIT $2 OFFSET $3`,
        [req.sponsor!.id, limit, offset],
      );
      res.json({
        customers: resq.rows.map((r: any) => ({
          riderId: r.rider_id,
          riderName: r.rider_name,
          visits: Number(r.visits),
          rewardedVisits: Number(r.rewarded_visits),
          totalDiscountCents: centsValue(r.total_discount_cents),
          totalRewardCents: centsValue(r.total_reward_cents),
          lastVisitAt: r.last_visit_at,
        })),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  // -------------------------------------------------------------- settings

  static async getSettings(req: SponsorRequest, res: Response) {
    try {
      const sponsor = await SponsorService.findById(req.sponsor!.id);
      if (!sponsor) return res.status(404).json({ error: 'Sponsor not found' });
      res.json({
        businessName: sponsor.business_name,
        businessType: sponsor.business_type,
        businessDescription: sponsor.business_description,
        managerName: sponsor.manager_name,
        phone: sponsor.phone,
        email: sponsor.email,
        otherContactInfo: sponsor.other_contact_info,
        address: sponsor.address,
        city: sponsor.city,
        state: sponsor.state,
        postalCode: sponsor.postal_code,
        country: sponsor.country,
        discount: discountLabelFor(sponsor),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  /** Settings edits allowed to the sponsor: contact + description ONLY (no financial fields, §52). */
  static async updateSettings(req: SponsorRequest, res: Response) {
    try {
      const allowed = [
        'business_description', 'manager_name', 'phone', 'email',
        'other_contact_info', 'address', 'city', 'state', 'postal_code', 'country',
      ];
      const patch: Record<string, unknown> = {};
      for (const key of allowed) {
        if (req.body[key] !== undefined) patch[key] = req.body[key];
      }
      const sponsor = await SponsorService.update(req.sponsor!.id, patch);
      if (!sponsor) return res.status(404).json({ error: 'Sponsor not found' });
      res.json({ sponsor: { businessName: sponsor.business_name, email: sponsor.email, phone: sponsor.phone } });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }

  // --------------------------------------------------------------- funding

  /**
   * Budget + real Stripe funding history. NetRide admin funding adjustments
   * remain visible in the sponsor ledger; this view is specifically the
   * Stripe-collected top-ups.
   */
  static async fundingHistory(req: SponsorRequest, res: Response) {
    try {
      const sponsor = await SponsorService.findById(req.sponsor!.id);
      if (!sponsor) return res.status(404).json({ error: 'Sponsor not found' });
      const payments = await pool.query(
        `SELECT id, amount_cents, currency, status, stripe_payment_intent_id,
                stripe_checkout_session_id, failure_reason, created_at, succeeded_at
         FROM stripe_payments
         WHERE sponsor_id = $1 AND purpose = 'SPONSOR_BUDGET_TOPUP'
         ORDER BY created_at DESC LIMIT 50`,
        [req.sponsor!.id],
      );
      res.json({
        configured: isStripeConfigured(),
        mode: stripeMode(),
        budget: {
          initialBudgetCents: sponsor.initial_budget_cents,
          remainingBudgetCents: sponsor.remaining_budget_cents,
          reservedBudgetCents: sponsor.reserved_budget_cents,
          usedBudgetCents: sponsor.used_budget_cents,
          spendableBudgetCents: Math.max(0, sponsor.remaining_budget_cents - sponsor.reserved_budget_cents),
        },
        payments: payments.rows.map((r: any) => ({
          ...r,
          amount_cents: centsValue(r.amount_cents),
        })),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  /** Starts a Stripe Checkout session that funds the sponsor's budget. */
  static async createFundingSession(req: SponsorRequest, res: Response) {
    try {
      const amountCents = Math.round(Number(req.body?.amountCents ?? 0));
      const portalBase = (env.SPONSOR_PORTAL_URL || env.PUBLIC_BACKEND_URL || env.APP_URL || '').replace(/\/$/, '');
      const result = await PaymentsService.createSponsorTopUpSession({
        sponsorId: req.sponsor!.id,
        amountCents,
        successUrl: `${portalBase}/funding?state=success`,
        cancelUrl: `${portalBase}/funding?state=cancel`,
        createdByUserId: req.user?.id ?? null,
        idempotencyKey: typeof req.body?.idempotencyKey === 'string' ? req.body.idempotencyKey : undefined,
      });
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }

  // ------------------------------------------------------- managed card

  /** Saved card on the sponsor's Stripe customer (used for payments/refunds). */
  static async getPaymentMethod(req: SponsorRequest, res: Response) {
    try {
      const row = await pool.query(
        `SELECT stripe_customer_id, card_brand, card_last4, card_exp_month,
                card_exp_year, updated_payment_at
         FROM sponsors WHERE id = $1`,
        [req.sponsor!.id],
      );
      const r = row.rows[0];
      res.json({
        configured: isStripeConfigured(),
        mode: stripeMode(),
        card: r?.card_last4
          ? {
              brand: r.card_brand,
              last4: r.card_last4,
              expMonth: r.card_exp_month,
              expYear: r.card_exp_year,
            }
          : null,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  /** Stripe-hosted Checkout (mode=setup) to save a managed card. */
  static async createCardSetupSession(req: SponsorRequest, res: Response) {
    try {
      const portalBase = (env.SPONSOR_PORTAL_URL || env.PUBLIC_BACKEND_URL || env.APP_URL || '').replace(/\/$/, '');
      const result = await PaymentsService.createSponsorCardSetupSession({
        sponsorId: req.sponsor!.id,
        successUrl: `${portalBase}/funding?state=card-success`,
        cancelUrl: `${portalBase}/funding?state=cancel`,
      });
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }

  // -------------------------------------------------- manual withdrawals

  /** Withdrawal history + weekly availability (window opens every Monday). */
  static async withdrawals(req: SponsorRequest, res: Response) {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 100);
      const offset = Math.max(Number(req.query.offset ?? 0), 0);
      const [state, rows] = await Promise.all([
        sponsorWithdrawalState(req.sponsor!.id),
        listSponsorWithdrawals(req.sponsor!.id, limit, offset),
      ]);
      res.json({
        state: {
          eligible: state.eligible,
          nextAvailableAt: state.nextAvailableAt.toISOString(),
        },
        withdrawals: rows,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  /**
   * Manual budget withdrawal (once per week; window opens every Monday).
   * Implemented as Stripe refunds of the sponsor's funding charges — the
   * budget is only debited once the request is accepted.
   */
  static async requestWithdrawal(req: SponsorRequest, res: Response) {
    try {
      const amountCents = Math.round(Number(req.body?.amountCents ?? 0));
      if (!Number.isFinite(amountCents) || amountCents <= 0) {
        return res.status(400).json({ error: 'Withdrawal amount must be positive' });
      }
      const result = await requestSponsorWithdrawal({
        sponsorId: req.sponsor!.id,
        amountCents,
        actorUserId: req.user?.id ?? null,
      });
      res.json({
        withdrawal: {
          id: result.withdrawal.id,
          amount_cents: centsValue(result.withdrawal.amount_cents),
          status: result.withdrawal.status,
          failure_reason: result.withdrawal.failure_reason,
          requested_at: result.withdrawal.requested_at,
        },
        state: {
          eligible: result.state.eligible,
          nextAvailableAt: result.state.nextAvailableAt.toISOString(),
        },
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }
}