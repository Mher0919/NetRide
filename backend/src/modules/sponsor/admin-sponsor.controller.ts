// backend/src/modules/sponsor/admin-sponsor.controller.ts
//
// ADMIN SPONSORS API — CRUD, budget ledger, financial history (60/40),
// analytics, portal account management. Sponsors see only their own data;
// admins see everything (spec §53-62).

import { Request, Response } from 'express';
import { pool } from '../../config/database';
import { centsValue } from '../../services/financial-ledger.service';
import { SponsorService, discountLabelFor, SponsorStatus } from './sponsor.service';
import { SpecialRedemptionService } from './special-redemption.service';

interface AdminReq extends Request {
  user?: { id: string; role: string; email: string };
}

const VALID_BUSINESS_TYPES = [
  'RESTAURANT', 'CAFE', 'RETAIL', 'BAR', 'SERVICES', 'MEDICAL', 'AUTO', 'OTHER',
];

export class AdminSponsorController {
  // ---------------------------------------------------------------- CRUD

  static async list(req: AdminReq, res: Response) {
    try {
      const { rows, total } = await SponsorService.listSponsors({
        search: String(req.query.search ?? ''),
        status: String(req.query.status ?? ''),
        limit: Number(req.query.limit ?? 50),
        offset: Number(req.query.offset ?? 0),
      });
      res.json({ sponsors: rows.map((s) => ({
        ...s,
        discountLabel: discountLabelFor(s),
        spendableCents: s.remaining_budget_cents - s.reserved_budget_cents,
      })), total });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  static async getOne(req: AdminReq, res: Response) {
    try {
      const sponsor = await SponsorService.findById(req.params.id);
      if (!sponsor) return res.status(404).json({ error: 'Sponsor not found' });
      const portal = await SponsorService.getPortalAccountForSponsor(sponsor.id);
      const [ledger, financial, analytics] = await Promise.all([
        SponsorService.getLedger(sponsor.id, { limit: 100 }),
        SponsorService.getFinancialHistory(sponsor.id, { limit: 50 }),
        SponsorService.getAnalytics(sponsor.id,
          new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
          new Date()),
      ]);
      res.json({
        sponsor: {
          ...sponsor,
          discountLabel: discountLabelFor(sponsor),
          spendableCents: sponsor.remaining_budget_cents - sponsor.reserved_budget_cents,
        },
        portalAccount: portal ? {
          email: portal.email,
          isActive: portal.is_active,
          mustChangePassword: portal.must_change_password,
          lastLoginAt: portal.last_login_at,
        } : null,
        ledger,
        financialHistory: financial,
        analytics,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  static async create(req: AdminReq, res: Response) {
    try {
      const b = req.body ?? {};
      if (!b.businessName?.trim()) return res.status(400).json({ error: 'Business name is required' });
      if (!['PERCENTAGE', 'FIXED_AMOUNT'].includes(b.discountType)) {
        return res.status(400).json({ error: 'Invalid discount type' });
      }
      if (b.businessType && !VALID_BUSINESS_TYPES.includes(String(b.businessType).toUpperCase())) {
        return res.status(400).json({ error: 'Invalid business type' });
      }
      if (b.discountType === 'PERCENTAGE') {
        const pct = Number(b.discountPercent);
        if (!(pct > 0 && pct <= 100)) return res.status(400).json({ error: 'Discount percent must be > 0 and <= 100' });
      } else {
        const cents = Math.round(Number(b.discountFixedAmountCents ?? 0));
        if (!(cents > 0)) return res.status(400).json({ error: 'Fixed discount must be > $0' });
      }
      const budget = Math.round(Number(b.initialBudgetCents ?? 0));
      if (!(budget >= 0)) return res.status(400).json({ error: 'Budget must be >= 0' });

      const sponsor = await SponsorService.create({
        businessName: b.businessName,
        businessType: b.businessType,
        businessDescription: b.businessDescription,
        managerName: b.managerName,
        phone: b.phone,
        email: b.email,
        otherContactInfo: b.otherContactInfo,
        address: b.address,
        city: b.city,
        state: b.state,
        postalCode: b.postalCode,
        country: b.country,
        latitude: b.latitude ?? null,
        longitude: b.longitude ?? null,
        logoUrl: b.logoUrl ?? null,
        coverImageUrl: b.coverImageUrl ?? null,
        discountType: b.discountType,
        discountPercent: b.discountPercent,
        maxDiscountPercent: b.maxDiscountPercent,
        discountFixedAmountCents: b.discountFixedAmountCents,
        initialBudgetCents: budget,
        createdByAdminId: req.user!.id,
      }, { id: req.user!.id, role: 'ADMIN' });
      res.status(201).json({ sponsor });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }

  static async update(req: AdminReq, res: Response) {
    try {
      const b = req.body ?? {};
      const patch: Record<string, unknown> = {};
      const map: Record<string, string> = {
        businessName: 'business_name',
        businessDescription: 'business_description',
        managerName: 'manager_name',
        phone: 'phone',
        email: 'email',
        otherContactInfo: 'other_contact_info',
        address: 'address',
        city: 'city',
        state: 'state',
        postalCode: 'postal_code',
        country: 'country',
        latitude: 'latitude',
        longitude: 'longitude',
        logoUrl: 'logo_url',
        coverImageUrl: 'cover_image_url',
        specialsEnabled: 'specials_enabled',
        mapListingEnabled: 'map_listing_enabled',
      };
      for (const [k, col] of Object.entries(map)) {
        if (b[k] !== undefined) patch[col] = b[k];
      }
      if (b.discountType) patch.discount_type = b.discountType;
      if (b.discountPercent !== undefined) patch.discount_percent = b.discountPercent;
      if (b.maxDiscountPercent !== undefined) patch.max_discount_percent = b.maxDiscountPercent;
      if (b.discountFixedAmountCents !== undefined) patch.discount_fixed_amount_cents = b.discountFixedAmountCents;

      const sponsor = await SponsorService.update(req.params.id, patch);
      if (!sponsor) return res.status(404).json({ error: 'Sponsor not found' });
      res.json({ sponsor });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }

  static async setStatus(req: AdminReq, res: Response) {
    try {
      const status = String(req.params.status).toUpperCase() as SponsorStatus;
      const sponsor = await SponsorService.setStatus(req.params.id, status, { id: req.user!.id, role: 'ADMIN' });
      res.json({ sponsor });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }

  // ---------------------------------------------------------------- budget

  static async adjustBudget(req: AdminReq, res: Response) {
    try {
      const deltaCents = Math.round(Number(req.body?.deltaCents ?? 0));
      const reason = String(req.body?.reason ?? '');
      const sponsor = await SponsorService.adjustBudget(req.params.id, deltaCents, reason, { id: req.user!.id, role: 'ADMIN' });
      res.json({ sponsor });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }

  static async getLedger(req: AdminReq, res: Response) {
    try {
      const ledger = await SponsorService.getLedger(req.params.id, {
        limit: Number(req.query.limit ?? 100),
        offset: Number(req.query.offset ?? 0),
      });
      res.json({ ledger });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  static async getFinancialHistory(req: AdminReq, res: Response) {
    try {
      const history = await SponsorService.getFinancialHistory(req.params.id, {
        limit: Number(req.query.limit ?? 50),
        offset: Number(req.query.offset ?? 0),
      });
      res.json({ history });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  static async getAnalytics(req: AdminReq, res: Response) {
    try {
      const days = Math.min(Math.max(Number(req.query.days ?? 90), 1), 365);
      const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const analytics = await SponsorService.getAnalytics(req.params.id, from, new Date());
      res.json({ days, analytics });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  // ------------------------------------------------------- portal accounts

  static async createPortalAccount(req: AdminReq, res: Response) {
    try {
      const { email, password } = req.body ?? {};
      if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
      const result = await SponsorService.createPortalAccount(
        req.params.id,
        email,
        password,
        { id: req.user!.id, role: 'ADMIN' },
      );
      res.status(201).json({ message: 'Portal account ready', email, temporaryPassword: result.password });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }

  static async resetPortalPassword(req: AdminReq, res: Response) {
    try {
      const password = String(req.body?.password ?? '');
      const result = await SponsorService.resetPortalPassword(req.params.id, password, { id: req.user!.id, role: 'ADMIN' });
      res.json({ message: 'Password reset', temporaryPassword: result.password });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }

  static async disablePortalAccount(req: AdminReq, res: Response) {
    try {
      await SponsorService.disablePortalAccount(req.params.id, { id: req.user!.id, role: 'ADMIN' });
      res.json({ message: 'Portal account disabled' });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }

  // ------------------------------------------------------------- redemptions

  static async listRedemptions(req: AdminReq, res: Response) {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 200);
      const offset = Math.max(Number(req.query.offset ?? 0), 0);
      const status = String(req.query.status ?? '');
      const params: unknown[] = [];
      let where = '1=1';
      if (status) {
        params.push(status.toUpperCase());
        where = `sr.status = $${params.length}`;
      }
      params.push(limit, offset);
      const resq = await pool.query(
        `SELECT sr.id, sr.status, sr.sponsor_name, sr.sponsor_id,
                sr.rider_id, sr.driver_id, sr.ride_id, sr.discount_label,
                sr.calculated_discount_cents, sr.reward_choice,
                sr.reward_amount_cents, sr.sponsor_funded_cents,
                sr.driver_allocation_cents, sr.netride_allocation_cents,
                sr.netride_bonus_cents, sr.ride_requested_at,
                sr.ride_completed_at, sr.sponsor_validated_at,
                sr.reward_processed_at, sr.cancellation_reason_code,
                sr.cancellation_reason_text, sr.reward_failed_reason,
                sr.created_at,
                u.full_name AS rider_name
         FROM special_redemptions sr
         JOIN users u ON u.id = sr.rider_id
         WHERE ${where}
         ORDER BY sr.created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      res.json({ redemptions: resq.rows.map((r: any) => ({
        ...r,
        calculated_discount_cents: centsValue(r.calculated_discount_cents),
        reward_amount_cents: centsValue(r.reward_amount_cents),
        sponsor_funded_cents: centsValue(r.sponsor_funded_cents),
        driver_allocation_cents: centsValue(r.driver_allocation_cents),
        netride_allocation_cents: centsValue(r.netride_allocation_cents),
        netride_bonus_cents: centsValue(r.netride_bonus_cents),
      })) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }
}