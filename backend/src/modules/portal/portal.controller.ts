// backend/src/modules/portal/portal.controller.ts
//
// UNIFIED PORTAL API — auth + type-aware dashboard for sponsor, partner and
// fleet accounts. Sponsor-specific flows (validations, customers, settings)
// stay on the existing /sponsor/* endpoints.

import { Request, Response } from 'express';
import { z } from 'zod';
import { PortalAuthService } from './portal-auth.service';
import { PortalRequest } from '../../middleware/portal.middleware';
import { pool } from '../../config/database';
import { redis } from '../../config/redis';
import { OTPService } from '../auth/otp.service';
import { SponsorService } from '../sponsor/sponsor.service';
import { PartnerService } from '../partner/partner.service';

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
  trusted_device_token: z.string().nullable().optional(),
});
const ChangePasswordSchema = z.object({ newPassword: z.string().min(8) });
const ResetPasswordSchema = z.object({ token: z.string(), newPassword: z.string().min(8) });

const cents = (v: any): number => Number(v ?? 0);

export class PortalController {
  // ------------------------------------------------------------------ auth

  static async login(req: Request, res: Response) {
    try {
      const { email, password, trusted_device_token } = LoginSchema.parse(req.body);
      const session = await PortalAuthService.login(email, password, trusted_device_token);
      res.json(session);
    } catch (error: any) {
      console.error(`[PORTAL] ❌ Login error: ${error.message}`);
      res.status(401).json({ error: error.message });
    }
  }

  static async verify2FA(req: Request, res: Response) {
    try {
      const { email, code } = z.object({
        email: z.string().email(),
        code: z.string().length(6),
      }).parse(req.body);
      const result = await PortalAuthService.verify2FA(email, code);
      res.json(result);
    } catch (error: any) {
      console.error(`[PORTAL] ❌ 2FA verify error: ${error.message}`);
      res.status(401).json({ error: error.message });
    }
  }

  static async refresh(req: Request, res: Response) {
    try {
      const { refreshToken } = z.object({ refreshToken: z.string() }).parse(req.body);
      const result = await PortalAuthService.refreshToken(refreshToken);
      res.json(result);
    } catch (error: any) {
      res.status(401).json({ error: error.message });
    }
  }

  static async logout(req: Request, res: Response) {
    try {
      const { refreshToken } = z.object({ refreshToken: z.string() }).parse(req.body);
      await PortalAuthService.invalidateRefreshToken(refreshToken);
      res.json({ success: true });
    } catch {
      res.json({ success: true });
    }
  }

