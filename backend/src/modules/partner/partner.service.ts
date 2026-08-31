// backend/src/modules/partner/partner.service.ts
//
// BUSINESS PARTNER MANAGEMENT — CRUD + commission lifecycle.
// ---------------------------------------------------------------------------
// Partners own promo codes and earn a commission on the rider's final
// payment for every completed ride that used one of their codes.
//
// Earnings ledger lives on the partner row (lifetime / pending / paid) and
// every individual accrual is an immutable `partner_commissions` row — the
// counters are derived views of that ledger, updated inside the same
// transaction as the ledger row.

import { pool } from '../../config/database';
import bcrypt from 'bcryptjs';
import { UserRole } from '../../types';
import { AuditEventsService } from '../../services/audit-events.service';

export const PARTNER_STATUSES = ['ACTIVE', 'INACTIVE', 'ARCHIVED'] as const;
export type PartnerStatus = (typeof PARTNER_STATUSES)[number];

export interface PartnerInput {
  name: string;
  business_type: string;
  address?: string | null;
  contact_name?: string | null;
  contact_phone?: string | null;
  contact_email?: string | null;
  email: string; // partner login email
  password: string; // partner login password (will be hashed)
  commission_rate: number; // fraction, e.g. 0.10
  notes?: string | null;
}

const roundCents = (n: number) => Math.round(n);

function normalizePartner(r: any) {
  return {
    ...r,
    commission_rate: Number(r.commission_rate),
    lifetime_earnings_cents: Number(r.lifetime_earnings_cents),
    pending_earnings_cents: Number(r.pending_earnings_cents),
    paid_earnings_cents: Number(r.paid_earnings_cents),
    total_referred_rides: Number(r.total_referred_rides),
  };
}

export class PartnerService {
  static async list(search: string, status: string, limit = 50, offset = 0) {
    const res = await pool.query(
      `SELECT p.*,
              (SELECT COUNT(*)::int FROM promo_codes pc WHERE pc.partner_id = p.id AND pc.active) AS active_promo_count,
              (SELECT COUNT(*)::int FROM promo_codes pc WHERE pc.partner_id = p.id) AS promo_count
       FROM partners p
       WHERE ($1 = '' OR p.name ILIKE '%' || $1 || '%' OR p.contact_email ILIKE '%' || $1 || '%'
              OR p.contact_phone ILIKE '%' || $1 || '%')
         AND ($2 = '' OR p.status = $2)
       ORDER BY p.created_at DESC
       LIMIT $3 OFFSET $4`,
      [search || '', status || '', Math.min(Math.max(limit, 1), 200), Math.max(offset, 0)],
    );
    return res.rows.map(normalizePartner);
  }

