// backend/src/modules/promo/promo.service.ts
//
// PROMO CODE ENGINE — backend is the ONLY authority on promo validity.
// ---------------------------------------------------------------------------
// Canonical discount order applied everywhere:
//
//   gross fare → promo discount → ride credits → final payment
//
// Every function that touches money either runs inside the caller's
// transaction (`client`) or opens its own. The promo row is locked
// `FOR UPDATE` while a ride consumes it, so concurrent applications cannot
// overshoot `max_uses`.

import { pool } from '../../config/database';

export type PromoDiscountType = 'PERCENTAGE' | 'FIXED';

export interface PromoRow {
  id: string;
  code: string;
  partner_id: string | null;
  discount_type: PromoDiscountType;
  discount_value: string;
  max_uses: number;
  times_used: number;
  expires_at: Date | null;
  active: boolean;
  min_ride_fare_cents: number;
  max_discount_cents: number;
  single_use_per_rider: boolean;
  usage_rule: string;
  partner_status: string | null;
  partner_name: string | null;
}

export interface PromoApplication {
  promo: PromoRow;
  discountCents: number;
  usageId: string;
}

const roundCents = (n: number) => Math.round(n);

/**
 * Pure discount math — the single implementation used by validation,
 * ride request, admin previews and tests. Never exceeds the fare.
 */
export function computePromoDiscount(
  promo: Pick<PromoRow, 'discount_type' | 'discount_value' | 'max_discount_cents'>,
  fareCents: number,
): number {
  const gross = Math.max(0, roundCents(fareCents));
  let discount: number;
  if (promo.discount_type === 'PERCENTAGE') {
    const pct = Math.max(0, Math.min(100, Number(promo.discount_value)));
    discount = roundCents((gross * pct) / 100);
  } else {
    discount = Math.min(roundCents(Number(promo.discount_value) * 100), gross);
  }
  const cap = Math.max(0, Number(promo.max_discount_cents));
  if (cap > 0) discount = Math.min(discount, cap);
  return Math.max(0, Math.min(discount, gross));
}

/** Loads a promo row joined with partner state (null-safe). */
export async function findPromoByCode(code: string): Promise<PromoRow | null> {
  const res = await pool.query(
    `SELECT p.id, p.code, p.partner_id, p.discount_type, p.discount_value,
            p.max_uses, p.times_used, p.expires_at, p.active,
            p.min_ride_fare_cents, p.max_discount_cents,
            p.single_use_per_rider, p.usage_rule,
            pt.status AS partner_status, pt.name AS partner_name
     FROM promo_codes p
     LEFT JOIN partners pt ON pt.id = p.partner_id
     WHERE p.code = $1`,
    [String(code ?? '').trim().toUpperCase()],
  );
  if (res.rows.length === 0) return null;
  return normalizePromo(res.rows[0]);
}

export function normalizePromo(r: any): PromoRow {
  return {
    id: r.id,
    code: r.code,
    partner_id: r.partner_id,
    discount_type: r.discount_type,
    discount_value: String(r.discount_value),
    max_uses: Number(r.max_uses),
    times_used: Number(r.times_used),
    expires_at: r.expires_at,
    active: r.active,
    min_ride_fare_cents: Number(r.min_ride_fare_cents),
    max_discount_cents: Number(r.max_discount_cents),
    single_use_per_rider: r.single_use_per_rider,
    usage_rule: r.usage_rule,
    partner_status: r.partner_status,
    partner_name: r.partner_name,
  };
}

export interface ValidationFailure {
  valid: false;
  reason: string;
  code: number;
}

export interface ValidationSuccess {
  valid: true;
  promo: PromoRow;
  discountCents: number;
  fareCents: number;
  finalCents: number;
}

export type PromoValidation = ValidationFailure | ValidationSuccess;

/**
 * Validates a promo against a fare. Pure checks — no locks, no writes.
 * Used by the rider-facing preview endpoint AND the ride-request path
 * (which then re-locks inside its transaction).
 */
export async function validatePromo(
  riderId: string,
  code: string,
  fareCents: number,
  opts: { checkSingleUse?: boolean; client?: any } = {},
): Promise<PromoValidation> {
  const useClient = opts.client ?? pool;
  const promo = await findPromoByCode(code);
  const fare = Math.max(0, roundCents(fareCents));

  if (!promo) return { valid: false, reason: 'This promo code does not exist', code: 404 };
  if (!promo.active) return { valid: false, reason: 'This promo code is not active', code: 400 };
  if (promo.expires_at && new Date(promo.expires_at).getTime() < Date.now()) {
    return { valid: false, reason: 'This promo code has expired', code: 400 };
  }
  if (promo.partner_id && promo.partner_status !== 'ACTIVE') {
    return { valid: false, reason: 'The partner behind this promo is not active', code: 400 };
  }
  if (promo.max_uses > 0 && promo.times_used >= promo.max_uses) {
    return { valid: false, reason: 'This promo code has reached its usage limit', code: 400 };
  }
  if (promo.min_ride_fare_cents > 0 && fare < Number(promo.min_ride_fare_cents)) {
    return {
      valid: false,
      reason: `This promo requires a minimum fare of $${(Number(promo.min_ride_fare_cents) / 100).toFixed(2)}`,
      code: 400,
    };
  }
  if (opts.checkSingleUse !== false && promo.single_use_per_rider) {
    const used = await useClient.query(
      `SELECT id FROM promo_usage WHERE promo_id = $1 AND rider_id = $2 AND status <> 'VOID'`,
      [promo.id, riderId],
    );
    if (used.rows.length > 0) {
      return { valid: false, reason: 'You have already used this promo code', code: 400 };
    }
  }
  if (fare <= 0) return { valid: false, reason: 'Invalid fare for promo application', code: 400 };

  const discountCents = computePromoDiscount(promo, fare);
  return {
    valid: true,
    promo,
    discountCents,
    fareCents: fare,
    finalCents: Math.max(0, fare - discountCents),
  };
}

