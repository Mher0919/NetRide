// backend/src/modules/admin/admin-rewards.controller.ts
//
// ADMIN API for the Partner / Promo / Referral / Credits ecosystem.
// Mounted at /api/admin behind authMiddleware + adminMiddleware.

import { Response } from 'express';
import { z } from 'zod';
import { pool } from '../../config/database';
import { PartnerService } from '../partner/partner.service';
import { CreditsService } from '../credits/credits.service';
import { ReferralService } from '../referral/referral.service';
import { AuditEventsService } from '../../services/audit-events.service';

const PartnerBaseSchema = z.object({
  name: z.string().trim().min(2).max(200),
  business_type: z.string().trim().min(1).max(50),
  address: z.string().trim().max(500).optional().nullable(),
  contact_name: z.string().trim().max(200).optional().nullable(),
  contact_phone: z.string().trim().max(30).optional().nullable(),
  contact_email: z.string().trim().email().optional().nullable(),
  // How the portal login is resolved: NEW creates a fresh user (email +
  // password required), EXISTING links an already-existing user (user_id
  // required) so the same person can be both partner and sponsor.
  user_mode: z.enum(['NEW', 'EXISTING']).default('NEW'),
  user_id: z.string().uuid().optional().nullable(),
  email: z.string().trim().email().optional().nullable(),
  password: z.string().min(8).optional().nullable(),
  commission_rate: z.number().min(0).max(1).default(0.10),
  notes: z.string().max(2000).optional().nullable(),
});

const PartnerCreateSchema = PartnerBaseSchema.superRefine((value, ctx) => {
  if (value.user_mode === 'EXISTING') {
    if (!value.user_id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['user_id'], message: 'Select an existing user to link.' });
    }
  } else {
    if (!value.email) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['email'], message: 'A login email is required.' });
    }
    if (!value.password) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['password'], message: 'A login password is required.' });
    }
  }
});

const PartnerUpdateSchema = PartnerBaseSchema.partial().partial();

const PromoCreateSchema = z.object({
  code: z.string().trim().min(2).max(32).transform((v) => v.toUpperCase()),
  partner_id: z.string().uuid().nullable().optional(),
  discount_type: z.enum(['PERCENTAGE', 'FIXED']),
  discount_value: z.number().positive().max(100),
  max_uses: z.number().int().min(0).default(0),
  expires_at: z.string().datetime().nullable().optional(),
  active: z.boolean().default(true),
  min_ride_fare_cents: z.number().int().min(0).default(0),
  max_discount_cents: z.number().int().min(0).default(0),
  single_use_per_rider: z.boolean().default(true),
});

const PromoUpdateSchema = PromoCreateSchema.partial().omit({ code: true });

const GrantCreditsSchema = z.object({
  user_id: z.string().uuid(),
  amount_cents: z.number().int().min(1).max(100_000_000),
  reason: z.string().trim().min(3).max(500),
});

const COMMISSION_STATUSES = ['PENDING', 'PAID', 'VOID', ''] as const;

function csvEscape(v: unknown): string {
  const s = String(v ?? '');
  return `"${s.replace(/"/g, '""')}"`;
}

function toCsv(headers: string[], rows: unknown[][]): string {
  return [headers.map(csvEscape).join(','), ...rows.map((r) => r.map(csvEscape).join(','))].join('\n');
}

export class AdminRewardsController {
  // -------------------------------------------------------------------------
  // PARTNERS
  // -------------------------------------------------------------------------

  static async listPartners(req: any, res: Response) {
    try {
      const limit = parseInt(req.query.limit ?? '50');
      const offset = parseInt(req.query.offset ?? '0');
      const partners = await PartnerService.list(req.query.search ?? '', req.query.status ?? '', limit, offset);
      res.json({ partners });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Unable to list partners' });
    }
  }

