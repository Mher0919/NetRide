// backend/src/modules/sponsor/sponsor-portal.controller.ts
//
// SPONSOR PORTAL API — a sponsor sees ONLY their own data. Every handler
// scopes queries by req.sponsor.id (the JWT sponsorId claim), so sponsor A
// can never read sponsor B's customers or validations (spec §78-80).

import { Request, Response } from 'express';
import { pool } from '../../config/database';
import { centsValue } from '../../services/financial-ledger.service';
import { SponsorService, discountLabelFor } from './sponsor.service';
import { SponsorAuthService } from './sponsor-auth.service';
import { SpecialRedemptionService } from './special-redemption.service';
import { OTPService } from '../auth/otp.service';

export interface SponsorRequest extends Request {
  user?: { id: string; role: string; email: string };
  sponsor?: { id: string; userId: string; email: string };
}

const VALIDATION_BATCH_SIZE = 50;

export class SponsorPortalController {
  // --------------------------------------------------------------- auth

  static async login(req: Request, res: Response) {
    try {
      const { email, password } = req.body ?? {};
      const session = await SponsorAuthService.login(email, password);
      res.json(session);
    } catch (err: any) {
      res.status(401).json({ error: err.message });
    }
  }

  static async refresh(req: Request, res: Response) {
    try {
      const { refreshToken } = req.body ?? {};
      if (!refreshToken) return res.status(400).json({ error: 'Refresh token is required' });
      const result = await SponsorAuthService.refreshToken(refreshToken);
      res.json(result);
    } catch (err: any) {
      res.status(401).json({ error: err.message });
    }
  }

  static async logout(req: Request, res: Response) {
    try {
      const { refreshToken } = req.body ?? {};
      if (refreshToken) await SponsorAuthService.invalidateRefreshToken(refreshToken);
      res.json({ message: 'Logged out' });
    } catch (err: any) {
      res.status(200).json({ message: 'Logged out' });
    }
  }

  static async changePassword(req: SponsorRequest, res: Response) {
    try {
      await SponsorAuthService.changePassword(req.user!.id, req.body?.newPassword);
      res.json({ message: 'Password updated. Please log in again.' });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }

  // --------------------------------------------------------- forgot password

  static async forgotPassword(req: Request, res: Response) {
    try {
      const email = String(req.body?.email ?? '').trim().toLowerCase();
      if (!email) return res.status(400).json({ error: 'Email is required' });

      const userRes = await pool.query(
        `SELECT id, email FROM users WHERE email = $1 AND role = 'SPONSOR' AND is_active = TRUE`,
        [email],
      );
      if (userRes.rows.length === 0) {
        res.json({ message: 'If an account with that email exists, a verification code has been sent.' });
        return;
      }

      await OTPService.generateOTP(email);
      res.json({ message: 'If an account with that email exists, a verification code has been sent.' });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to send verification code' });
    }
  }

  static async verifyResetOTP(req: Request, res: Response) {
    try {
      const email = String(req.body?.email ?? '').trim().toLowerCase();
      const code = String(req.body?.code ?? '');
      if (!email || !code) return res.status(400).json({ error: 'Email and code are required' });

      const valid = await OTPService.verifyOTP(email, code);
      if (!valid) return res.status(400).json({ error: 'Invalid or expired verification code' });

      const resetToken = (await import('crypto')).randomUUID();
      const redis = (await import('../../config/redis')).redis;
      await redis.set(`sponsor_pwd_reset:${resetToken}`, email, 'EX', 3600);

      res.json({ message: 'Code verified', resetToken });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }

  static async resetPassword(req: Request, res: Response) {
    try {
      const { resetToken, newPassword } = req.body ?? {};
      if (!resetToken || !newPassword) return res.status(400).json({ error: 'Reset token and new password are required' });
      if (String(newPassword).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

      const redis = (await import('../../config/redis')).redis;
      const email = await redis.get(`sponsor_pwd_reset:${resetToken}`);
      if (!email) return res.status(400).json({ error: 'Invalid or expired reset token' });

      const userRes = await pool.query(
        `SELECT id FROM users WHERE email = $1 AND role = 'SPONSOR'`,
        [email],
      );
      if (userRes.rows.length === 0) return res.status(400).json({ error: 'Account not found' });

      await SponsorAuthService.changePassword(userRes.rows[0].id, newPassword);
      await redis.del(`sponsor_pwd_reset:${resetToken}`);

      res.json({ message: 'Password reset successful. Please log in with your new password.' });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }

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
}