  static async getById(id: string) {
    const res = await pool.query(`SELECT * FROM partners WHERE id = $1`, [id]);
    return res.rows.length ? normalizePartner(res.rows[0]) : null;
  }

static async create(input: PartnerInput, adminId: string) {
    // Check if a user with this email already exists
    const existingUser = await pool.query('SELECT id FROM users WHERE email = $1', [input.email]);
    if (existingUser.rows.length > 0) {
      throw new Error('A user with this email already exists. Use a unique partner email.');
    }

    // Hash the password securely
    const passwordHash = await bcrypt.hash(input.password, 10);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Create the user account with PARTNER role and hashed password
      const userRes = await client.query(
        `INSERT INTO users (email, full_name, password_hash, role, is_verified, is_active, password_changed_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         RETURNING *`,
        [input.email, input.name.trim(), passwordHash, UserRole.PARTNER, false, true],
      );
      const user = userRes.rows[0];

      // Create the partner record linked to the user
      const partnerRes = await client.query(
        `INSERT INTO partners
           (name, business_type, address, contact_name, contact_phone, contact_email, commission_rate, notes, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ACTIVE')
         RETURNING *`,
        [
          input.name.trim(),
          input.business_type.trim(),
          input.address?.trim() ?? null,
          input.contact_name?.trim() ?? null,
          input.contact_phone?.trim() ?? null,
          input.contact_email?.trim() ?? null,
          Math.max(0, Math.min(1, Number(input.commission_rate))),
          input.notes?.trim() ?? null,
          'ACTIVE',
        ],
      );
      const partner = partnerRes.rows[0];

      await client.query('COMMIT');

      await AuditEventsService.record({
        actorId: adminId,
        actorRole: 'ADMIN',
        action: 'PARTNER_CREATED',
        entityType: 'PARTNER',
        entityId: partner.id,
        details: { name: input.name, email: input.email, business_type: input.business_type },
      });
      return normalizePartner(partner);
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* noop */ }
      throw err;
    } finally {
      client.release();
    }
  }

  static async update(id: string, input: Partial<PartnerInput>, adminId: string) {
    const existing = await this.getById(id);
    if (!existing) throw new Error('Partner not found');

    const merged = {
      name: (input.name ?? existing.name).trim(),
      business_type: (input.business_type ?? existing.business_type).trim(),
      address: input.address !== undefined ? input.address?.trim() ?? null : existing.address,
      contact_name: input.contact_name !== undefined ? input.contact_name?.trim() ?? null : existing.contact_name,
      contact_phone: input.contact_phone !== undefined ? input.contact_phone?.trim() ?? null : existing.contact_phone,
      contact_email: input.contact_email !== undefined ? input.contact_email?.trim() ?? null : existing.contact_email,
      commission_rate: Math.max(0, Math.min(1, Number(input.commission_rate ?? existing.commission_rate))),
      notes: input.notes !== undefined ? input.notes?.trim() ?? null : existing.notes,
    };

    const res = await pool.query(
      `UPDATE partners SET
         name = $1, business_type = $2, address = $3, contact_name = $4,
         contact_phone = $5, contact_email = $6, commission_rate = $7,
         notes = $8, updated_at = NOW()
       WHERE id = $9
       RETURNING *`,
      [
        merged.name, merged.business_type, merged.address, merged.contact_name,
        merged.contact_phone, merged.contact_email, merged.commission_rate,
        merged.notes, id,
      ],
    );
    await AuditEventsService.record({
      actorId: adminId,
      actorRole: 'ADMIN',
      action: 'PARTNER_UPDATED',
      entityType: 'PARTNER',
      entityId: id,
      details: { changed: Object.keys(input) },
    });
    return normalizePartner(res.rows[0]);
  }

  static async setStatus(id: string, status: PartnerStatus, adminId: string) {
    if (!PARTNER_STATUSES.includes(status)) throw new Error('Invalid partner status');
    const res = await pool.query(
      `UPDATE partners SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [status, id],
    );
    if (res.rows.length === 0) throw new Error('Partner not found');
    await AuditEventsService.record({
      actorId: adminId,
      actorRole: 'ADMIN',
      action: `PARTNER_${status}`,
      entityType: 'PARTNER',
      entityId: id,
    });
    return normalizePartner(res.rows[0]);
  }

  /** Stats for a partner: earnings + promo + ride aggregates. */
  static async stats(id: string) {
    const partner = await this.getById(id);
    if (!partner) throw new Error('Partner not found');

    const promoAgg = await pool.query(
      `SELECT COUNT(*)::int AS promo_count,
              COUNT(*) FILTER (WHERE active)::int AS active_promos,
              COALESCE(SUM(times_used), 0)::int AS total_promo_uses
       FROM promo_codes WHERE partner_id = $1`,
      [id],
    );

    const rideAgg = await pool.query(
      `SELECT
         COALESCE(SUM(ride_price_cents), 0)::bigint AS total_ride_value_cents,
         COUNT(*)::int AS commission_rows,
         COUNT(*) FILTER (WHERE status = 'PENDING')::int AS pending_rows,
         COUNT(*) FILTER (WHERE status = 'PAID')::int AS paid_rows,
         COUNT(*) FILTER (WHERE status = 'VOID')::int AS void_rows,
         MIN(created_at) AS first_commission_at,
         MAX(created_at) AS last_commission_at
       FROM partner_commissions WHERE partner_id = $1`,
      [id],
    );

    const recentRides = await pool.query(
      `SELECT r.id, r.promo_code, pc.code AS usage_code, r.final_payment_cents,
              r.fare_amount, r.status, r.created_at,
              u.full_name AS rider_name, u.email AS rider_email
       FROM rides r
       LEFT JOIN promo_codes pc ON pc.id = r.promo_id
       LEFT JOIN users u ON u.id = r.rider_id
       WHERE r.promo_id IN (SELECT id FROM promo_codes WHERE partner_id = $1)
       ORDER BY r.created_at DESC
       LIMIT 20`,
      [id],
    );

    return {
      partner,
      promos: {
        total: Number(promoAgg.rows[0].promo_count),
        active: Number(promoAgg.rows[0].active_promos),
        total_uses: Number(promoAgg.rows[0].total_promo_uses),
      },
      commissions: {
        total_ride_value_cents: Number(rideAgg.rows[0].total_ride_value_cents),
        rows: Number(rideAgg.rows[0].commission_rows),
        pending_rows: Number(rideAgg.rows[0].pending_rows),
        paid_rows: Number(rideAgg.rows[0].paid_rows),
        void_rows: Number(rideAgg.rows[0].void_rows),
        first_commission_at: rideAgg.rows[0].first_commission_at,
        last_commission_at: rideAgg.rows[0].last_commission_at,
      },
      recent_rides: recentRides.rows.map((r: any) => ({
        id: r.id,
        promo_code: r.usage_code ?? r.promo_code,
        final_payment_cents: Number(r.final_payment_cents),
        fare_amount: Number(r.fare_amount),
        status: r.status,
        created_at: r.created_at,
        rider_name: r.rider_name,
        rider_email: r.rider_email,
      })),
    };
  }

  /** Paginated commission history for one partner. */
  static async commissions(id: string, status: string, limit = 50, offset = 0) {
    const res = await pool.query(
      `SELECT c.*, r.rider_id, r.created_at AS ride_created_at,
              u.full_name AS rider_name,
              p.code AS promo_code
       FROM partner_commissions c
       LEFT JOIN rides r ON r.id = c.ride_id
       LEFT JOIN users u ON u.id = r.rider_id
       LEFT JOIN promo_codes p ON p.id = c.promo_id
       WHERE c.partner_id = $1
         AND ($2 = '' OR c.status = $2)
       ORDER BY c.created_at DESC
       LIMIT $3 OFFSET $4`,
      [id, status || '', Math.min(Math.max(limit, 1), 200), Math.max(offset, 0)],
    );
    return res.rows.map((r: any) => ({
      ...r,
      ride_price_cents: Number(r.ride_price_cents),
      commission_cents: Number(r.commission_cents),
      commission_rate: Number(r.commission_rate),
    }));
  }

  /**
   * Admin marks a commission PAID. Idempotent: paying twice does nothing.
   * Partner counters stay consistent with the ledger inside one transaction.
   */
  static async markCommissionPaid(commissionId: string, reference: string, adminId: string) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const res = await client.query(
        `SELECT * FROM partner_commissions WHERE id = $1 FOR UPDATE`,
        [commissionId],
      );
      const c = res.rows[0];
      if (!c) throw new Error('Commission not found');
      if (c.status === 'PAID') {
        await client.query('COMMIT');
        return { alreadyPaid: true, commission: c };
      }
      if (c.status === 'VOID') throw new Error('Void commissions cannot be paid');

      await client.query(
        `UPDATE partner_commissions
         SET status = 'PAID', paid_at = NOW(), paid_reference = $1
         WHERE id = $2`,
        [reference?.trim() ?? null, commissionId],
      );
      await client.query(
        `UPDATE partners
         SET pending_earnings_cents = pending_earnings_cents - $1,
             paid_earnings_cents = paid_earnings_cents + $1,
             updated_at = NOW()
         WHERE id = $2`,
        [Number(c.commission_cents), c.partner_id],
      );
      await client.query('COMMIT');

      await AuditEventsService.record({
        actorId: adminId,
        actorRole: 'ADMIN',
        action: 'COMMISSION_MARKED_PAID',
        entityType: 'COMMISSION',
        entityId: commissionId,
        details: { amount_cents: Number(c.commission_cents), reference: reference?.trim() ?? null },
      });
      return { alreadyPaid: false, commission: c };
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* noop */ }
      throw err;
    } finally {
      client.release();
    }
  }
}
