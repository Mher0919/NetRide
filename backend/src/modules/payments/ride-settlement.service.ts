// backend/src/modules/payments/ride-settlement.service.ts
//
// RIDE SETTLEMENT — the single place that turns a completed ride and its
// Special lifecycle into money movements.
// ---------------------------------------------------------------------------
// Money model (integer cents, server-authoritative):
//
//   original fare  F  = rider share + sponsor subsidy (+ promo/credits)
//   driver earnings  = commission(F)          ← ALWAYS from the original fare
//   platform         = F − driver earnings
//
//   ordinary ride:       rider shares collected at completion
//   successful special:  rider share + sponsor budget debit
//   expired special:     sponsor pays 0; rider is charged the remaining fare
//
// The driver is credited at completion from the ORIGINAL fare (existing
// `creditOnRideComplete`). Sponsor redemption therefore only records the
// sponsor contribution and, for legacy rides settled from the discounted
// fare, tops the driver up to the commission target — never double-pays.

import { pool } from '../../config/database';
import { FinancialLedgerService } from '../../services/financial-ledger.service';
import { getRevenueAllocationForRide } from '../../services/pricing.service';
import { WalletService } from '../wallet/wallet.service';
import { AuditEventsService } from '../../services/audit-events.service';
import {
  computeFareBreakdownForRide,
  getFareBreakdown,
  snapshotFareBreakdown,
} from './fare-breakdown.service';
import { PaymentsService } from './payments.service';

export type AdditionalChargeStatus = 'NONE' | 'REQUIRED' | 'PROCESSING' | 'COLLECTED' | 'FAILED' | 'WAIVED';
export type SponsorContributionStatus = 'NONE' | 'RESERVED' | 'COLLECTED' | 'RELEASED' | 'FAILED';
export type SettlementStatus = 'PENDING' | 'PARTIALLY_SETTLED' | 'SETTLED' | 'EXCEPTION';

/**
 * Pure helper: the rider's remaining obligation on a Special that expired
 * without redemption. Never exceeds the original fare minus what the rider
 * already paid, and is never negative.
 */
export function additionalChargeDueCents(args: {
  originalFareCents: number;
  riderCollectedCents: number;
}): number {
  const original = Number.isFinite(args.originalFareCents) ? Math.round(args.originalFareCents) : 0;
  const collected = Number.isFinite(args.riderCollectedCents) ? Math.round(args.riderCollectedCents) : 0;
  return Math.max(0, Math.max(0, original) - Math.max(0, collected));
}

/** Pure helper: settlement status from collected vs required. */
export function settlementStatusFor(args: {
  requiredCents: number;
  collectedCents: number;
  sponsorPending: boolean;
  exception: boolean;
}): SettlementStatus {
  if (args.exception) return 'EXCEPTION';
  const required = Math.max(0, Math.round(args.requiredCents));
  const collected = Math.max(0, Math.round(args.collectedCents));
  if (collected >= required && !args.sponsorPending) return 'SETTLED';
  if (collected > 0 || args.sponsorPending) return 'PARTIALLY_SETTLED';
  return 'PENDING';
}

