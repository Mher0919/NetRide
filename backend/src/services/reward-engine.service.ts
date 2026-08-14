// backend/src/services/reward-engine.service.ts
//
// REWARD ENGINE — orchestrates the rewards ecosystem around ride events.
// ---------------------------------------------------------------------------
// The ONLY place the ride lifecycle touches promos, credits, commissions and
// referral rewards. Called from RideService (request / complete / cancel).
//
//   ride REQUESTED  → promo validation + credits debit (authoritative, runs
//                     inside the ride's own transaction) + referral state.
//                     The WALLET IS NOT CHARGED here — the rider pays ONLY
//                     when the ride completes successfully (final_payment_cents
//                     is reserved now and settled at completion).
//   ride COMPLETED  → promo usage USED + partner commission accrual
//                     + referral reward grant (both $5s — once, idempotently).
//                     The rider's wallet charge + driver payout both settle
//                     in the completion block of RideService.updateTripStatus.
//   ride CANCELLED  → promo usage VOID + credits refunded. No wallet refund
//                     is needed because nothing was ever charged.

import { pool } from '../config/database';
import { applyPromoToRide, finalizePromoForCompletedRide, voidPromoForCancelledRide } from '../modules/promo/promo.service';
import { CreditsService } from '../modules/credits/credits.service';
import { WalletService } from '../modules/wallet/wallet.service';
import { ReferralService } from '../modules/referral/referral.service';
import {
  notifyPromoApplied,
  notifyCreditsApplied,
} from './notification.service';

export interface RideEvent {
  id: string;
  rider_id: string;
  driver_id: string | null;
  fare_amount: string | number | null;
  status: string;
}

export class RewardEngine {
  /**
   * Applies promo + credits bookkeeping to a ride at request time and
   * RESERVES the final amount due. Runs INSIDE the caller's transaction
   * (client) so ride row + promo usage + credit ledger commit atomically.
   *
   * Payment order (server-authoritative): fare → promo discount → credits
   * discount → wallet pays the rest AT COMPLETION (never at request — a
   * cancelled ride costs nothing). The client never sends amounts — it
   * only signals intent (promo code, credit amount hint).
   *
   * Returns the applied amounts, or throws a user-safe error when the
   * promo is invalid — the ride request fails so the rider can fix the
   * code and re-request.
   */
  static async applyToRideRequest(
    client: any,
    args: {
      riderId: string;
      rideId: string;
      fareCents: number;
      promoCode?: string | null;
      applyCredits?: boolean;
      creditUseCents?: number;
    },
  ): Promise<{ discountCents: number; creditsAppliedCents: number; walletPaymentCents: number; finalPaymentCents: number }> {
    const { riderId, rideId, fareCents } = args;
    const promoCode = String(args.promoCode ?? '').trim().toUpperCase();

    let promoApplied: Awaited<ReturnType<typeof applyPromoToRide>> | null = null;
    if (promoCode) {
      promoApplied = await applyPromoToRide(client, riderId, rideId, promoCode, fareCents);
    }

    const discountCents = promoApplied?.discountCents ?? 0;
    const remaining = Math.max(0, fareCents - discountCents);
    const credits = args.applyCredits
      ? await CreditsService.applyToRide(riderId, rideId, remaining, {
          client,
          capCents: args.creditUseCents,
        })
      : { appliedCents: 0, balanceCents: 0 };
    const dueAfterCredits = Math.max(0, remaining - credits.appliedCents);

    // The wallet is the default payment method, but it is charged ONLY at
    // completion. Here we just reserve the amount due (fare - promo -
    // credits) on the ride row so the completion block knows what to settle.
    const finalPaymentCents = dueAfterCredits;

    await client.query(
      `UPDATE rides
       SET promo_id = $1, promo_code = $2, promo_discount_cents = $3,
           credits_applied_cents = $4, wallet_payment_cents = $5,
           final_payment_cents = $6
       WHERE id = $7`,
      [
        promoApplied?.promo.id ?? null,
        promoApplied?.promo.code ?? null,
        discountCents,
        credits.appliedCents,
        0,
        finalPaymentCents,
        rideId,
      ],
    );

    // Best-effort post-request notifications (fire and forget). Each one is
    // recorded in the persisted feed AND pushed to every device once —
    // deduplicated by eventId (rideId-scoped). The wallet-charged notice
    // is deferred to completion (payment settles there).
    if (promoApplied) {
      notifyPromoApplied(riderId, promoApplied.promo.code, discountCents, rideId).catch(() => undefined);
    }
    if (credits.appliedCents > 0) {
      notifyCreditsApplied(riderId, credits.appliedCents, rideId).catch(() => undefined);
    }

    return {
      discountCents,
      creditsAppliedCents: credits.appliedCents,
      walletPaymentCents: 0,
      finalPaymentCents,
    };
  }

  /**
   * Called when a ride REQUESTED. Marks referral state (first ride pending)
   * — best-effort, never blocks the request.
   */
  static async onRideRequested(ride: RideEvent): Promise<void> {
    try {
      await ReferralService.markFirstRideRequested(ride.rider_id);
    } catch (err: any) {
      console.warn(`[REWARD] ⚠️ onRideRequested failed: ${err.message}`);
    }
  }

  /**
   * Called when a ride COMPLETED (payment finalized). Promotes promo usage
   * to USED + accrues the partner commission, and grants any referral
   * rewards. Fully idempotent — safe to call twice.
   */
  static async onRideCompleted(ride: RideEvent): Promise<void> {
    try {
      await finalizePromoForCompletedRide(ride.id);
    } catch (err: any) {
      console.warn(`[REWARD] ⚠️ promo finalize failed: ${err.message}`);
    }
    try {
      await ReferralService.processFirstRideCompleted(ride);
    } catch (err: any) {
      console.warn(`[REWARD] ⚠️ referral reward failed: ${err.message}`);
    }
  }

  /**
   * Called when a ride CANCELLED. Voids promo usage and refunds applied
   * credits + any wallet payment. Idempotent — refunds carry their own
   * ledger keys and rides gate re-refunds on refunded_at timestamps.
   * New rides are never charged at request (payment settles at
   * completion), so the wallet refund only affects rides that predate
   * that change; for everything else it is a harmless no-op.
   */
  static async onRideCancelled(ride: RideEvent): Promise<void> {
    try {
      await voidPromoForCancelledRide(ride.id);
    } catch (err: any) {
      console.warn(`[REWARD] ⚠️ promo void failed: ${err.message}`);
    }
    try {
      const res = await pool.query(
        `SELECT credits_applied_cents FROM rides WHERE id = $1 AND credits_refunded_at IS NULL AND credits_applied_cents > 0`,
        [ride.id],
      );
      if (res.rows.length > 0) {
        await CreditsService.refundRide(ride.rider_id, ride.id);
        await pool.query(`UPDATE rides SET credits_refunded_at = NOW() WHERE id = $1`, [ride.id]);
      }
    } catch (err: any) {
      console.warn(`[REWARD] ⚠️ credits refund failed: ${err.message}`);
    }
    try {
      const res = await pool.query(
        `SELECT wallet_payment_cents FROM rides WHERE id = $1 AND wallet_refunded_at IS NULL AND wallet_payment_cents > 0`,
        [ride.id],
      );
      if (res.rows.length > 0) {
        await WalletService.refundRide(ride.rider_id, ride.id);
        await pool.query(`UPDATE rides SET wallet_refunded_at = NOW() WHERE id = $1`, [ride.id]);
      }
    } catch (err: any) {
      console.warn(`[REWARD] ⚠️ wallet refund failed: ${err.message}`);
    }
  }
}