  static async createPartner(req: any, res: Response) {
    try {
      const input = PartnerCreateSchema.parse(req.body);
      const partner = await PartnerService.create(input, req.user.id);
      res.status(201).json(partner);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Unable to create partner' });
    }
  }

  /**
   * Search users that can be linked to a new partner / sponsor dashboard.
   * Returns which portal accounts each user already owns so the admin can
   * confidently pick the same identity (one email may be both).
   */
  static async searchPortalUsers(req: any, res: Response) {
    try {
      const search = String(req.query.search ?? '').trim();
      const limit = Math.min(Math.max(parseInt(req.query.limit ?? '20', 10) || 20, 1), 50);
      const result = await pool.query(
        `SELECT u.id, u.email, u.full_name, u.role, u.is_active,
                EXISTS(SELECT 1 FROM partners p WHERE p.user_id = u.id) AS is_partner,
                EXISTS(SELECT 1 FROM sponsor_portal_accounts spa WHERE spa.user_id = u.id) AS is_sponsor,
                EXISTS(SELECT 1 FROM fleet_portal_accounts fpa WHERE fpa.user_id = u.id) AS is_fleet
         FROM users u
         WHERE ($1 = '' OR u.email ILIKE '%' || $1 || '%' OR u.full_name ILIKE '%' || $1 || '%')
         ORDER BY u.created_at DESC
         LIMIT $2`,
        [search, limit],
      );
      res.json({ users: result.rows });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Unable to search users' });
    }
  }

  static async getPartner(req: any, res: Response) {
    try {
      const partner = await PartnerService.getById(req.params.id);
      if (!partner) return res.status(404).json({ error: 'Partner not found' });
      const stats = await PartnerService.stats(req.params.id);
      res.json(stats);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Unable to load partner' });
    }
  }

  static async updatePartner(req: any, res: Response) {
    try {
      const input = PartnerUpdateSchema.parse(req.body);
      const partner = await PartnerService.update(req.params.id, input, req.user.id);
      res.json(partner);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Unable to update partner' });
    }
  }

  static async setPartnerStatus(req: any, res: Response) {
    try {
      const status = req.params.status.toUpperCase();
      const partner = await PartnerService.setStatus(req.params.id, status, req.user.id);
      res.json(partner);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Unable to update partner status' });
    }
  }

  static async deletePartner(req: any, res: Response) {
    try {
      const result = await PartnerService.remove(req.params.id, req.user.id);
      res.json(result);
    } catch (err: any) {
      const notFound = err.message === 'Partner not found';
      res.status(notFound ? 404 : 400).json({ error: err.message || 'Unable to delete partner' });
    }
  }

  static async listPartnerCommissions(req: any, res: Response) {
    try {
      const limit = parseInt(req.query.limit ?? '50');
      const offset = parseInt(req.query.offset ?? '0');
      const commissions = await PartnerService.commissions(
        req.params.id,
        req.query.status ?? '',
        limit,
        offset,
      );
      res.json({ commissions });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Unable to list commissions' });
    }
  }

  static async markCommissionPaid(req: any, res: Response) {
    try {
      const reference = String(req.body.reference ?? '').trim();
      const result = await PartnerService.markCommissionPaid(req.params.commissionId, reference, req.user.id);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Unable to mark commission paid' });
    }
  }

  static async exportPartners(_req: any, res: Response) {
    try {
      const rows = await pool.query(
        `SELECT p.*, (SELECT COUNT(*)::int FROM promo_codes pc WHERE pc.partner_id = p.id) AS promo_count
         FROM partners p ORDER BY p.created_at DESC`,
      );
      const csv = toCsv(
        ['ID', 'Name', 'Type', 'Status', 'Commission %', 'Address', 'Contact', 'Phone', 'Email',
         'Lifetime Earnings ($)', 'Pending ($)', 'Paid ($)', 'Referred Rides', 'Promos', 'Created'],
        rows.rows.map((r: any) => [
          r.id, r.name, r.business_type, r.status, (Number(r.commission_rate) * 100).toFixed(2),
          r.address, r.contact_name, r.contact_phone, r.contact_email,
          (Number(r.lifetime_earnings_cents) / 100).toFixed(2),
          (Number(r.pending_earnings_cents) / 100).toFixed(2),
          (Number(r.paid_earnings_cents) / 100).toFixed(2),
          r.total_referred_rides, r.promo_count, r.created_at.toISOString(),
        ]),
      );
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="partners.csv"');
      res.send(csv);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Unable to export partners' });
    }
  }