export class RideSettlementService {
  /**
   * Persists the immutable breakdown once the driver (and thus the fleet
   * share) is known — called from the accept path, inside the same data
   * window as the revenue allocation persistence.
   */
  static async snapshotOnAccept(rideId: string, driverId: string): Promise<void> {
    const existing = await getFareBreakdown(rideId);
    if (existing) return;

    const rideRes = await pool.query(
      `SELECT r.*, s.final_fare
       FROM rides r
       LEFT JOIN ride_price_snapshots s ON s.ride_id = r.id
       WHERE r.id = $1`,
      [rideId],
    );
    const ride = rideRes.rows[0];
    if (!ride) return;

    const originalFareCents = ride.final_fare != null
      ? Math.round(Number(ride.final_fare) * 100)
      : Math.round(Number(ride.fare_amount ?? 0) * 100);
    const allocation = await getRevenueAllocationForRide(rideId);
    if (!allocation) {
      // Allocation persistence failed at accept; recompute deterministically
      // from the configured split so the snapshot is never skipped.
      const breakdown = await computeFareBreakdownForRide({
        originalFareCents,
        promoDiscountCents: Number(ride.promo_discount_cents ?? 0),
        creditsAppliedCents: Number(ride.credits_applied_cents ?? 0),
        sponsorSubsidyCents: Number(ride.sponsor_discount_cents ?? 0),
        driverId,
      });
      await snapshotFareBreakdown(rideId, breakdown, {
        specialRedemptionId: await this.redemptionIdForRide(rideId),
        consentAt: ride.special_terms_accepted_at ?? null,
      });
      return;
    }

    const breakdown = await computeFareBreakdownForRide({
      originalFareCents,
      promoDiscountCents: Number(ride.promo_discount_cents ?? 0),
      creditsAppliedCents: Number(ride.credits_applied_cents ?? 0),
      sponsorSubsidyCents: Number(ride.sponsor_discount_cents ?? 0),
      driverId,
      allocation,
    });
    await snapshotFareBreakdown(rideId, breakdown, {
      specialRedemptionId: await this.redemptionIdForRide(rideId),
      consentAt: ride.special_terms_accepted_at ?? null,
    });
  }

  private static async redemptionIdForRide(rideId: string): Promise<string | null> {
    const res = await pool.query(
      `SELECT id FROM special_redemptions WHERE ride_id = $1`,
      [rideId],
    );
    return res.rows[0]?.id ?? null;
  }

  /**
   * Settlement pass at ride completion (after the existing wallet charge /
   * driver credit). Collects any rider shortfall through Stripe when a saved
   * card exists, records the components, and marks the ride's settlement
   * state. Non-blocking for the ride lifecycle.
   */
  static async onRideCompleted(rideId: string): Promise<void> {
    try {
      const breakdown = await getFareBreakdown(rideId);
      if (!breakdown) return;
      const settlement = await pool.query(`SELECT * FROM financial_transactions WHERE ride_id = $1`, [rideId]);
      const tx = settlement.rows[0];

      const walletCollected = Number(tx?.wallet_payment_cents ?? 0);
      let riderCollected = Math.max(0, walletCollected);
      let riderPaymentIntentId: string | null = breakdown.rider_payment_intent_id ?? null;

      const riderShare = Number(breakdown.rider_share_cents ?? 0);
      const sponsorSubsidy = Number(breakdown.sponsor_subsidy_cents ?? 0);
      const specialPending = await this.hasPendingSpecial(rideId);
      const shortfall = Math.max(0, riderShare - riderCollected);

      // Ordinary rides (and specials whose rider share failed) collect the
      // remainder from the saved card off-session. A pending special keeps
      // the remainder for the expiry/redemption flow only when the rider
      // share itself was collected — otherwise it is a real exception.
      if (shortfall > 0) {
        const result = await PaymentsService.chargeRiderOffSession({
          riderId: tx?.rider_id ?? (await this.riderForRide(rideId)),
          amountCents: shortfall,
          purpose: 'RIDE_CHARGE',
          rideId,
          description: `NetRide fare for ride ${rideId}`,
          idempotencyKey: `ride-charge:${rideId}`,
          requireConsent: specialPending === true,
        });
        if (result.ok) {
          riderCollected += shortfall;
          riderPaymentIntentId = result.paymentIntentId ?? riderPaymentIntentId;
        }
      }

      const collected = Math.min(riderShare, riderCollected);
      const sponsorStatus: SponsorContributionStatus = sponsorSubsidy > 0
        ? (specialPending ? 'RESERVED' : 'NONE')
        : 'NONE';
      const exception = collected < riderShare;
      const settlementStatus = settlementStatusFor({
        requiredCents: Number(breakdown.original_fare_cents ?? 0),
        collectedCents: collected,
        sponsorPending: specialPending,
        exception,
      });

      await pool.query(
        `UPDATE ride_fare_breakdowns
         SET rider_collected_cents = $2,
             rider_payment_intent_id = COALESCE($3, rider_payment_intent_id),
             sponsor_contribution_status = $4,
             driver_settled_cents = GREATEST(driver_settled_cents, $5),
             driver_settled_at = COALESCE(driver_settled_at, NOW()),
             settlement_status = $6,
             updated_at = NOW()
         WHERE ride_id = $1`,
        [rideId, collected, riderPaymentIntentId, sponsorStatus, Number(breakdown.driver_earnings_cents ?? 0), settlementStatus],
      );

      await FinancialLedgerService.applySettlementComponents({
        rideId,
        originalFareCents: Number(breakdown.original_fare_cents ?? 0),
        riderShareCents: riderShare,
        sponsorSubsidyCents: sponsorSubsidy,
        sponsorCollectedCents: 0,
        additionalRiderChargeCents: 0,
        driverSettledCents: Number(breakdown.driver_earnings_cents ?? 0),
        settlementStatus,
        stripePaymentIntentId: riderPaymentIntentId,
        sponsorContributionStatus: sponsorStatus,
        additionalChargeStatus: exception ? 'REQUIRED' : 'NONE',
      });

      if (exception) {
        await AuditEventsService.record({
          actorRole: 'SYSTEM',
          action: 'ride_settlement_exception',
          entityType: 'ride',
          entityId: rideId,
          details: { riderShareCents: riderShare, riderCollectedCents: collected, sponsorPending: specialPending },
        }).catch(() => undefined);
      }
    } catch (err: any) {
      console.warn(`[SETTLEMENT] ⚠️ completion settlement failed for ${rideId}: ${err.message}`);
    }
  }