/**
 * Authoritative application at ride request time. Must be called inside the
 * caller's transaction; locks the promo row FOR UPDATE so max_uses and
 * single-use-per-rider can never be violated concurrently.
 *
 * Throws with a user-safe message when invalid.
 */
export async function applyPromoToRide(
  client: any,
  riderId: string,
  rideId: string,
  code: string,
  fareCents: number,
): Promise<PromoApplication> {
  const normalized = String(code ?? '').trim().toUpperCase();
  const locked = await client.query(
    `SELECT p.id, p.code, p.partner_id, p.discount_type, p.discount_value,
            p.max_uses, p.times_used, p.expires_at, p.active,
            p.min_ride_fare_cents, p.max_discount_cents,
            p.single_use_per_rider, p.usage_rule,
            pt.status AS partner_status, pt.name AS partner_name
     FROM promo_codes p
     LEFT JOIN partners pt ON pt.id = p.partner_id
     WHERE p.code = $1
     FOR UPDATE OF p`,
    [normalized],
  );
  if (locked.rows.length === 0) {
    throw new Error('This promo code does not exist');
  }
  const promo = normalizePromo(locked.rows[0]);

  const validation = await validatePromo(riderId, normalized, fareCents, { client });
  if (!validation.valid) {
    throw new Error(validation.reason);
  }

  const usage = await client.query(
    `INSERT INTO promo_usage (promo_id, ride_id, rider_id, discount_cents, rider_paid_cents, status)
     VALUES ($1, $2, $3, $4, $5, 'APPLIED')
     ON CONFLICT DO NOTHING
     RETURNING id, discount_cents`,
    [promo.id, rideId, riderId, validation.discountCents, validation.finalCents],
  );
  if (usage.rows.length === 0) {
    throw new Error('This ride already has a promo applied');
  }

  return {
    promo,
    discountCents: validation.discountCents,
    usageId: usage.rows[0].id,
  };
}

/**
 * Ride COMPLETED: promote usage APPLIED → USED, bump times_used, and accrue
 * the partner commission. One transaction, one commission per ride.
 */
export async function finalizePromoForCompletedRide(rideId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const usageRes = await client.query(
      `SELECT * FROM promo_usage WHERE ride_id = $1 AND status = 'APPLIED' FOR UPDATE`,
      [rideId],
    );
    const usage = usageRes.rows[0];
    if (!usage) {
      await client.query('COMMIT');
      return;
    }

    const ride = await client.query(
      `SELECT final_payment_cents, fare_amount FROM rides WHERE id = $1`,
      [rideId],
    );
    const finalPaymentCents = Number(ride.rows[0]?.final_payment_cents ?? 0);

    await client.query(
      `UPDATE promo_usage SET status = 'USED', completed_at = NOW() WHERE id = $1`,
      [usage.id],
    );
    await client.query(
      `UPDATE promo_codes SET times_used = times_used + 1, updated_at = NOW() WHERE id = $1`,
      [usage.promo_id],
    );

    const promo = await client.query(
      `SELECT p.*, pt.commission_rate, pt.name AS partner_name
       FROM promo_codes p
       LEFT JOIN partners pt ON pt.id = p.partner_id
       WHERE p.id = $1`,
      [usage.promo_id],
    );
    const p = promo.rows[0];

    // Commission is earned only when the ride produced revenue and the
    // partner is still ACTIVE (a partner that was deactivated between
    // request and completion keeps the ride but forfeits commission).
    if (p?.partner_id && finalPaymentCents > 0 && p.partner_status === 'ACTIVE') {
      const rate = Number(p.commission_rate);
      const commissionCents = roundCents(finalPaymentCents * rate);
      if (commissionCents > 0) {
        await client.query(
          `INSERT INTO partner_commissions
             (partner_id, ride_id, promo_id, promo_code, ride_price_cents,
              commission_rate, commission_cents, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING')
           ON CONFLICT (ride_id) DO NOTHING`,
          [p.partner_id, rideId, usage.promo_id, p.code, finalPaymentCents, rate, commissionCents],
        );
        await client.query(
          `UPDATE partners
           SET pending_earnings_cents = pending_earnings_cents + $1,
               lifetime_earnings_cents = lifetime_earnings_cents + $1,
               total_referred_rides = total_referred_rides + 1,
               updated_at = NOW()
           WHERE id = $2`,
          [commissionCents, p.partner_id],
        );
      }
    }

    await client.query('COMMIT');
  } catch (err: any) {
    try { await client.query('ROLLBACK'); } catch { /* noop */ }
    console.warn(`[PROMO] ⚠️ finalize failed for ride ${rideId}: ${err.message}`);
  } finally {
    client.release();
  }
}

/**
 * Ride CANCELLED: void the pending usage. No usage is consumed, no
 * commission is ever created, and the rider may reuse the promo.
 */
export async function voidPromoForCancelledRide(rideId: string): Promise<void> {
  try {
    await pool.query(
      `UPDATE promo_usage SET status = 'VOID' WHERE ride_id = $1 AND status = 'APPLIED'`,
      [rideId],
    );
  } catch (err: any) {
    console.warn(`[PROMO] ⚠️ void failed for ride ${rideId}: ${err.message}`);
  }
}