  static async changePassword(req: PortalRequest, res: Response) {
    try {
      const { newPassword } = ChangePasswordSchema.parse(req.body);
      await PortalAuthService.changePassword(req.portal!.userId, newPassword);
      res.json({ message: 'Password updated successfully' });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  static async forgotPassword(req: Request, res: Response) {
    try {
      const { email } = z.object({ email: z.string().email() }).parse(req.body);
      await OTPService.generateOTP(email);
    } catch {
      // anti-enumeration: same response either way
    }
    res.json({ message: 'If an account with that email exists, a verification code has been sent.' });
  }

  static async verifyResetOTP(req: Request, res: Response) {
    try {
      const { email, code } = z.object({ email: z.string().email(), code: z.string().length(6) }).parse(req.body);
      const valid = await OTPService.verifyOTP(email, code);
      if (!valid) return res.status(400).json({ error: 'Invalid or expired verification code.' });
      const resetToken = require('crypto').randomUUID();
      await redis.set(`portal_pwd_reset:${resetToken}`, email, 'EX', 3600);
      res.json({ resetToken });
    } catch (error: any) {
      res.status(400).json({ error: error.message || 'Failed to verify code.' });
    }
  }

  static async resetPassword(req: Request, res: Response) {
    try {
      const { token, newPassword } = ResetPasswordSchema.parse(req.body);
      const email = await redis.get(`portal_pwd_reset:${token}`);
      if (!email) return res.status(400).json({ error: 'This link has expired or is invalid.' });
      const userRes = await pool.query(`SELECT id FROM users WHERE email = $1`, [email]);
      if (!userRes.rows[0]) return res.status(400).json({ error: 'Account not found.' });
      await PortalAuthService.changePassword(userRes.rows[0].id, newPassword);
      await redis.del(`portal_pwd_reset:${token}`);
      res.json({ message: 'Password reset successfully. You can now log in.' });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  // -------------------------------------------------------------- dashboard

  static async dashboard(req: PortalRequest, res: Response) {
    const portal = req.portal!;
    try {
      if (portal.type === 'SPONSOR') {
        const sponsor = await SponsorService.findById(portal.id);
        if (!sponsor) return res.status(404).json({ error: 'Sponsor not found' });
        const [pending, redeemed, credited] = await Promise.all([
          pool.query(
            `SELECT COUNT(*)::int AS n FROM special_redemptions
             WHERE sponsor_id = $1 AND status = 'WAITING_FOR_SPONSOR'`,
            [portal.id],
          ),
          pool.query(
            `SELECT COUNT(*)::int AS n, COALESCE(SUM(calculated_discount_cents), 0)::bigint AS cents
             FROM special_redemptions
             WHERE sponsor_id = $1 AND status IN ('REWARD_COMPLETED','SPONSOR_VALIDATED','REWARD_SELECTED')`,
            [portal.id],
          ),
          pool.query(
            `SELECT COUNT(*)::int AS n, COALESCE(SUM(reward_amount_cents), 0)::bigint AS cents
             FROM special_redemptions
             WHERE sponsor_id = $1 AND status = 'REWARD_COMPLETED'`,
            [portal.id],
          ),
        ]);
        res.json({
          type: 'SPONSOR',
          sponsor: {
            id: sponsor.id,
            businessName: sponsor.business_name,
            businessType: sponsor.business_type,
            status: sponsor.status,
            remainingBudgetCents: cents(sponsor.remaining_budget_cents),
            usedBudgetCents: cents(sponsor.used_budget_cents),
          },
          stats: {
            pendingValidations: pending.rows[0].n,
            redeemedCount: redeemed.rows[0].n,
            redeemedDiscountCents: cents(redeemed.rows[0].cents),
            rewardAmountCents: cents(credited.rows[0].cents),
          },
        });
        return;
      }

      if (portal.type === 'PARTNER') {
        const partner = await PartnerService.getById(portal.id);
        if (!partner) return res.status(404).json({ error: 'Partner not found' });

        const usageRes = await pool.query(
          `SELECT COALESCE(COUNT(pu.id), 0)::int AS total_uses
           FROM promo_usage pu
           JOIN promo_codes pc ON pc.id = pu.promo_id
           WHERE pc.partner_id = $1 AND pu.status = 'USED'`,
          [portal.id],
        );
        const commissionsRes = await pool.query(
          `SELECT c.id, c.ride_id, c.promo_code, c.ride_price_cents, c.commission_cents,
                  c.commission_rate, c.status, c.created_at,
                  u.full_name AS rider_name
           FROM partner_commissions c
           LEFT JOIN rides r ON r.id = c.ride_id
           LEFT JOIN users u ON u.id = r.rider_id
           WHERE c.partner_id = $1
           ORDER BY c.created_at DESC
           LIMIT 10`,
          [portal.id],
        );

        res.json({
          type: 'PARTNER',
          partner: { id: partner.id, name: partner.name, status: partner.status, commissionRate: Number(partner.commission_rate) },
          usage: { total_uses: usageRes.rows[0].total_uses },
          earnings: {
            lifetimeEarningsCents: cents(partner.lifetime_earnings_cents),
            pendingEarningsCents: cents(partner.pending_earnings_cents),
            paidEarningsCents: cents(partner.paid_earnings_cents),
          },
          recentCommissions: commissionsRes.rows.map((c: any) => ({
            id: c.id,
            ride_id: c.ride_id,
            promo_code: c.promo_code,
            ride_price_cents: cents(c.ride_price_cents),
            commission_cents: cents(c.commission_cents),
            commission_rate: Number(c.commission_rate),
            status: c.status,
            rider_name: c.rider_name,
            created_at: c.created_at,
          })),
        });
        return;
      }

      // FLEET
      const [fleetRes, earningsRes, driversRes] = await Promise.all([
        pool.query(
          `SELECT id, name, contact_name, contact_email, platform_share_percent, is_active
           FROM fleet_partners WHERE id = $1`,
          [portal.id],
        ),
        pool.query(
          `SELECT
             COALESCE(SUM((s.fleet_allocations->0->>'cents')::bigint) FILTER (WHERE r.status = 'COMPLETED'), 0)::bigint AS lifetime_cents,
             COALESCE(SUM((s.fleet_allocations->0->>'cents')::bigint) FILTER (WHERE r.status = 'COMPLETED' AND r.completed_at >= NOW() - INTERVAL '30 days'), 0)::bigint AS last_30d_cents,
             COUNT(*) FILTER (WHERE r.status = 'COMPLETED')::int AS completed_rides,
             COUNT(*)::int AS total_rides
           FROM ride_price_snapshots s
           LEFT JOIN rides r ON r.id = s.ride_id
           WHERE s.driver_fleet_id = $1`,
          [portal.id],
        ),
        pool.query(
          `SELECT COUNT(*)::int AS n FROM drivers WHERE fleet_id = $1`,
          [portal.id],
        ),
      ]);
      const fleet = fleetRes.rows[0];
      if (!fleet) return res.status(404).json({ error: 'Fleet not found' });
      const earnings = earningsRes.rows[0];

      res.json({
        type: 'FLEET',
        fleet: {
          id: fleet.id,
          name: fleet.name,
          contact_name: fleet.contact_name,
          contact_email: fleet.contact_email,
          platformSharePercent: Number(fleet.platform_share_percent),
          is_active: fleet.is_active,
        },
        stats: {
          driverCount: driversRes.rows[0].n,
          completedRides: earnings.completed_rides,
          totalRides: earnings.total_rides,
          lifetimeEarningsCents: cents(earnings.lifetime_cents),
          last30dEarningsCents: cents(earnings.last_30d_cents),
        },
      });
    } catch (error: any) {
      console.error(`[PORTAL] ❌ Dashboard error: ${error.message}`);
      res.status(500).json({ error: 'Failed to load dashboard.' });
    }
  }

  // ------------------------------------------------------- partner reports

  static async usage(req: PortalRequest, res: Response) {
    if (req.portal!.type !== 'PARTNER') return res.status(403).json({ error: 'Partner account required.' });
    try {
      const partnerId = req.portal!.id;
      const page = Math.max(Number(req.query.page ?? 1), 1);
      const limit = Math.min(Math.max(Number(req.query.limit ?? 20), 1), 100);
      const offset = (page - 1) * limit;

      const [ridesRes, totalRes] = await Promise.all([
        pool.query(
          `SELECT r.id, r.status, r.promo_code, r.final_payment_cents, r.fare_amount,
                  r.created_at, u.full_name AS rider_name
           FROM rides r
           LEFT JOIN users u ON u.id = r.rider_id
           WHERE r.promo_id IN (SELECT id FROM promo_codes WHERE partner_id = $1)
             AND r.status = 'COMPLETED'
           ORDER BY r.created_at DESC
           LIMIT $2 OFFSET $3`,
          [partnerId, limit, offset],
        ),
        pool.query(
          `SELECT COUNT(*)::int AS n
           FROM rides r
           WHERE r.promo_id IN (SELECT id FROM promo_codes WHERE partner_id = $1)
             AND r.status = 'COMPLETED'`,
          [partnerId],
        ),
      ]);

      res.json({
        rides: ridesRes.rows.map((r: any) => ({
          id: r.id, status: r.status, promo_code: r.promo_code,
          final_payment_cents: cents(r.final_payment_cents),
          fare_amount: Number(r.fare_amount ?? 0),
          rider_name: r.rider_name, created_at: r.created_at,
        })),
        total: totalRes.rows[0].n, page, limit,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async earnings(req: PortalRequest, res: Response) {
    if (req.portal!.type !== 'PARTNER') return res.status(403).json({ error: 'Partner account required.' });
    try {
      const partnerId = req.portal!.id;
      const [earningsRes, recentRes] = await Promise.all([
        pool.query(
          `SELECT COALESCE(SUM(ft.driver_share_cents), 0)::bigint AS total_earnings_cents,
                  COALESCE(SUM(ft.tip_cents), 0)::bigint AS total_tip_cents,
                  COUNT(*)::int AS total_rides
           FROM financial_transactions ft
           JOIN rides r ON r.id = ft.ride_id
           WHERE ft.driver_id IS NOT NULL
             AND r.promo_id IN (SELECT id FROM promo_codes WHERE partner_id = $1)
             AND ft.status = 'SETTLED'`,
          [partnerId],
        ),
        pool.query(
          `SELECT ft.id, ft.ride_id, ft.fare_cents, ft.driver_share_cents, ft.tip_cents,
                  ft.status, ft.completed_at, r.promo_code, u.full_name AS rider_name
           FROM financial_transactions ft
           JOIN rides r ON r.id = ft.ride_id
           LEFT JOIN users u ON u.id = r.rider_id
           WHERE r.promo_id IN (SELECT id FROM promo_codes WHERE partner_id = $1)
             AND ft.status = 'SETTLED'
           ORDER BY ft.completed_at DESC
           LIMIT 10`,
          [partnerId],
        ),
      ]);
      const totals = earningsRes.rows[0];
      res.json({
        totals: {
          totalEarningsCents: cents(totals.total_earnings_cents),
          totalTipCents: cents(totals.total_tip_cents),
          totalRides: totals.total_rides,
        },
        recent: recentRes.rows.map((r: any) => ({
          id: r.id, ride_id: r.ride_id, promo_code: r.promo_code,
          fare_cents: cents(r.fare_cents), driver_share_cents: cents(r.driver_share_cents),
          tip_cents: cents(r.tip_cents), status: r.status, completed_at: r.completed_at,
          rider_name: r.rider_name,
        })),
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async commission(req: PortalRequest, res: Response) {
    if (req.portal!.type !== 'PARTNER') return res.status(403).json({ error: 'Partner account required.' });
    try {
      const partner = await PartnerService.getById(req.portal!.id);
      if (!partner) return res.status(404).json({ error: 'Partner not found' });
      res.json({
        commission_rate: Number(partner.commission_rate),
        commission_type: 'Percentage',
        lifetimeEarningsCents: cents(partner.lifetime_earnings_cents),
        pendingEarningsCents: cents(partner.pending_earnings_cents),
        paidEarningsCents: cents(partner.paid_earnings_cents),
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  // --------------------------------------------------------- fleet reports

  static async fleetDrivers(req: PortalRequest, res: Response) {
    if (req.portal!.type !== 'FLEET') return res.status(403).json({ error: 'Fleet account required.' });
    try {
      const r = await pool.query(
        `SELECT d.user_id, u.full_name, u.email, u.phone_number, u.rating,
                d.is_active, d.total_rides, d.background_check_status
         FROM drivers d
         JOIN users u ON u.id = d.user_id
         WHERE d.fleet_id = $1
         ORDER BY u.full_name`,
        [req.portal!.id],
      );
      res.json({
        drivers: r.rows.map((d: any) => ({
          id: d.user_id, full_name: d.full_name, email: d.email,
          phone_number: d.phone_number, rating: Number(d.rating ?? 0),
          is_active: d.is_active, total_rides: d.total_rides,
          background_check_status: d.background_check_status,
        })),
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }

  static async fleetRides(req: PortalRequest, res: Response) {
    if (req.portal!.type !== 'FLEET') return res.status(403).json({ error: 'Fleet account required.' });
    try {
      const limit = Math.min(Math.max(Number(req.query.limit ?? 20), 1), 100);
      const r = await pool.query(
        `SELECT r.id, r.status, r.pickup_address, r.destination_address, r.completed_at,
                (s.fleet_allocations->0->>'cents')::bigint AS fleet_earnings_cents,
                u.full_name AS driver_name
         FROM ride_price_snapshots s
         JOIN rides r ON r.id = s.ride_id
         LEFT JOIN users u ON u.id = r.driver_id
         WHERE s.driver_fleet_id = $1
         ORDER BY r.completed_at DESC NULLS LAST, r.created_at DESC
         LIMIT $2`,
        [req.portal!.id, limit],
      );
      res.json({
        rides: r.rows.map((x: any) => ({
          id: x.id, status: x.status, pickup_address: x.pickup_address,
          destination_address: x.destination_address, completed_at: x.completed_at,
          fleet_earnings_cents: cents(x.fleet_earnings_cents), driver_name: x.driver_name,
        })),
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
}