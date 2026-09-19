// backend/src/modules/partner/partner-portal.controller.ts
//
// PARTNER PORTAL API — a partner sees ONLY their own isolated data.
// Every handler scopes queries by the partner id from the JWT, so partner A
// can never read partner B's usage or earnings (spec requirement).
//
// NOTE: authentication (login + email 2FA + password change) lives on the
// unified portal controller (/api/portal/auth/*). The legacy /partner/auth/*
// credential login was removed because it bypassed 2FA.

import { Request, Response } from 'express';
import { pool } from '../../config/database';
import { PartnerService } from '../partner/partner.service';
import { FinancialLedgerService } from '../../services/financial-ledger.service';

export interface PartnerRequest extends Request {
  user?: { id: string; role: string; email: string };
  partner?: { id: string; email: string };
}

export class PartnerPortalController {
  // --------------------------------------------------------- dashboard

  static async dashboard(req: PartnerRequest, res: Response) {
    try {
      const partnerId = req.partner!.id;
      const partner = await PartnerService.getById(partnerId);
      if (!partner) return res.status(404).json({ error: 'Partner not found' });

      // Usage stats: completed rides with this partner's promo codes
      const usageRes = await pool.query(
        `SELECT COALESCE(COUNT(pu.id), 0)::int AS total_uses
         FROM promo_usage pu
         JOIN promo_codes pc ON pc.id = pu.promo_id
         WHERE pc.partner_id = $1 AND pu.status = 'USED'`,
        [partnerId],
      );

      // Earnings stats from partner row
      const earnings = {
        lifetime_earnings_cents: partner.lifetime_earnings_cents,
        pending_earnings_cents: partner.pending_earnings_cents,
        paid_earnings_cents: partner.paid_earnings_cents,
      };

      // Recent commissions
      const commissionsRes = await pool.query(
        `SELECT c.*, r.fare_amount, r.final_payment_cents,
                 u.full_name AS rider_name
          FROM partner_commissions c
          JOIN rides r ON r.id = c.ride_id
          LEFT JOIN users u ON u.id = r.rider_id
          WHERE c.partner_id = $1
          ORDER BY c.created_at DESC
          LIMIT 10`,
        [partnerId],
      );

      res.json({
        partner: {
          id: partner.id,
          name: partner.name,
          status: partner.status,
        },
        usage: {
          total_uses: usageRes.rows[0].total_uses,
        },
        earnings,
        recent_commissions: commissionsRes.rows.map((c: any) => ({
          id: c.id,
          ride_id: c.ride_id,
          promo_code: c.promo_code,
          ride_price_cents: c.ride_price_cents,
          commission_cents: c.commission_cents,
          commission_rate: c.commission_rate,
          status: c.status,
          rider_name: c.rider_name,
          created_at: c.created_at,
        })),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  // --------------------------------------------------------- usage

  static async usage(req: PartnerRequest, res: Response) {
    try {
      const partnerId = req.partner!.id;
      const page = Math.max(Number(req.query.page ?? 1), 1);
      const limit = Math.min(Math.max(Number(req.query.limit ?? 20), 1), 100);
      const offset = (page - 1) * limit;

      const ridesRes = await pool.query(
        `SELECT r.id, r.status, r.promo_code, r.final_payment_cents,
                 r.fare_amount, r.created_at,
                 u.full_name AS rider_name
          FROM rides r
          LEFT JOIN users u ON u.id = r.rider_id
          WHERE r.promo_id IN (SELECT id FROM promo_codes WHERE partner_id = $1)
            AND r.status = 'COMPLETED'
          ORDER BY r.created_at DESC
          LIMIT $2 OFFSET $3`,
        [partnerId, limit, offset],
      );

      const totalRes = await pool.query(
        `SELECT COUNT(*)::int AS n
         FROM rides r
         WHERE r.promo_id IN (SELECT id FROM promo_codes WHERE partner_id = $1)
           AND r.status = 'COMPLETED'`,
        [partnerId],
      );

      res.json({
        rides: ridesRes.rows.map((r: any) => ({
          id: r.id,
          status: r.status,
          promo_code: r.promo_code,
          final_payment_cents: r.final_payment_cents,
          fare_amount: r.fare_amount,
          rider_name: r.rider_name,
          created_at: r.created_at,
        })),
        total: totalRes.rows[0].n,
        page,
        limit,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  // --------------------------------------------------------- earnings

  static async earnings(req: PartnerRequest, res: Response) {
    try {
      const partnerId = req.partner!.id;

      const earningsRes = await pool.query(
        `SELECT
           COALESCE(SUM(driver_share_cents), 0)::bigint AS total_earnings_cents,
           COALESCE(SUM(tip_cents), 0)::bigint AS total_tip_cents,
           COUNT(*)::int AS total_rides
         FROM financial_transactions ft
         JOIN rides r ON r.id = ft.ride_id
         WHERE ft.driver_id IS NOT NULL
           AND r.promo_id IN (SELECT id FROM promo_codes WHERE partner_id = $1)
           AND ft.status = 'SETTLED'`,
        [partnerId],
      );

      const recentRes = await pool.query(
        `SELECT ft.*, r.promo_code, r.fare_amount, r.final_payment_cents
         FROM financial_transactions ft
         JOIN rides r ON r.id = ft.ride_id
         WHERE r.promo_id IN (SELECT id FROM promo_codes WHERE partner_id = $1)
           AND ft.status = 'SETTLED'
         ORDER BY ft.completed_at DESC
         LIMIT 10`,
        [partnerId],
      );

      res.json({
        total_earnings_cents: earningsRes.rows[0].total_earnings_cents,
        total_tip_cents: earningsRes.rows[0].total_tip_cents,
        total_rides: earningsRes.rows[0].total_rides,
        recent_earnings: recentRes.rows.map((r: any) => ({
          ride_id: r.ride_id,
          promo_code: r.promo_code,
          fare_cents: r.fare_amount,
          final_payment_cents: r.final_payment_cents,
          earnings_cents: r.driver_share_cents,
          completed_at: r.completed_at,
        })),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  // --------------------------------------------------------- commission

  static async commission(req: PartnerRequest, res: Response) {
    try {
      const partnerId = req.partner!.id;
      const partner = await PartnerService.getById(partnerId);
      if (!partner) return res.status(404).json({ error: 'Partner not found' });

      res.json({
        commission_rate: partner.commission_rate,
        commission_type: 'Percentage', // always percentage for partners
        lifetime_earnings_cents: partner.lifetime_earnings_cents,
        pending_earnings_cents: partner.pending_earnings_cents,
        paid_earnings_cents: partner.paid_earnings_cents,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }
}