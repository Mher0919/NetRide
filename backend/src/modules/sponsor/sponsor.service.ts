// backend/src/modules/sponsor/sponsor.service.ts
//
// SPONSOR SERVICE — sponsors, their budget ledger, eligibility and the
// data backing the SPECIALS marketplace.
// ---------------------------------------------------------------------------
// Budget model (reserve-vs-consume, spec §63/§66/§67):
//   remaining_budget_cents  = funding not yet consumed AND not reserved
//   reserved_budget_cents   = held for RIDE_PENDING redemptions (released on
//                             cancellation/expiry via REVERSAL/EXPIRATION)
//   used_budget_cents       = consumed on successful redemption
//   invariant: initial = remaining + reserved + used
//   spendable_for_new_specials = remaining - reserved
//
// The ONLY place budget columns mutate is this service, and every mutation
// writes a sponsor_ledger_entries row (the audit source). Concurrent request
// paths lock the sponsor row FOR UPDATE so two $8 redemptions on a $10
// budget can never both pass — the loser is told the special is temporarily
// unavailable (spec §66-68).
//
// Money is integer cents everywhere.

import { pool } from '../../config/database';
import { centsValue } from '../../services/financial-ledger.service';
import { AuditEventsService } from '../../services/audit-events.service';
import { env } from '../../config/env';

export type SponsorshipDiscountType = 'PERCENTAGE' | 'FIXED_AMOUNT';
export type SponsorStatus = 'ACTIVE' | 'INACTIVE' | 'SUSPENDED' | 'DEPLETED';

