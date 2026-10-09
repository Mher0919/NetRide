// backend/src/services/financial-ledger.service.ts
//
// Server-authoritative financial settlement ledger. Exactly one
// RIDE_COMPLETION row per ride (partial unique index on ride_id), inserted
// idempotently at ride completion time. Money is integer cents.
//
// Revenue rule: a ride counts financially only when its settlement row is
// SETTLED. PENDING_CAPTURE rows keep the ride counted as completed but
// contribute $0 to revenue/earnings/analytics until the outstanding
// amount_owed_cents is captured.

import { pool } from '../config/database';

export type LedgerSettlementStatus = 'SETTLED' | 'PENDING_CAPTURE';

/**
 * Money columns are stored as integer cents (BIGINT). pg returns them as
 * strings; Prisma as BigInt — never multiply by 100. Converts either
 * representation to a plain rounded JS number (0 for garbage/NaN).
 */
export function centsValue(v: any): number {
  const n = Number(v ?? 0);
  return Math.round(Number.isFinite(n) ? n : 0);
}

/**
 * A ride is SETTLED only when the full amount due was covered at
 * completion (either charged from the wallet or fully covered by
 * promo/credits). Anything owed keeps the settlement PENDING_CAPTURE —
 * revenue counts only when settled.
 */
export function settlementStatusFor(amountOwedCents: number): LedgerSettlementStatus {
  return amountOwedCents <= 0 ? 'SETTLED' : 'PENDING_CAPTURE';
}

/** Gross = final fare + promotions absorbed + credits absorbed + tip. */
export function grossAmountCents(
  fareCents: number,
  promotionCents: number,
  creditsCents: number,
  tipCents: number,
): number {
  return (
    centsValue(fareCents) +
    centsValue(promotionCents) +
    centsValue(creditsCents) +
    centsValue(tipCents)
  );
}

export interface RideCompletionInput {
  rideId: string;
  riderId: string | null;
  driverId: string | null;
  fareCents: number;
  promotionCents: number;
  creditsCents: number;
  tipCents: number;
  walletPaymentCents: number;
  amountOwedCents: number;
  driverShareCents: number;
  platformShareCents: number;
  netrideShareCents: number;
  paymentProvider?: string;
  paymentReference?: string;
  completedAt: Date;
  // ---- Stripe / Specials separation (migration 052) -----------------------
  originalFareCents?: number;
  riderShareCents?: number;
  sponsorSubsidyCents?: number;
  sponsorCollectedCents?: number;
  additionalRiderChargeCents?: number;
  stripePaymentIntentId?: string | null;
  sponsorContributionStatus?: string;
  additionalChargeStatus?: string;
}

export class FinancialLedgerService {
  /**
   * Records the single financial settlement for a completed ride.
   * Idempotent: a repeated call (double socket emit, retry after crash,
   * admin re-settlement) is a no-op and returns created=false.
   */
  static async recordRideCompletion(input: RideCompletionInput): Promise<{ created: boolean; row: any }> {
    const status = settlementStatusFor(input.amountOwedCents);
    const gross = grossAmountCents(
      centsValue(input.fareCents),
      centsValue(input.promotionCents),
      centsValue(input.creditsCents),
      centsValue(input.tipCents),
    );

    const res = await pool.query(
      `INSERT INTO financial_transactions (
         ride_id, rider_id, driver_id, type, status, currency,
         gross_amount_cents, fare_cents, promotion_cents, credits_cents,
         tip_cents, wallet_payment_cents, amount_owed_cents,
         driver_share_cents, platform_share_cents, netride_share_cents,
         payment_provider, payment_reference, idempotency_key,
         completed_at, settled_at,
         original_fare_cents, rider_share_cents, sponsor_subsidy_cents,
         sponsor_collected_cents, additional_rider_charge_cents,
         stripe_payment_intent_id, sponsor_contribution_status, additional_charge_status
       ) VALUES (
         $1, $2, $3, 'RIDE_COMPLETION', $4, 'USD',
         $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
         $15, $16, $17, $18, $19,
         $20, $21, $22, $23, $24, $25, $26, $27
       )
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id, status`,
      [
        input.rideId,
        input.riderId,
        input.driverId,
        status,
        gross,
        input.fareCents,
        input.promotionCents,
        input.creditsCents,
        input.tipCents,
        input.walletPaymentCents,
        input.amountOwedCents,
        input.driverShareCents,
        input.platformShareCents,
        input.netrideShareCents,
        input.paymentProvider ?? null,
        input.paymentReference ?? null,
        `ride_completion:${input.rideId}`,
        input.completedAt,
        status === 'SETTLED' ? input.completedAt : null,
        centsValue(input.originalFareCents ?? input.fareCents),
        centsValue(input.riderShareCents ?? input.fareCents),
        centsValue(input.sponsorSubsidyCents ?? 0),
        centsValue(input.sponsorCollectedCents ?? 0),
        centsValue(input.additionalRiderChargeCents ?? 0),
        input.stripePaymentIntentId ?? null,
        input.sponsorContributionStatus ?? 'NONE',
        input.additionalChargeStatus ?? 'NONE',
      ]
    );

    return {
      created: res.rowCount === 1,
      row: res.rows[0],
    };
  }