  private static async riderForRide(rideId: string): Promise<string> {
    const res = await pool.query(`SELECT rider_id FROM rides WHERE id = $1`, [rideId]);
    return res.rows[0]?.rider_id;
  }

  private static async hasPendingSpecial(rideId: string): Promise<boolean> {
    const res = await pool.query(
      `SELECT id FROM special_redemptions
       WHERE ride_id = $1 AND status IN ('RIDE_PENDING','WAITING_FOR_SPONSOR','SPONSOR_VALIDATED','REWARD_SELECTED','REWARD_FAILED')`,
      [rideId],
    );
    return res.rows.length > 0;
  }

  /**
   * Called after a successful sponsor redemption settlement (existing
   * `riderChooseReward` transaction committed). Records the sponsor
   * contribution and tops the driver up to the ORIGINAL-fare commission when
   * the completion credit was computed from a discounted fare (legacy
   * accounting). Idempotent.
   */
  static async onSpecialRedemptionSettled(args: {
    redemptionId: string;
    rideId: string | null;
    sponsorFundedCents: number;
    driverId: string | null;
  }): Promise<void> {
    if (!args.rideId) return;
    const breakdown = await getFareBreakdown(args.rideId);
    if (!breakdown) return;

    const sponsorFunded = Math.max(0, Math.round(args.sponsorFundedCents));
    const alreadyCollected = Number(breakdown.sponsor_collected_cents ?? 0);
    if (alreadyCollected >= sponsorFunded) return; // idempotent

    // Driver true-up: completion already paid the ORIGINAL-fare share in the
    // current accounting, so this is normally a no-op. Legacy rides paid from
    // the discounted fare get the difference.
    const targetEarnings = Number(breakdown.driver_earnings_cents ?? 0);
    const driverSettled = Number(breakdown.driver_settled_cents ?? 0);
    const topUp = Math.max(0, targetEarnings - driverSettled);
    if (topUp > 0 && args.driverId) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO driver_wallets (driver_id) VALUES ($1) ON CONFLICT (driver_id) DO NOTHING`,
          [args.driverId],
        );
        await client.query(
          `UPDATE driver_wallets
           SET balance_cents = balance_cents + $2,
               lifetime_earnings_cents = lifetime_earnings_cents + $2,
               updated_at = NOW()
           WHERE driver_id = $1`,
          [args.driverId, topUp],
        );
        await client.query(
          `INSERT INTO payouts (driver_id, amount_cents, fee_cents, net_cents, status, method, ride_id, notes)
           VALUES ($1, $2, 0, $2, 'PAID', 'SPECIAL_TOPUP', $3, $4)
           ON CONFLICT (ride_id) WHERE method = 'SPECIAL_TOPUP' DO NOTHING`,
          [args.driverId, topUp, args.rideId, `Driver earnings true-up for special redemption ${args.redemptionId}`],
        );
        await client.query(
          `UPDATE ride_fare_breakdowns
           SET driver_settled_cents = $2, driver_settled_at = COALESCE(driver_settled_at, NOW()), updated_at = NOW()
           WHERE ride_id = $1`,
          [args.rideId, targetEarnings],
        );
        await client.query('COMMIT');
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* noop */ }
        throw err;
      } finally {
        client.release();
      }
    }

    const collected = alreadyCollected + sponsorFunded;
    const newSettlement = settlementStatusFor({
      requiredCents: Number(breakdown.original_fare_cents ?? 0),
      collectedCents: Number(breakdown.rider_collected_cents ?? 0) + collected,
      sponsorPending: false,
      exception: false,
    });
    await pool.query(
      `UPDATE ride_fare_breakdowns
       SET sponsor_collected_cents = $2,
           sponsor_contribution_status = 'COLLECTED',
           sponsor_settled_at = COALESCE(sponsor_settled_at, NOW()),
           settlement_status = $3,
           settled_at = CASE WHEN $3 = 'SETTLED' THEN NOW() ELSE settled_at END,
           updated_at = NOW()
       WHERE ride_id = $1`,
      [args.rideId, collected, newSettlement],
    );

    await FinancialLedgerService.applySettlementComponents({
      rideId: args.rideId,
      sponsorCollectedCents: collected,
      sponsorContributionStatus: 'COLLECTED',
      settlementStatus: newSettlement,
    });
  }

  /**
   * Special expired without redemption. Atomically claims the redemption,
   * releases the sponsor reservation, and collects the remaining fare from
   * the rider (wallet first, then saved card off-session). Idempotent under
   * repeated job executions and duplicate webhooks.
   */
  static async onSpecialExpired(args: {
    redemptionId: string;
    rideId: string | null;
    riderId: string;
  }): Promise<{ charged: boolean; chargedCents: number; status: AdditionalChargeStatus }> {
    if (!args.rideId) return { charged: false, chargedCents: 0, status: 'NONE' };
    const rideId = args.rideId;

    // Claim the ride's additional-charge work. Only one worker proceeds.
    const claim = await pool.query(
      `UPDATE ride_fare_breakdowns
       SET additional_charge_status = 'PROCESSING',
           additional_rider_charge_cents = GREATEST(0, original_fare_cents - rider_collected_cents),
           expiration_processed_at = NOW(),
           updated_at = NOW()
       WHERE ride_id = $1
         AND rider_collected_cents < original_fare_cents
         AND additional_charge_status IN ('NONE','REQUIRED','FAILED')
       RETURNING *`,
      [rideId],
    );
    if (claim.rows.length === 0) {
      const existing = await getFareBreakdown(rideId);
      return {
        charged: existing?.additional_charge_status === 'COLLECTED',
        chargedCents: Number(existing?.additional_rider_charge_cents ?? 0),
        status: (existing?.additional_charge_status ?? 'NONE') as AdditionalChargeStatus,
      };
    }
    const breakdown = claim.rows[0];

    const due = additionalChargeDueCents({
      originalFareCents: Number(breakdown.original_fare_cents ?? 0),
      riderCollectedCents: Number(breakdown.rider_collected_cents ?? 0),
    });
    if (due <= 0) {
      return { charged: true, chargedCents: 0, status: 'COLLECTED' };
    }

    // Consent is mandatory for any collection triggered by expiry.
    const consentRes = await pool.query(
      `SELECT special_terms_accepted_at FROM rides WHERE id = $1`,
      [rideId],
    );
    if (!consentRes.rows[0]?.special_terms_accepted_at) {
      await pool.query(
        `UPDATE ride_fare_breakdowns
         SET additional_charge_status = 'REQUIRED', settlement_status = 'EXCEPTION',
             reconciliation_note = 'Rider did not accept Special terms — additional charge requires manual resolution',
             updated_at = NOW()
         WHERE ride_id = $1`,
        [rideId],
      );
      await AuditEventsService.record({
        actorRole: 'SYSTEM',
        action: 'special_expiry_consent_missing',
        entityType: 'ride',
        entityId: rideId,
        details: { dueCents: due, redemptionId: args.redemptionId },
      }).catch(() => undefined);
      return { charged: false, chargedCents: 0, status: 'REQUIRED' };
    }

    let collectedNow = 0;
    let useStripe = false;
    let stripePaymentIntentId: string | null = null;

    // 1. Internal wallet first (guarded debit; empty wallet fails fast).
    try {
      const wallet = await WalletService.post(args.riderId, -due, 'RIDE_PAYMENT', {
        idempotencyKey: `wallet-additional:${rideId}`,
        description: `Remaining fare for expired special on ride ${rideId}`,
        referenceType: 'ride_expiration',
        referenceId: args.redemptionId,
        rideId,
      });
      if (wallet.applied) collectedNow = due;
    } catch {
      // insufficient wallet balance — fall through to the card
      useStripe = true;
    }

    // 2. Saved card off-session for whatever the wallet could not cover.
    const remaining = due - collectedNow;
    let chargeStatus: AdditionalChargeStatus = 'FAILED';
    if (remaining > 0 && useStripe !== false) {
      const result = await PaymentsService.chargeRiderOffSession({
        riderId: args.riderId,
        amountCents: remaining,
        purpose: 'RIDE_ADDITIONAL_CHARGE',
        rideId,
        description: `Remaining fare for expired special on ride ${rideId}`,
        idempotencyKey: `additional-charge:${rideId}:${await this.additionalChargeAttempt(rideId)}`,
        requireConsent: true,
      });
      if (result.ok) {
        collectedNow += remaining;
        stripePaymentIntentId = result.paymentIntentId ?? null;
        chargeStatus = 'COLLECTED';
      } else if (result.reason === 'requires_action') {
        chargeStatus = 'REQUIRED';
      } else {
        chargeStatus = 'FAILED';
      }
    } else if (remaining <= 0) {
      chargeStatus = 'COLLECTED';
    }

    const totalCollected = Number(breakdown.rider_collected_cents ?? 0) + collectedNow;
    const fullyCollected = totalCollected >= Number(breakdown.original_fare_cents ?? 0);
    const finalStatus: AdditionalChargeStatus = fullyCollected ? 'COLLECTED' : chargeStatus;
    const newSettlement = settlementStatusFor({
      requiredCents: Number(breakdown.original_fare_cents ?? 0),
      collectedCents: totalCollected,
      sponsorPending: false,
      exception: !fullyCollected,
    });

    await pool.query(
      `UPDATE ride_fare_breakdowns
       SET rider_collected_cents = $2,
           additional_charge_status = $3,
           additional_charge_payment_intent_id = COALESCE($4, additional_charge_payment_intent_id),
           additional_charge_collected_at = CASE WHEN $3 = 'COLLECTED' THEN NOW() ELSE additional_charge_collected_at END,
           sponsor_contribution_status = 'RELEASED',
           settlement_status = $5,
           settled_at = CASE WHEN $5 = 'SETTLED' THEN NOW() ELSE settled_at END,
           updated_at = NOW()
       WHERE ride_id = $1`,
      [rideId, totalCollected, finalStatus, stripePaymentIntentId, newSettlement],
    );

    await FinancialLedgerService.applySettlementComponents({
      rideId,
      additionalRiderChargeCents: collectedNow,
      sponsorCollectedCents: 0,
      sponsorContributionStatus: 'RELEASED',
      additionalChargeStatus: finalStatus,
      settlementStatus: newSettlement,
      stripePaymentIntentId,
    });

    await AuditEventsService.record({
      actorRole: 'SYSTEM',
      action: 'special_expiry_additional_charge',
      entityType: 'ride',
      entityId: rideId,
      details: {
        redemptionId: args.redemptionId,
        dueCents: due,
        collectedCents: collectedNow,
        status: finalStatus,
      },
    }).catch(() => undefined);

    return { charged: fullyCollected, chargedCents: collectedNow, status: finalStatus };
  }

  private static async additionalChargeAttempt(rideId: string): Promise<number> {
    const res = await pool.query(
      `SELECT COUNT(*)::int AS n FROM stripe_payments
       WHERE ride_id = $1 AND purpose = 'RIDE_ADDITIONAL_CHARGE'`,
      [rideId],
    );
    return Number(res.rows[0]?.n ?? 0) + 1;
  }

  /**
   * Retry sweep for expired specials whose additional charge is still
   * outstanding (declines, authentication required, wallet-only riders who
   * later top up). Safe to run repeatedly. Retries are capped.
   */
  static async sweepExpiredAdditionalCharges(): Promise<number> {
    const res = await pool.query(
      `SELECT b.ride_id, s.rider_id, s.id AS redemption_id
       FROM ride_fare_breakdowns b
       JOIN special_redemptions s ON s.ride_id = b.ride_id AND s.status = 'EXPIRED'
       WHERE b.additional_charge_status IN ('REQUIRED','FAILED')
         AND b.rider_collected_cents < b.original_fare_cents
         AND b.expiration_processed_at IS NOT NULL
         AND b.updated_at < NOW() - INTERVAL '10 minutes'
       ORDER BY b.updated_at ASC
       LIMIT 25`,
    );
    let processed = 0;
    for (const row of res.rows) {
      const attempts = await this.additionalChargeAttempt(row.ride_id);
      if (attempts > 3) {
        await pool.query(
          `UPDATE ride_fare_breakdowns
           SET reconciliation_note = COALESCE(reconciliation_note, 'Additional charge failed after maximum retries'),
               settlement_status = 'EXCEPTION', updated_at = NOW()
           WHERE ride_id = $1 AND additional_charge_status <> 'COLLECTED'`,
          [row.ride_id],
        );
        continue;
      }
      try {
        await this.onSpecialExpired({
          redemptionId: row.redemption_id,
          rideId: row.ride_id,
          riderId: row.rider_id,
        });
        processed++;
      } catch (err: any) {
        console.warn(`[SETTLEMENT] ⚠️ expiry retry failed for ${row.ride_id}: ${err.message}`);
      }
    }
    return processed;
  }

  /** Recomputes settlement status for a ride from its persisted components. */
  static async recomputeSettlementStatus(rideId: string): Promise<SettlementStatus | null> {
    const breakdown = await getFareBreakdown(rideId);
    if (!breakdown) return null;
    const sponsorPending = await this.hasPendingSpecial(rideId)
      && breakdown.sponsor_contribution_status === 'RESERVED';
    const total = Number(breakdown.rider_collected_cents ?? 0) + Number(breakdown.sponsor_collected_cents ?? 0);
    const status = settlementStatusFor({
      requiredCents: Number(breakdown.original_fare_cents ?? 0),
      collectedCents: total,
      sponsorPending,
      exception: breakdown.additional_charge_status === 'FAILED' && total < Number(breakdown.original_fare_cents ?? 0),
    });
    if (status !== breakdown.settlement_status) {
      await pool.query(
        `UPDATE ride_fare_breakdowns SET settlement_status = $2, updated_at = NOW() WHERE ride_id = $1`,
        [rideId, status],
      );
      await FinancialLedgerService.applySettlementComponents({ rideId, settlementStatus: status });
    }
    return status;
  }

  /** Admin/automation: retry the additional charge for one expired ride. */
  static async retryAdditionalCharge(rideId: string): Promise<{ charged: boolean; chargedCents: number; status: AdditionalChargeStatus }> {
    const res = await pool.query(
      `SELECT s.id AS redemption_id, s.rider_id
       FROM special_redemptions s
       WHERE s.ride_id = $1 AND s.status = 'EXPIRED'`,
      [rideId],
    );
    const row = res.rows[0];
    if (!row) throw new Error('Ride is not an expired special');
    return this.onSpecialExpired({ redemptionId: row.redemption_id, rideId, riderId: row.rider_id });
  }

  /**
   * Webhook/reconciliation path for a succeeded ride charge (ordinary fare or
   * Special additional charge). Idempotent: the breakdown only counts a
   * PaymentIntent once, keyed on the stored payment-intent id.
   */
  static async applyStripeChargeSucceeded(args: {
    purpose: string;
    rideId: string | null;
    amountCents: number;
    paymentIntentId: string | null;
  }): Promise<void> {
    if (!args.rideId) return;
    if (args.purpose !== 'RIDE_CHARGE' && args.purpose !== 'RIDE_ADDITIONAL_CHARGE') return;

    const breakdown = await getFareBreakdown(args.rideId);
    if (!breakdown) return;

    if (args.purpose === 'RIDE_ADDITIONAL_CHARGE') {
      if (args.paymentIntentId && breakdown.additional_charge_payment_intent_id === args.paymentIntentId) return;
      if (breakdown.additional_charge_status === 'COLLECTED') return;
      const total = Math.min(
        Number(breakdown.original_fare_cents ?? 0),
        Number(breakdown.rider_collected_cents ?? 0) + Math.max(0, Math.round(args.amountCents)),
      );
      const fully = total >= Number(breakdown.original_fare_cents ?? 0);
      await pool.query(
        `UPDATE ride_fare_breakdowns
         SET rider_collected_cents = $2,
             additional_charge_status = $3,
             additional_charge_payment_intent_id = COALESCE($4, additional_charge_payment_intent_id),
             additional_charge_collected_at = CASE WHEN $3 = 'COLLECTED' THEN NOW() ELSE additional_charge_collected_at END,
             updated_at = NOW()
         WHERE ride_id = $1`,
        [args.rideId, total, fully ? 'COLLECTED' : 'REQUIRED', args.paymentIntentId],
      );
      await FinancialLedgerService.applySettlementComponents({
        rideId: args.rideId,
        additionalRiderChargeCents: Math.max(0, Math.round(args.amountCents)),
        additionalChargeStatus: fully ? 'COLLECTED' : 'REQUIRED',
        stripePaymentIntentId: args.paymentIntentId,
      });
      await this.recomputeSettlementStatus(args.rideId);
      return;
    }

    if (args.paymentIntentId && breakdown.rider_payment_intent_id === args.paymentIntentId) return;
    const riderShare = Number(breakdown.rider_share_cents ?? 0);
    const total = Math.min(riderShare, Number(breakdown.rider_collected_cents ?? 0) + Math.max(0, Math.round(args.amountCents)));
    await pool.query(
      `UPDATE ride_fare_breakdowns
       SET rider_collected_cents = $2,
           rider_payment_intent_id = COALESCE($3, rider_payment_intent_id),
           updated_at = NOW()
       WHERE ride_id = $1`,
      [args.rideId, total, args.paymentIntentId],
    );
    await FinancialLedgerService.applySettlementComponents({
      rideId: args.rideId,
      stripePaymentIntentId: args.paymentIntentId,
    });
    await this.recomputeSettlementStatus(args.rideId);
  }

  /**
   * Webhook path for a failed/canceled ride charge. Only flips the
   * additional-charge state; never marks a payment as paid.
   */
  static async applyStripeChargeFailed(args: {
    purpose: string;
    rideId: string | null;
    failureReason: string | null;
  }): Promise<void> {
    if (!args.rideId) return;
    if (args.purpose === 'RIDE_ADDITIONAL_CHARGE') {
      await pool.query(
        `UPDATE ride_fare_breakdowns
         SET additional_charge_status = 'FAILED',
             reconciliation_note = COALESCE($2, reconciliation_note),
             settlement_status = CASE WHEN rider_collected_cents < original_fare_cents THEN 'EXCEPTION' ELSE settlement_status END,
             updated_at = NOW()
         WHERE ride_id = $1 AND additional_charge_status <> 'COLLECTED'`,
        [args.rideId, args.failureReason],
      );
      await this.recomputeSettlementStatus(args.rideId);
    }
  }
}