export interface SponsorRow {
  id: string;
  business_name: string;
  business_type: string;
  business_description: string | null;
  manager_name: string | null;
  phone: string | null;
  email: string | null;
  other_contact_info: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
  logo_url: string | null;
  cover_image_url: string | null;
  discount_type: SponsorshipDiscountType;
  discount_percent: number | null;
  max_discount_percent: number;
  discount_fixed_amount_cents: number | null;
  initial_budget_cents: number;
  remaining_budget_cents: number;
  reserved_budget_cents: number;
  used_budget_cents: number;
  status: SponsorStatus;
  specials_enabled: boolean;
  map_listing_enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

export const discountLabelFor = (s: Pick<SponsorRow, 'discount_type' | 'discount_percent' | 'discount_fixed_amount_cents'>): string =>
  s.discount_type === 'PERCENTAGE'
    ? `${s.discount_percent}%`
    : `$${(centsValue(s.discount_fixed_amount_cents) / 100).toFixed(2)}`;

const roundCents = (n: number) => Math.round(n);

/**
 * Pure discount math — the single implementation used by ride request,
 * sponsor preview and unit tests. Never exceeds the fare, and never exceeds
 * the sponsor's discount configuration.
 */
export function computeSponsorDiscount(
  sponsor: Pick<SponsorRow, 'discount_type' | 'discount_percent' | 'max_discount_percent' | 'discount_fixed_amount_cents'>,
  fareCents: number,
): number {
  const gross = Math.max(0, roundCents(fareCents));
  let discount: number;
  if (sponsor.discount_type === 'PERCENTAGE') {
    const pct = Math.min(100, Number(sponsor.discount_percent ?? 0));
    discount = roundCents((gross * pct) / 100);
    const capPct = Math.max(0, Math.min(100, Number(sponsor.max_discount_percent)));
    discount = Math.min(discount, roundCents((gross * capPct) / 100));
  } else {
    discount = Math.min(centsValue(sponsor.discount_fixed_amount_cents), gross);
  }
  return Math.max(0, Math.min(discount, gross));
}

export function normalizeSponsor(r: any): SponsorRow {
  return {
    id: r.id,
    business_name: r.business_name,
    business_type: r.business_type,
    business_description: r.business_description,
    manager_name: r.manager_name,
    phone: r.phone,
    email: r.email,
    other_contact_info: r.other_contact_info,
    address: r.address,
    city: r.city,
    state: r.state,
    postal_code: r.postal_code,
    country: r.country,
    latitude: r.latitude != null ? Number(r.latitude) : null,
    longitude: r.longitude != null ? Number(r.longitude) : null,
    logo_url: r.logo_url,
    cover_image_url: r.cover_image_url,
    discount_type: r.discount_type,
    discount_percent: r.discount_percent != null ? Number(r.discount_percent) : null,
    max_discount_percent: Number(r.max_discount_percent),
    discount_fixed_amount_cents: centsValue(r.discount_fixed_amount_cents),
    initial_budget_cents: centsValue(r.initial_budget_cents),
    remaining_budget_cents: centsValue(r.remaining_budget_cents),
    reserved_budget_cents: centsValue(r.reserved_budget_cents),
    used_budget_cents: centsValue(r.used_budget_cents),
    status: r.status,
    specials_enabled: r.specials_enabled,
    map_listing_enabled: r.map_listing_enabled,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

const SPONSOR_COLUMNS = `
  SELECT id, business_name, business_type, business_description, manager_name,
         phone, email, other_contact_info, address, city, state, postal_code,
         country, latitude, longitude, logo_url, cover_image_url,
         discount_type, discount_percent, max_discount_percent,
         discount_fixed_amount_cents, initial_budget_cents,
         remaining_budget_cents, reserved_budget_cents, used_budget_cents,
         status, specials_enabled, map_listing_enabled, created_at, updated_at`;

const SPONSOR_SELECT = `${SPONSOR_COLUMNS} FROM sponsors`;

export interface SponsorCreateInput {
  businessName: string;
  businessType?: string;
  businessDescription?: string;
  managerName?: string;
  phone?: string;
  email?: string;
  otherContactInfo?: string;
  address?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  latitude?: number | null;
  longitude?: number | null;
  logoUrl?: string | null;
  coverImageUrl?: string | null;
  discountType: SponsorshipDiscountType;
  discountPercent?: number | null;
  maxDiscountPercent?: number;
  discountFixedAmountCents?: number | null;
  initialBudgetCents: number;
  createdByAdminId?: string | null;
}

export class SponsorService {
  // ------------------------------------------------------------------ CRUD

  static async findById(id: string): Promise<SponsorRow | null> {
    const res = await pool.query(`${SPONSOR_SELECT} WHERE id = $1`, [id]);
    return res.rows.length > 0 ? normalizeSponsor(res.rows[0]) : null;
  }

  static async findByIds(ids: string[]): Promise<SponsorRow[]> {
    if (ids.length === 0) return [];
    const res = await pool.query(`${SPONSOR_SELECT} WHERE id = ANY($1::uuid[])`, [ids]);
    return res.rows.map(normalizeSponsor);
  }

  /**
   * Creates a sponsor (INACTIVE by default — an admin must fund + activate
   * before anything is visible) and records the INITIAL_FUNDING ledger row.
   */
  static async create(input: SponsorCreateInput, actor?: { id?: string; role?: string }): Promise<SponsorRow> {
    const budget = Math.max(0, Math.round(input.initialBudgetCents));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const res = await client.query(
        `INSERT INTO sponsors (
           business_name, business_type, business_description, manager_name,
           phone, email, other_contact_info, address, city, state, postal_code,
           country, latitude, longitude, logo_url, cover_image_url,
           discount_type, discount_percent, max_discount_percent,
           discount_fixed_amount_cents, initial_budget_cents,
           remaining_budget_cents, reserved_budget_cents, used_budget_cents,
           status
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
                   $17,$18,$19,$20,$21,$22,0,0,'INACTIVE')
         RETURNING *`,
        [
          input.businessName.trim(),
          (input.businessType || 'OTHER').toUpperCase(),
          input.businessDescription ?? null,
          input.managerName ?? null,
          input.phone ?? null,
          input.email ?? null,
          input.otherContactInfo ?? null,
          input.address ?? null,
          input.city ?? null,
          input.state ?? null,
          input.postalCode ?? null,
          input.country ?? null,
          input.latitude ?? null,
          input.longitude ?? null,
          input.logoUrl ?? null,
          input.coverImageUrl ?? null,
          input.discountType,
          input.discountType === 'PERCENTAGE' ? Number(input.discountPercent ?? 0) : null,
          Math.max(1, Math.min(100, Number(input.maxDiscountPercent ?? 90))),
          input.discountType === 'FIXED_AMOUNT' ? Math.round(input.discountFixedAmountCents ?? 0) : null,
          budget,
          budget,
        ],
      );
      const sponsor = normalizeSponsor(res.rows[0]);

      if (budget > 0) {
        await client.query(
          `INSERT INTO sponsor_ledger_entries
             (sponsor_id, type, amount_cents, direction, reference_type,
              reason, actor_user_id, actor_role, balance_after_cents)
           VALUES ($1, 'INITIAL_FUNDING', $2, 'CREDIT', 'sponsor_create',
                   $3, $4, $5, $2)`,
          [
            sponsor.id,
            budget,
            'Initial sponsorship funding',
            actor?.id ?? null,
            actor?.role ?? 'ADMIN',
          ],
        );
      }
      await client.query('COMMIT');

      AuditEventsService.record({
        actorId: actor?.id ?? null,
        actorRole: actor?.role ?? 'ADMIN',
        action: 'sponsor_created',
        entityType: 'sponsor',
        entityId: sponsor.id,
        details: { budgetCents: budget, discountType: input.discountType },
      }).catch(() => undefined);

      return sponsor;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* noop */ }
      throw err;
    } finally {
      client.release();
    }
  }

  static async update(id: string, patch: Record<string, unknown>): Promise<SponsorRow | null> {
    const sponsor = await this.findById(id);
    if (!sponsor) throw new Error('Sponsor not found');

    const allowed = [
      'business_name', 'business_type', 'business_description', 'manager_name',
      'phone', 'email', 'other_contact_info', 'address', 'city', 'state',
      'postal_code', 'country', 'latitude', 'longitude', 'logo_url',
      'cover_image_url', 'discount_type', 'discount_percent',
      'max_discount_percent', 'discount_fixed_amount_cents',
      'specials_enabled', 'map_listing_enabled',
    ];
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(patch)) {
      if (!allowed.includes(key)) continue;
      sets.push(`${key} = $${values.length + 1}`);
      values.push(value ?? null);
    }
    if (sets.length === 0) return sponsor;

    values.push(id);
    const res = await pool.query(
      `UPDATE sponsors SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${values.length} RETURNING *`,
      values,
    );
    if (res.rows.length === 0) return null;
    return normalizeSponsor(res.rows[0]);
  }