  static async exportPartnerRides(req: any, res: Response) {
    try {
      const rows = await pool.query(
        `SELECT r.id, r.promo_code, r.final_payment_cents, r.fare_amount, r.status,
                r.created_at, u.full_name AS rider_name, u.email AS rider_email
         FROM rides r
         LEFT JOIN users u ON u.id = r.rider_id
         WHERE r.promo_id IN (SELECT id FROM promo_codes WHERE partner_id = $1)
         ORDER BY r.created_at DESC`,
        [req.params.id],
      );
      const csv = toCsv(
        ['Ride ID', 'Promo', 'Fare ($)', 'Final Payment ($)', 'Status', 'Rider', 'Email', 'Requested'],
        rows.rows.map((r: any) => [
          r.id, r.promo_code, Number(r.fare_amount ?? 0).toFixed(2),
          (Number(r.final_payment_cents ?? 0) / 100).toFixed(2),
          r.status, r.rider_name, r.rider_email, r.created_at.toISOString(),
        ]),
      );
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="partner-rides.csv"');
      res.send(csv);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Unable to export partner rides' });
    }
  }

  // -------------------------------------------------------------------------
  // PROMO CODES
  // -------------------------------------------------------------------------

  static async listPromos(req: any, res: Response) {
    try {
      const limit = parseInt(req.query.limit ?? '50');
      const offset = parseInt(req.query.offset ?? '0');
      const rows = await pool.query(
        `SELECT p.*, pt.name AS partner_name, pt.status AS partner_status
         FROM promo_codes p
         LEFT JOIN partners pt ON pt.id = p.partner_id
         WHERE ($1 = '' OR p.code ILIKE '%' || $1 || '%')
           AND ($2 = '' OR p.partner_id::text = $2)
           AND ($3 = '' OR p.active = ($3 = 'true'))
         ORDER BY p.created_at DESC
         LIMIT $4 OFFSET $5`,
        [req.query.search ?? '', req.query.partnerId ?? '', req.query.active ?? '', limit, offset],
      );
      res.json({ promos: rows.rows.map(normalizePromoRow) });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Unable to list promos' });
    }
  }