  /**
   * Applies settlement-component updates to the single RIDE_COMPLETION row.
   * Only the provided fields change; used by the Special redemption/expiry
   * flows (sponsor collected, additional rider charge, settlement status).
   */
  static async applySettlementComponents(args: {
    rideId: string;
    originalFareCents?: number;
    riderShareCents?: number;
    sponsorSubsidyCents?: number;
    sponsorCollectedCents?: number;
    additionalRiderChargeCents?: number;
    driverSettledCents?: number;
    settlementStatus?: string;
    stripePaymentIntentId?: string | null;
    sponsorContributionStatus?: string;
    additionalChargeStatus?: string;
  }): Promise<void> {
    const sets: string[] = [];
    const values: unknown[] = [args.rideId];
    const push = (col: string, value: unknown) => {
      values.push(value);
      sets.push(`${col} = $${values.length}`);
    };
    if (args.originalFareCents !== undefined) push('original_fare_cents', centsValue(args.originalFareCents));
    if (args.riderShareCents !== undefined) push('rider_share_cents', centsValue(args.riderShareCents));
    if (args.sponsorSubsidyCents !== undefined) push('sponsor_subsidy_cents', centsValue(args.sponsorSubsidyCents));
    if (args.sponsorCollectedCents !== undefined) push('sponsor_collected_cents', centsValue(args.sponsorCollectedCents));
    if (args.additionalRiderChargeCents !== undefined) push('additional_rider_charge_cents', centsValue(args.additionalRiderChargeCents));
    if (args.stripePaymentIntentId !== undefined) push('stripe_payment_intent_id', args.stripePaymentIntentId);
    if (args.sponsorContributionStatus !== undefined) push('sponsor_contribution_status', args.sponsorContributionStatus);
    if (args.additionalChargeStatus !== undefined) push('additional_charge_status', args.additionalChargeStatus);
    if (args.settlementStatus !== undefined) {
      push('status', args.settlementStatus === 'SETTLED' ? 'SETTLED' : 'PENDING_CAPTURE');
      if (args.settlementStatus === 'SETTLED') sets.push(`settled_at = COALESCE(settled_at, NOW())`);
    }
    if (sets.length === 0) return;
    sets.push('updated_at = NOW()');
    await pool.query(
      `UPDATE financial_transactions SET ${sets.join(', ')} WHERE ride_id = $1 AND type = 'RIDE_COMPLETION'`,
      values,
    );
  }

  /**
   * Ledger-backed totals for a set of rides (used by the admin Completed
   * Rides page). Returns zeros when the rides have no settlement rows yet.
   */
  static async summarizeRides(rideIds: string[]): Promise<{
    totalGrossCents: number;
    totalFareCents: number;
    totalPromotionCents: number;
    totalCreditsCents: number;
    totalTipCents: number;
    totalDriverCents: number;
    totalPlatformCents: number;
    totalNetrideCents: number;
    settledCount: number;
    pendingCount: number;
  }> {
    if (rideIds.length === 0) {
      return {
        totalGrossCents: 0, totalFareCents: 0, totalPromotionCents: 0,
        totalCreditsCents: 0, totalTipCents: 0, totalDriverCents: 0,
        totalPlatformCents: 0, totalNetrideCents: 0, settledCount: 0,
        pendingCount: 0,
      };
    }
    const res = await pool.query(
      `SELECT
         COALESCE(SUM(gross_amount_cents), 0)        AS total_gross_cents,
         COALESCE(SUM(fare_cents), 0)                AS total_fare_cents,
         COALESCE(SUM(promotion_cents), 0)           AS total_promotion_cents,
         COALESCE(SUM(credits_cents), 0)             AS total_credits_cents,
         COALESCE(SUM(tip_cents), 0)                 AS total_tip_cents,
         COALESCE(SUM(driver_share_cents), 0)        AS total_driver_cents,
         COALESCE(SUM(platform_share_cents), 0)      AS total_platform_cents,
         COALESCE(SUM(netride_share_cents), 0)       AS total_netride_cents,
         COALESCE(COUNT(*) FILTER (WHERE status = 'SETTLED'), 0)         AS settled_count,
         COALESCE(COUNT(*) FILTER (WHERE status = 'PENDING_CAPTURE'), 0) AS pending_count
       FROM financial_transactions
       WHERE ride_id = ANY($1::uuid[])`,
      [rideIds]
    );
    const r = res.rows[0];
    return {
      totalGrossCents: Number(r.total_gross_cents),
      totalFareCents: Number(r.total_fare_cents),
      totalPromotionCents: Number(r.total_promotion_cents),
      totalCreditsCents: Number(r.total_credits_cents),
      totalTipCents: Number(r.total_tip_cents),
      totalDriverCents: Number(r.total_driver_cents),
      totalPlatformCents: Number(r.total_platform_cents),
      totalNetrideCents: Number(r.total_netride_cents),
      settledCount: Number(r.settled_count),
      pendingCount: Number(r.pending_count),
    };
  }
}