  // ------------------------------------------------------------- Ledger ops

  /**
   * Admin budget adjustment. Signed amount; writes a BUDGET_ADJUSTMENT
   * ledger row with the reason (spec §62-63: every adjustment needs a reason
   * AND a ledger row). A negative adjustment that would overdraw is refused
   * only if it exceeds the currently spendable amount — reserved credits are
   * never clawed back.
   */
  static async adjustBudget(
    id: string,
    deltaCents: number,
    reason: string,
    actor?: { id?: string; role?: string },
  ): Promise<SponsorRow> {
    const delta = Math.round(deltaCents);
    if (delta === 0) throw new Error('Adjustment amount must be non-zero');
    if (!reason || !reason.trim()) throw new Error('A reason is required for budget adjustments');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let res: any;
      if (delta < 0) {
        res = await client.query(
          `UPDATE sponsors
           SET remaining_budget_cents = remaining_budget_cents + $2,
               initial_budget_cents = initial_budget_cents + $2,
               updated_at = NOW()
           WHERE id = $1 AND remaining_budget_cents >= $3
           RETURNING *`,
          [id, delta, Math.abs(delta)],
        );
      } else {
        res = await client.query(
          `UPDATE sponsors
           SET remaining_budget_cents = remaining_budget_cents + $2,
               initial_budget_cents = initial_budget_cents + $2,
               updated_at = NOW()
           WHERE id = $1
           RETURNING *`,
          [id, delta],
        );
      }
      if (res.rows.length === 0) {
        throw new Error('Insufficient budget for this adjustment');
      }
      const sponsor = normalizeSponsor(res.rows[0]);

      await client.query(
        `INSERT INTO sponsor_ledger_entries
           (sponsor_id, type, amount_cents, direction, reference_type,
            reason, actor_user_id, actor_role, balance_after_cents)
         VALUES ($1, 'BUDGET_ADJUSTMENT', $2, $3, 'admin_adjustment',
                 $4, $5, $6, $7)`,
        [
          sponsor.id,
          delta,
          delta > 0 ? 'CREDIT' : 'DEBIT',
          reason.trim().slice(0, 500),
          actor?.id ?? null,
          actor?.role ?? 'ADMIN',
          sponsor.remaining_budget_cents,
        ],
      );
      await client.query('COMMIT');

      AuditEventsService.record({
        actorId: actor?.id ?? null,
        actorRole: actor?.role ?? 'ADMIN',
        action: 'sponsor_budget_adjusted',
        entityType: 'sponsor',
        entityId: sponsor.id,
        details: { deltaCents: delta, reason: reason.trim().slice(0, 500) },
      }).catch(() => undefined);

      return sponsor;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* noop */ }
      throw err;
    } finally {
      client.release();
    }
  }

  static async setStatus(id: string, status: SponsorStatus, actor?: { id?: string; role?: string }): Promise<SponsorRow> {
    if (!['ACTIVE', 'INACTIVE', 'SUSPENDED', 'DEPLETED'].includes(status)) {
      throw new Error('Invalid sponsor status');
    }
    const res = await pool.query(
      `UPDATE sponsors SET status = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id, status],
    );
    if (res.rows.length === 0) throw new Error('Sponsor not found');
    AuditEventsService.record({
      actorId: actor?.id ?? null,
      actorRole: actor?.role ?? 'ADMIN',
      action: 'sponsor_status_changed',
      entityType: 'sponsor',
      entityId: id,
      details: { status },
    }).catch(() => undefined);
    return normalizeSponsor(res.rows[0]);
  }

  /**
   * Recomputes the sponsor status when the budget depletes / is funded.
   * Only DEPLETED → ACTIVE promotion needs an explicit admin action; the
   * DEPLETED downgrade is automatic, and ACTIVE → DEPLETED never touches
   * historical redemptions (spec §69).
   */
  static async syncDepletionStatus(id: string): Promise<void> {
    await pool.query(
      `UPDATE sponsors SET status = 'DEPLETED', updated_at = NOW()
       WHERE id = $1 AND status = 'ACTIVE'
         AND remaining_budget_cents - reserved_budget_cents <= 0`,
      [id],
    );
  }

  // ------------------------------------------------------------- Eligibility

  /**
   * Eligibility is decided HERE, in one place (spec §10-11/§88-89):
   * status ACTIVE + specials_enabled + map_listing_enabled + coordinates +
   * spendable budget > 0.
   */
  static isEligible(sponsor: Pick<SponsorRow, 'status' | 'specials_enabled' | 'map_listing_enabled' | 'latitude' | 'longitude' | 'remaining_budget_cents' | 'reserved_budget_cents' | 'discount_type' | 'discount_percent' | 'discount_fixed_amount_cents'>): boolean {
    if (sponsor.status !== 'ACTIVE') return false;
    if (!sponsor.specials_enabled || !sponsor.map_listing_enabled) return false;
    if (sponsor.latitude == null || sponsor.longitude == null) return false;
    if (centsValue(sponsor.remaining_budget_cents) - centsValue(sponsor.reserved_budget_cents) <= 0) return false;
    if (sponsor.discount_type === 'PERCENTAGE') return Number(sponsor.discount_percent ?? 0) > 0;
    return centsValue(sponsor.discount_fixed_amount_cents) > 0;
  }

  /**
   * SPECIALS list + map markers: eligible sponsors, paginated, ordered by
   * distance when a geo origin is provided. Bounded per spec §125.
   */
  static async listEligible(opts: {
    businessType?: string;
    lat?: number;
    lng?: number;
    limit?: number;
    offset?: number;
  } = {}): Promise<SponsorRow[]> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const offset = Math.max(opts.offset ?? 0, 0);
    const params: unknown[] = [];
    const where = [
      `status = 'ACTIVE'`,
      `specials_enabled = TRUE`,
      `map_listing_enabled = TRUE`,
      `latitude IS NOT NULL`,
      `longitude IS NOT NULL`,
      `remaining_budget_cents - reserved_budget_cents > 0`,
    ];
    if (opts.businessType) {
      params.push(opts.businessType.toUpperCase());
      where.push(`business_type = $${params.length}`);
    }
    const geo = opts.lat != null && opts.lng != null;
    const distanceSelect = geo
      ? `, (6371 * acos(
           LEAST(1, GREATEST(-1,
             cos(radians($${params.length + 1})) * cos(radians(latitude)) *
             cos(radians(longitude) - radians($${params.length + 2})) +
             sin(radians($${params.length + 1})) * sin(radians(latitude))
           ))
         )) AS km_away`
      : ', NULL AS km_away';
    const distanceOrder = geo ? 'km_away ASC' : 'created_at DESC';
    const geoParams = geo ? [opts.lat, opts.lng] : [];

    const res = await pool.query(
      `${SPONSOR_COLUMNS}${distanceSelect} FROM sponsors
       WHERE ${where.join(' AND ')}
       ORDER BY ${distanceOrder}
       LIMIT $${params.length + geoParams.length + 1} OFFSET $${params.length + geoParams.length + 2}`,
      [...params, ...geoParams, limit, offset],
    );
    return res.rows.map((r: any) => ({ ...normalizeSponsor(r), km_away: r.km_away != null ? Number(r.km_away) : null }));
  }

  static async countEligible(): Promise<number> {
    const res = await pool.query(
      `SELECT COUNT(*)::int AS n FROM sponsors
       WHERE status = 'ACTIVE' AND specials_enabled = TRUE
         AND map_listing_enabled = TRUE AND latitude IS NOT NULL
         AND longitude IS NOT NULL
         AND remaining_budget_cents - reserved_budget_cents > 0`,
    );
    return res.rows[0]?.n ?? 0;
  }

  // --------------------------------------------------------------- Analytics

  static async listSponsors(opts: { search?: string; status?: string; limit?: number; offset?: number } = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const offset = Math.max(opts.offset ?? 0, 0);
    const params: unknown[] = [];
    const where: string[] = [];
    if (opts.search) {
      params.push(`%${opts.search}%`);
      where.push(`(business_name ILIKE $${params.length} OR email ILIKE $${params.length} OR phone ILIKE $${params.length})`);
    }
    if (opts.status) {
      params.push(opts.status.toUpperCase());
      where.push(`status = $${params.length}`);
    }
    const res = await pool.query(
      `${SPONSOR_SELECT}
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    const total = await pool.query(`SELECT COUNT(*)::int AS n FROM sponsors${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`, params);
    return { rows: res.rows.map(normalizeSponsor), total: total.rows[0]?.n ?? 0 };
  }

  static async getLedger(sponsorId: string, opts: { limit?: number; offset?: number } = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const offset = Math.max(opts.offset ?? 0, 0);
    const res = await pool.query(
      `SELECT sle.*, sr.id AS redemption_id, sr.status AS redemption_status
       FROM sponsor_ledger_entries sle
       LEFT JOIN special_redemptions sr ON sr.id = sle.reference_id
       WHERE sle.sponsor_id = $1
       ORDER BY sle.created_at DESC
       LIMIT $2 OFFSET $3`,
      [sponsorId, limit, offset],
    );
    return res.rows.map((r: any) => ({
      ...r,
      amount_cents: centsValue(r.amount_cents),
      balance_after_cents: centsValue(r.balance_after_cents),
    }));
  }

  /** Financial history: every redemption settlement with the 60/40 columns. */
  static async getFinancialHistory(sponsorId: string, opts: { limit?: number; offset?: number } = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const offset = Math.max(opts.offset ?? 0, 0);
    const res = await pool.query(
      `SELECT id, rider_id, driver_id, ride_id, status, created_at,
              ride_completed_at, sponsor_validated_at, reward_choice,
              reward_amount_cents, sponsor_funded_cents,
              driver_allocation_cents, netride_allocation_cents,
              netride_bonus_cents, sponsor_settled_at
       FROM special_redemptions
       WHERE sponsor_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [sponsorId, limit, offset],
    );
    return res.rows.map((r: any) => ({
      ...r,
      reward_amount_cents: centsValue(r.reward_amount_cents),
      sponsor_funded_cents: centsValue(r.sponsor_funded_cents),
      driver_allocation_cents: centsValue(r.driver_allocation_cents),
      netride_allocation_cents: centsValue(r.netride_allocation_cents),
      netride_bonus_cents: centsValue(r.netride_bonus_cents),
    }));
  }

  static async getAnalytics(sponsorId: string, from: Date, to: Date) {
    const res = await pool.query(
      `SELECT
         COUNT(*)::int                                              AS total_redemptions,
         COUNT(*) FILTER (WHERE status = 'REWARD_COMPLETED')::int   AS rewarded_redemptions,
         COUNT(*) FILTER (WHERE status = 'CANCELLED')::int          AS cancelled_redemptions,
         COALESCE(SUM(sponsor_funded_cents), 0)::bigint             AS total_sponsor_funded_cents,
         COALESCE(SUM(driver_allocation_cents), 0)::bigint          AS total_driver_allocation_cents,
         COALESCE(SUM(netride_allocation_cents), 0)::bigint         AS total_netride_allocation_cents,
         COALESCE(SUM(reward_amount_cents), 0)::bigint              AS total_reward_amount_cents,
         COUNT(DISTINCT rider_id)::int                              AS unique_rider_count,
         COUNT(DISTINCT rider_id) FILTER (WHERE status = 'REWARD_COMPLETED')::int AS rewarded_unique_riders,
         ROUND(AVG(calculated_discount_cents) FILTER (WHERE status = 'REWARD_COMPLETED'))::bigint AS avg_discount_cents
       FROM special_redemptions
       WHERE sponsor_id = $1 AND created_at >= $2 AND created_at <= $3`,
      [sponsorId, from, to],
    );
    const r = res.rows[0];
    return {
      totalRedemptions: r.total_redemptions,
      rewardedRedemptions: r.rewarded_redemptions,
      cancelledRedemptions: r.cancelled_redemptions,
      totalSponsorFundedCents: centsValue(r.total_sponsor_funded_cents),
      totalDriverAllocationCents: centsValue(r.total_driver_allocation_cents),
      totalNetrideAllocationCents: centsValue(r.total_netride_allocation_cents),
      totalRewardAmountCents: centsValue(r.total_reward_amount_cents),
      uniqueRiderCount: r.unique_rider_count,
      rewardedUniqueRiders: r.rewarded_unique_riders,
      avgDiscountCents: r.avg_discount_cents ?? 0,
    };
  }

  // --------------------------------------------------------- Portal accounts

  static async getPortalAccountForSponsor(sponsorId: string) {
    const res = await pool.query(
      `SELECT spa.id, spa.sponsor_id, spa.user_id, spa.is_active,
              spa.must_change_password, spa.last_login_at, spa.created_at,
              u.email, u.full_name, u.is_active AS user_is_active
       FROM sponsor_portal_accounts spa
       JOIN users u ON u.id = spa.user_id
       WHERE spa.sponsor_id = $1`,
      [sponsorId],
    );
    return res.rows[0] ?? null;
  }

  static async getSponsorForPortalUser(userId: string): Promise<SponsorRow | null> {
    const joined = await pool.query(
      `SELECT s.id, s.business_name, s.business_type, s.business_description,
              s.manager_name, s.phone, s.email, s.other_contact_info, s.address,
              s.city, s.state, s.postal_code, s.country, s.latitude, s.longitude,
              s.logo_url, s.cover_image_url, s.discount_type, s.discount_percent,
              s.max_discount_percent, s.discount_fixed_amount_cents,
              s.initial_budget_cents, s.remaining_budget_cents,
              s.reserved_budget_cents, s.used_budget_cents, s.status,
              s.specials_enabled, s.map_listing_enabled, s.created_at, s.updated_at
       FROM sponsors s
       JOIN sponsor_portal_accounts spa ON spa.sponsor_id = s.id
       WHERE spa.user_id = $1 AND spa.is_active = TRUE`,
      [userId],
    );
    return joined.rows.length > 0 ? normalizeSponsor(joined.rows[0]) : null;
  }

  /** Creates (or resets) the sponsor's portal login. Role SPONSOR, bcrypt hash, never plaintext. */
  static async createPortalAccount(
    sponsorId: string,
    email: string,
    password: string,
    actor?: { id?: string; role?: string },
  ): Promise<{ password: string }> {
    const sponsor = await this.findById(sponsorId);
    if (!sponsor) throw new Error('Sponsor not found');
    if (email.length < 5 || !email.includes('@')) throw new Error('A valid email is required');
    if (password.length < 8) throw new Error('Password must be at least 8 characters');

    const bcrypt = await import('bcryptjs');
    const passwordHash = await bcrypt.hash(password, 10);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query(
        `SELECT spa.id, spa.user_id FROM sponsor_portal_accounts spa WHERE spa.sponsor_id = $1`,
        [sponsorId],
      );
      let userId: string | null = existing.rows[0]?.user_id ?? null;
      if (userId) {
        await client.query(
          `UPDATE users SET password_hash = $1, is_active = TRUE WHERE id = $2`,
          [passwordHash, userId],
        );
      } else {
        // Attach to an existing account if the email is already a portal
        // login (a partner or fleet user who now also sponsors) — never
        // overwrite their role or display name.
        const byEmail = await client.query(`SELECT id FROM users WHERE email = $1`, [email.trim().toLowerCase()]);
        if (byEmail.rows.length > 0) {
          userId = byEmail.rows[0].id;
          await client.query(
            `UPDATE users SET password_hash = $1, is_active = TRUE WHERE id = $2`,
            [passwordHash, userId],
          );
        } else {
          const userRes = await client.query(
            `INSERT INTO users (email, password_hash, full_name, role, is_active)
             VALUES ($1, $2, $3, 'SPONSOR', TRUE)
             RETURNING id`,
            [email.trim().toLowerCase(), passwordHash, sponsor.business_name],
          );
          userId = userRes.rows[0].id;
        }
      }
      await client.query(
        `INSERT INTO sponsor_portal_accounts
           (sponsor_id, user_id, must_change_password, is_active, created_by_admin_id)
         VALUES ($1, $2, TRUE, TRUE, $3)
         ON CONFLICT (sponsor_id) DO UPDATE SET
           user_id = EXCLUDED.user_id, must_change_password = TRUE,
           is_active = TRUE, updated_at = NOW()`,
        [sponsorId, userId, actor?.id ?? null],
      );
      await client.query('COMMIT');

      AuditEventsService.record({
        actorId: actor?.id ?? null,
        actorRole: actor?.role ?? 'ADMIN',
        action: 'sponsor_portal_account_created',
        entityType: 'sponsor',
        entityId: sponsorId,
        details: { email: email.trim().toLowerCase() },
      }).catch(() => undefined);

      return { password };
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* noop */ }
      throw err;
    } finally {
      client.release();
    }
  }

  static async resetPortalPassword(sponsorId: string, newPassword: string, actor?: { id?: string; role?: string }) {
    const account = await this.getPortalAccountForSponsor(sponsorId);
    if (!account) throw new Error('No portal account exists for this sponsor');
    if (newPassword.length < 8) throw new Error('Password must be at least 8 characters');
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash(newPassword, 10);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE users SET password_hash = $1 WHERE id = $2`,
        [hash, account.user_id],
      );
      await client.query(
        `UPDATE sponsor_portal_accounts SET must_change_password = TRUE, updated_at = NOW() WHERE sponsor_id = $1`,
        [sponsorId],
      );
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* noop */ }
      throw err;
    } finally {
      client.release();
    }
    AuditEventsService.record({
      actorId: actor?.id ?? null,
      actorRole: actor?.role ?? 'ADMIN',
      action: 'sponsor_portal_password_reset',
      entityType: 'sponsor',
      entityId: sponsorId,
    }).catch(() => undefined);
    return { password: newPassword };
  }

  static async disablePortalAccount(sponsorId: string, actor?: { id?: string; role?: string }) {
    const account = await this.getPortalAccountForSponsor(sponsorId);
    if (!account) return;
    await pool.query(
      `UPDATE sponsor_portal_accounts SET is_active = FALSE, updated_at = NOW() WHERE sponsor_id = $1`,
      [sponsorId],
    );
    await pool.query(`UPDATE users SET is_active = FALSE WHERE id = $1`, [account.user_id]);
    AuditEventsService.record({
      actorId: actor?.id ?? null,
      actorRole: actor?.role ?? 'ADMIN',
      action: 'sponsor_portal_account_disabled',
      entityType: 'sponsor',
      entityId: sponsorId,
    }).catch(() => undefined);
  }

  // ================================================================
  // FLEET PORTAL ACCOUNTS (unified partner portal)
  // ================================================================

  static async getFleetPortalAccountForFleet(fleetId: string) {
    const r = await pool.query(
      `SELECT fpa.id, fpa.fleet_id, fpa.is_active, fpa.must_change_password,
              u.email, u.full_name, u.is_active AS user_active
       FROM fleet_portal_accounts fpa
       JOIN users u ON u.id = fpa.user_id
       WHERE fpa.fleet_id = $1`,
      [fleetId],
    );
    return r.rows[0] ?? null;
  }

  /** Creates (or resets) the fleet's portal login. Role FLEET, bcrypt hash. */
  static async createFleetPortalAccount(
    fleetId: string,
    email: string,
    password: string,
    actor?: { id?: string; role?: string },
  ): Promise<{ password: string }> {
    const fleet = await pool.query(`SELECT id, name FROM fleet_partners WHERE id = $1`, [fleetId]);
    if (!fleet.rows[0]) throw new Error('Fleet partner not found');
    if (email.length < 5 || !email.includes('@')) throw new Error('A valid email is required');
    if (password.length < 8) throw new Error('Password must be at least 8 characters');

    const bcrypt = await import('bcryptjs');
    const passwordHash = await bcrypt.hash(password, 10);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query(
        `SELECT fpa.id, fpa.user_id FROM fleet_portal_accounts fpa WHERE fpa.fleet_id = $1`,
        [fleetId],
      );
      let userId: string | null = existing.rows[0]?.user_id ?? null;
      if (userId) {
        await client.query(
          `UPDATE users SET password_hash = $1, is_active = TRUE WHERE id = $2`,
          [passwordHash, userId],
        );
      } else {
        // Attach to an existing account if the email is already a portal
        // login (a partner or sponsor user who now also operates a fleet) —
        // never overwrite their role or display name.
        const byEmail = await client.query(`SELECT id FROM users WHERE email = $1`, [email.trim().toLowerCase()]);
        if (byEmail.rows.length > 0) {
          userId = byEmail.rows[0].id;
          await client.query(
            `UPDATE users SET password_hash = $1, is_active = TRUE WHERE id = $2`,
            [passwordHash, userId],
          );
        } else {
          const userRes = await client.query(
            `INSERT INTO users (email, password_hash, full_name, role, is_active)
             VALUES ($1, $2, $3, 'FLEET', TRUE)
             RETURNING id`,
            [email.trim().toLowerCase(), passwordHash, fleet.rows[0].name],
          );
          userId = userRes.rows[0].id;
        }
      }
      await client.query(
        `INSERT INTO fleet_portal_accounts
           (fleet_id, user_id, must_change_password, is_active, created_by_admin_id)
         VALUES ($1, $2, TRUE, TRUE, $3)
         ON CONFLICT (fleet_id) DO UPDATE SET
           user_id = EXCLUDED.user_id, must_change_password = TRUE,
           is_active = TRUE, updated_at = NOW()`,
        [fleetId, userId, actor?.id ?? null],
      );
      await client.query('COMMIT');

      AuditEventsService.record({
        actorId: actor?.id ?? null,
        actorRole: actor?.role ?? 'ADMIN',
        action: 'fleet_portal_account_created',
        entityType: 'fleet',
        entityId: fleetId,
        details: { email: email.trim().toLowerCase() },
      }).catch(() => undefined);

      return { password };
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* noop */ }
      throw err;
    } finally {
      client.release();
    }
  }

  static async resetFleetPortalPassword(fleetId: string, newPassword: string, actor?: { id?: string; role?: string }) {
    const account = await this.getFleetPortalAccountForFleet(fleetId);
    if (!account) throw new Error('No portal account exists for this fleet');
    if (newPassword.length < 8) throw new Error('Password must be at least 8 characters');
    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query(
      `UPDATE users SET password_hash = $1 WHERE id = $2`,
      [hash, account.user_id],
    );
    await pool.query(
      `UPDATE fleet_portal_accounts SET must_change_password = TRUE, updated_at = NOW() WHERE fleet_id = $1`,
      [fleetId],
    );
    AuditEventsService.record({
      actorId: actor?.id ?? null,
      actorRole: actor?.role ?? 'ADMIN',
      action: 'fleet_portal_password_reset',
      entityType: 'fleet',
      entityId: fleetId,
    }).catch(() => undefined);
    return { password: newPassword };
  }

  static async disableFleetPortalAccount(fleetId: string, actor?: { id?: string; role?: string }) {
    const account = await this.getFleetPortalAccountForFleet(fleetId);
    if (!account) return;
    await pool.query(
      `UPDATE fleet_portal_accounts SET is_active = FALSE, updated_at = NOW() WHERE fleet_id = $1`,
      [fleetId],
    );
    await pool.query(`UPDATE users SET is_active = FALSE WHERE id = $1`, [account.user_id]);
    AuditEventsService.record({
      actorId: actor?.id ?? null,
      actorRole: actor?.role ?? 'ADMIN',
      action: 'fleet_portal_account_disabled',
      entityType: 'fleet',
      entityId: fleetId,
    }).catch(() => undefined);
  }
}