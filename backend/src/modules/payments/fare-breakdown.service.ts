// backend/src/modules/payments/fare-breakdown.service.ts
//
// AUTHORITATIVE FARE BREAKDOWN
// ---------------------------------------------------------------------------
// One immutable snapshot per ride, computed SERVER-SIDE from:
//   * the quoted fare snapshot (ride_price_snapshots.final_fare),
//   * the applied promo / credits (rides row),
//   * the reserved sponsor subsidy (special_redemptions.calculated_discount_cents),
//   * the configured revenue split (revenue_configs + fleet partners).
//
// The invariant that defines the whole Specials economy:
//
//   driver_earnings_cents = commission(ORIGINAL fare)
//
// A Special changes WHO FUNDS the fare (rider + sponsor), never the fare the
// driver's earnings are calculated from.
//
// All amounts are integer cents. Clients never submit authoritative amounts;
// this module is the only writer of `ride_fare_breakdowns`.

import { pool } from '../../config/database';
import {
  computeRevenueSplit,
  getFleetPartners,
  getRevenueConfig,
  type RevenueAllocation,
} from '../../services/pricing.service';

export interface FareBreakdownInput {
  originalFareCents: number;
  promoDiscountCents?: number;
  creditsAppliedCents?: number;
  sponsorSubsidyCents?: number;
  allocation: RevenueAllocation;
}

export interface FareBreakdown {
  originalFareCents: number;
  promoDiscountCents: number;
  creditsAppliedCents: number;
  sponsorSubsidyCents: number;
  riderShareCents: number;
  driverEarningsCents: number;
  platformCommissionCents: number;
  fleetShareCents: number;
  driverSharePercent: number;
  platformSharePercent: number;
}

export class FareBreakdownValidationError extends Error {
  readonly code = 'FARE_BREAKDOWN_INVALID';
}

function cents(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/**
 * Pure, deterministic breakdown. Throws FareBreakdownValidationError when the
 * components cannot reconcile — a ride that cannot be reconciled is never
 * silently persisted.
 */
export function computeFareBreakdown(input: FareBreakdownInput): FareBreakdown {
  const originalFareCents = cents(input.originalFareCents);
  const promoDiscountCents = cents(input.promoDiscountCents);
  const creditsAppliedCents = cents(input.creditsAppliedCents);
  const sponsorSubsidyCents = cents(input.sponsorSubsidyCents);

  if (originalFareCents < 0 || promoDiscountCents < 0 || creditsAppliedCents < 0 || sponsorSubsidyCents < 0) {
    throw new FareBreakdownValidationError('Fare components must be non-negative');
  }
  if (sponsorSubsidyCents > originalFareCents) {
    throw new FareBreakdownValidationError('Sponsor subsidy cannot exceed the original fare');
  }
  const discounts = promoDiscountCents + creditsAppliedCents + sponsorSubsidyCents;
  if (discounts > originalFareCents) {
    throw new FareBreakdownValidationError('Combined discounts cannot exceed the original fare');
  }

  const riderShareCents = originalFareCents - discounts;

  const allocation = input.allocation;
  const driverEarningsCents = cents(allocation.driverShareCents);
  const platformCommissionCents = cents(allocation.platformShareCents);
  const fleetShareCents = (allocation.fleetShares ?? []).reduce(
    (sum, f) => sum + cents(f.cents),
    0,
  );

  // Cent-exact reconciliation against the ORIGINAL fare.
  const driverPlusPlatform = driverEarningsCents + platformCommissionCents;
  const delta = driverPlusPlatform - originalFareCents;
  // Allow at most a cent of rounding drift from the configured split; the
  // revenue splitter itself guarantees exactness, so anything else is a bug.
  if (Math.abs(delta) > 1) {
    throw new FareBreakdownValidationError(
      `Driver/platform allocation does not reconcile with the original fare (delta=${delta})`,
    );
  }

  return {
    originalFareCents,
    promoDiscountCents,
    creditsAppliedCents,
    sponsorSubsidyCents,
    riderShareCents,
    driverEarningsCents,
    platformCommissionCents,
    fleetShareCents,
    driverSharePercent: allocation.driverSharePercent,
    platformSharePercent: allocation.platformSharePercent,
  };
}

/**
 * Computes the authoritative breakdown from live configuration for a ride.
 * `driverId` selects the fleet sub-share exactly like completion does.
 */
export async function computeFareBreakdownForRide(args: {
  originalFareCents: number;
  promoDiscountCents?: number;
  creditsAppliedCents?: number;
  sponsorSubsidyCents?: number;
  driverId?: string | null;
  /** Pre-computed allocation (accept path already persisted it). */
  allocation?: RevenueAllocation | null;
}): Promise<FareBreakdown> {
  let allocation = args.allocation ?? null;
  if (!allocation) {
    let fleetId: string | null = null;
    if (args.driverId) {
      const res = await pool.query('SELECT fleet_id FROM drivers WHERE user_id = $1', [args.driverId]);
      fleetId = res.rows[0]?.fleet_id ?? null;
    }
    const [config, fleets] = await Promise.all([getRevenueConfig(), getFleetPartners()]);
    allocation = computeRevenueSplit(Math.round(args.originalFareCents), fleetId, config, fleets);
  }
  return computeFareBreakdown({
    originalFareCents: args.originalFareCents,
    promoDiscountCents: args.promoDiscountCents,
    creditsAppliedCents: args.creditsAppliedCents,
    sponsorSubsidyCents: args.sponsorSubsidyCents,
    allocation,
  });
}

/**
 * Persists the immutable snapshot for a ride. Idempotent: an existing row is
 * returned untouched (an accepted ride's financial obligations can never be
 * silently rewritten).
 */
export async function snapshotFareBreakdown(
  rideId: string,
  breakdown: FareBreakdown,
  opts: { client?: any; specialRedemptionId?: string | null; consentAt?: Date | null } = {},
): Promise<any> {
  const db = opts.client ?? pool;
  const res = await db.query(
    `INSERT INTO ride_fare_breakdowns (
       ride_id, special_redemption_id, currency,
       original_fare_cents, promo_discount_cents, credits_applied_cents,
       sponsor_subsidy_cents, rider_share_cents,
       driver_earnings_cents, platform_commission_cents, fleet_share_cents,
       driver_share_percent, platform_share_percent,
       sponsor_contribution_status, additional_charge_status,
       additional_charge_consent_at,
       settlement_status
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
       $14, $15, $16, $17
     )
     ON CONFLICT (ride_id) DO NOTHING
     RETURNING *`,
    [
      rideId,
      opts.specialRedemptionId ?? null,
      'USD',
      breakdown.originalFareCents,
      breakdown.promoDiscountCents,
      breakdown.creditsAppliedCents,
      breakdown.sponsorSubsidyCents,
      breakdown.riderShareCents,
      breakdown.driverEarningsCents,
      breakdown.platformCommissionCents,
      breakdown.fleetShareCents,
      breakdown.driverSharePercent,
      breakdown.platformSharePercent,
      breakdown.sponsorSubsidyCents > 0 ? 'RESERVED' : 'NONE',
      'NONE',
      opts.consentAt ?? null,
      'PENDING',
    ],
  );
  if (res.rows.length > 0) return res.rows[0];
  const existing = await db.query(`SELECT * FROM ride_fare_breakdowns WHERE ride_id = $1`, [rideId]);
  return existing.rows[0];
}

export async function getFareBreakdown(rideId: string): Promise<any | null> {
  const res = await pool.query(`SELECT * FROM ride_fare_breakdowns WHERE ride_id = $1`, [rideId]);
  return res.rows[0] ?? null;
}