  static async getPromo(req: any, res: Response) {
    try {
      const rows = await pool.query(
        `SELECT p.*, pt.name AS partner_name, pt.status AS partner_status
         FROM promo_codes p
         LEFT JOIN partners pt ON pt.id = p.partner_id
         WHERE p.id = $1`,
        [req.params.id],
      );
      if (rows.rows.length === 0) return res.status(404).json({ error: 'Promo not found' });
      const usage = await pool.query(
        `SELECT pu.id, pu.ride_id, pu.rider_id, pu.discount_cents, pu.rider_paid_cents,
                pu.status, pu.created_at, pu.completed_at, u.full_name AS rider_name, u.email AS rider_email
         FROM promo_usage pu
         LEFT JOIN users u ON u.id = pu.rider_id
         WHERE pu.promo_id = $1
         ORDER BY pu.created_at DESC
         LIMIT 200`,
        [req.params.id],
      );
      res.json({
        promo: normalizePromoRow(rows.rows[0]),
        usage: usage.rows.map((r: any) => ({
          ...r,
          discount_cents: Number(r.discount_cents),
          rider_paid_cents: Number(r.rider_paid_cents),
        })),
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Unable to load promo' });
    }
  }

  static async createPromo(req: any, res: Response) {
    try {
      const input = PromoCreateSchema.parse(req.body);
      if (input.partner_id) {
        const partner = await PartnerService.getById(input.partner_id);
        if (!partner) return res.status(404).json({ error: 'Partner not found' });
        if (partner.status !== 'ACTIVE') {
          return res.status(400).json({ error: 'Only active partners can own promos' });
        }
      }
      const rows = await pool.query(
        `INSERT INTO promo_codes
           (code, partner_id, discount_type, discount_value, max_uses, expires_at,
            active, min_ride_fare_cents, max_discount_cents, single_use_per_rider)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [
          input.code, input.partner_id ?? null, input.discount_type, input.discount_value,
          input.max_uses, input.expires_at ? new Date(input.expires_at) : null,
          input.active, input.min_ride_fare_cents, input.max_discount_cents,
          input.single_use_per_rider,
        ],
      );
      await AuditEventsService.record({
        actorId: req.user.id,
        actorRole: 'ADMIN',
        action: 'PROMO_CREATED',
        entityType: 'PROMO',
        entityId: rows.rows[0].id,
        details: { code: input.code, discount_type: input.discount_type, discount_value: input.discount_value },
      });
      res.status(201).json(normalizePromoRow(rows.rows[0]));
    } catch (err: any) {
      if (err?.code === '23505') {
        return res.status(400).json({ error: 'A promo with this code already exists' });
      }
      res.status(400).json({ error: err.message || 'Unable to create promo' });
    }
  }

  static async updatePromo(req: any, res: Response) {
    try {
      const input = PromoUpdateSchema.parse(req.body);
      const existing = await pool.query(`SELECT * FROM promo_codes WHERE id = $1`, [req.params.id]);
      if (existing.rows.length === 0) return res.status(404).json({ error: 'Promo not found' });

      const merged = { ...existing.rows[0], ...input };
      const rows = await pool.query(
        `UPDATE promo_codes SET
           partner_id = $1, discount_type = $2, discount_value = $3, max_uses = $4,
           expires_at = $5, active = $6, min_ride_fare_cents = $7,
           max_discount_cents = $8, single_use_per_rider = $9, updated_at = NOW()
         WHERE id = $10
         RETURNING *`,
        [
          merged.partner_id ?? null, merged.discount_type, merged.discount_value,
          merged.max_uses, merged.expires_at ? new Date(merged.expires_at) : null,
          merged.active, merged.min_ride_fare_cents, merged.max_discount_cents,
          merged.single_use_per_rider, req.params.id,
        ],
      );
      await AuditEventsService.record({
        actorId: req.user.id,
        actorRole: 'ADMIN',
        action: 'PROMO_UPDATED',
        entityType: 'PROMO',
        entityId: req.params.id,
        details: { changed: Object.keys(input) },
      });
      res.json(normalizePromoRow(rows.rows[0]));
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Unable to update promo' });
    }
  }

  static async deletePromo(req: any, res: Response) {
    try {
      const rows = await pool.query(`DELETE FROM promo_codes WHERE id = $1 RETURNING id, code`, [req.params.id]);
      if (rows.rows.length === 0) return res.status(404).json({ error: 'Promo not found' });
      await AuditEventsService.record({
        actorId: req.user.id,
        actorRole: 'ADMIN',
        action: 'PROMO_DELETED',
        entityType: 'PROMO',
        entityId: req.params.id,
        details: { code: rows.rows[0].code },
      });
      res.json({ deleted: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Unable to delete promo' });
    }
  }

  static async setPromoActive(req: any, res: Response) {
    try {
      const active = req.params.active === 'activate';
      const rows = await pool.query(
        `UPDATE promo_codes SET active = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
        [active, req.params.id],
      );
      if (rows.rows.length === 0) return res.status(404).json({ error: 'Promo not found' });
      await AuditEventsService.record({
        actorId: req.user.id,
        actorRole: 'ADMIN',
        action: active ? 'PROMO_ACTIVATED' : 'PROMO_DEACTIVATED',
        entityType: 'PROMO',
        entityId: req.params.id,
      });
      res.json(normalizePromoRow(rows.rows[0]));
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Unable to update promo' });
    }
  }

  static async clonePromo(req: any, res: Response) {
    try {
      const rows = await pool.query(`SELECT * FROM promo_codes WHERE id = $1`, [req.params.id]);
      if (rows.rows.length === 0) return res.status(404).json({ error: 'Promo not found' });
      const p = rows.rows[0];
      const newCode = `${p.code}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      const created = await pool.query(
        `INSERT INTO promo_codes
           (code, partner_id, discount_type, discount_value, max_uses, expires_at,
            active, min_ride_fare_cents, max_discount_cents, single_use_per_rider, usage_rule)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [
          newCode, p.partner_id, p.discount_type, p.discount_value, p.max_uses,
          p.expires_at, p.active, p.min_ride_fare_cents, p.max_discount_cents,
          p.single_use_per_rider, p.usage_rule,
        ],
      );
      await AuditEventsService.record({
        actorId: req.user.id,
        actorRole: 'ADMIN',
        action: 'PROMO_CLONED',
        entityType: 'PROMO',
        entityId: created.rows[0].id,
        details: { source_promo_id: req.params.id, code: newCode },
      });
      res.status(201).json(normalizePromoRow(created.rows[0]));
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Unable to clone promo' });
    }
  }

  // -------------------------------------------------------------------------
  // REFERRALS
  // -------------------------------------------------------------------------

  static async referralStats(_req: any, res: Response) {
    try {
      const stats = await ReferralService.adminStats();
      res.json(stats);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Unable to load referral stats' });
    }
  }

  static async listReferrals(req: any, res: Response) {
    try {
      const limit = parseInt(req.query.limit ?? '50');
      const offset = parseInt(req.query.offset ?? '0');
      const rows = await ReferralService.adminList(req.query.status ?? '', req.query.search ?? '', limit, offset);
      res.json({ relationships: rows });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Unable to list referrals' });
    }
  }

  static async referralAbuse(_req: any, res: Response) {
    try {
      const rows = await ReferralService.adminAbuse();
      res.json({ flags: rows });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Unable to load referral abuse flags' });
    }
  }

  // -------------------------------------------------------------------------
  // RIDE CREDITS (admin)
  // -------------------------------------------------------------------------

  static async listCreditAccounts(req: any, res: Response) {
    try {
      const limit = parseInt(req.query.limit ?? '50');
      const offset = parseInt(req.query.offset ?? '0');
      const rows = await CreditsService.listAccountsAdmin(req.query.search ?? '', limit, offset);
      res.json({ accounts: rows });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Unable to list credit accounts' });
    }
  }

  static async grantCredits(req: any, res: Response) {
    try {
      const input = GrantCreditsSchema.parse(req.body);
      const user = await pool.query(`SELECT id FROM users WHERE id = $1`, [input.user_id]);
      if (user.rows.length === 0) return res.status(404).json({ error: 'User not found' });
      const result = await CreditsService.adminGrant(req.user.id, input.user_id, input.amount_cents, input.reason);
      await AuditEventsService.record({
        actorId: req.user.id,
        actorRole: 'ADMIN',
        action: 'CREDITS_GRANTED',
        entityType: 'RIDER_CREDIT',
        entityId: input.user_id,
        details: { amount_cents: input.amount_cents, reason: input.reason, balance_cents: result.balance_cents },
      });
      res.status(201).json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Unable to grant credits' });
    }
  }

  static async creditTransactionsAdmin(req: any, res: Response) {
    try {
      const limit = parseInt(req.query.limit ?? '50');
      const offset = parseInt(req.query.offset ?? '0');
      const rows = await pool.query(
        `SELECT ct.*, u.full_name AS user_name, u.email AS user_email
         FROM credit_transactions ct
         LEFT JOIN users u ON u.id = ct.user_id
         WHERE ($1 = '' OR ct.user_id::text = $1)
           AND ($2 = '' OR ct.type = $2)
         ORDER BY ct.created_at DESC
         LIMIT $3 OFFSET $4`,
        [req.query.userId ?? '', req.query.type ?? '', limit, offset],
      );
      res.json({
        transactions: rows.rows.map((r: any) => ({
          ...r,
          amount_cents: Number(r.amount_cents),
          balance_after_cents: Number(r.balance_after_cents),
        })),
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Unable to load credit ledger' });
    }
  }

  // -------------------------------------------------------------------------
  // LEDGERS
  // -------------------------------------------------------------------------

  static async commissionLedger(req: any, res: Response) {
    try {
      const limit = parseInt(req.query.limit ?? '50');
      const offset = parseInt(req.query.offset ?? '0');
      const status = COMMISSION_STATUSES.includes(req.query.status) ? req.query.status : '';
      const rows = await pool.query(
        `SELECT c.*, pt.name AS partner_name, pt.business_type,
                u.full_name AS rider_name, r.created_at AS ride_created_at
         FROM partner_commissions c
         LEFT JOIN partners pt ON pt.id = c.partner_id
         LEFT JOIN rides r ON r.id = c.ride_id
         LEFT JOIN users u ON u.id = r.rider_id
         WHERE ($1 = '' OR c.status = $1)
         ORDER BY c.created_at DESC
         LIMIT $2 OFFSET $3`,
        [status, limit, offset],
      );
      res.json({
        commissions: rows.rows.map((r: any) => ({
          ...r,
          ride_price_cents: Number(r.ride_price_cents),
          commission_cents: Number(r.commission_cents),
          commission_rate: Number(r.commission_rate),
        })),
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Unable to load commission ledger' });
    }
  }

  static async rewardLedger(req: any, res: Response) {
    try {
      const limit = parseInt(req.query.limit ?? '50');
      const offset = parseInt(req.query.offset ?? '0');
      const rows = await pool.query(
        `SELECT rl.*, u.full_name AS user_name, u.email AS user_email,
                rfr.full_name AS referrer_name, rfd.full_name AS referred_name
         FROM reward_ledger rl
         LEFT JOIN users u ON u.id = rl.user_id
         LEFT JOIN users rfr ON rfr.id = rl.referrer_id
         LEFT JOIN users rfd ON rfd.id = rl.referred_user_id
         ORDER BY rl.created_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset],
      );
      res.json({
        transactions: rows.rows.map((r: any) => ({ ...r, amount_cents: Number(r.amount_cents) })),
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Unable to load reward ledger' });
    }
  }

  static async exportCreditLedger(_req: any, res: Response) {
    try {
      const rows = await pool.query(
        `SELECT ct.*, u.full_name AS user_name, u.email AS user_email
         FROM credit_transactions ct
         LEFT JOIN users u ON u.id = ct.user_id
         ORDER BY ct.created_at DESC
         LIMIT 5000`,
      );
      const csv = toCsv(
        ['ID', 'User', 'Email', 'Amount ($)', 'Type', 'Ride', 'Description', 'Balance After ($)', 'Created'],
        rows.rows.map((r: any) => [
          r.id, r.user_name, r.user_email, (Number(r.amount_cents) / 100).toFixed(2),
          r.type, r.ride_id, r.description, (Number(r.balance_after_cents) / 100).toFixed(2),
          r.created_at.toISOString(),
        ]),
      );
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="credit-ledger.csv"');
      res.send(csv);
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Unable to export credit ledger' });
    }
  }
}

function normalizePromoRow(r: any) {
  return {
    ...r,
    discount_value: Number(r.discount_value),
    times_used: Number(r.times_used),
    max_uses: Number(r.max_uses),
    min_ride_fare_cents: Number(r.min_ride_fare_cents),
    max_discount_cents: Number(r.max_discount_cents),
  };
}
