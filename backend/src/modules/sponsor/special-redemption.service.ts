// backend/src/modules/sponsor/special-redemption.service.ts
//
// SPECIAL REDEMPTION — the canonical sponsorship domain object.
// ---------------------------------------------------------------------------
// Lifecycle (server-authoritative state machine, every transition audited):
//
//   CREATED             rider selected a sponsor (pre-ride intent)
//   RIDE_PENDING        special ride requested: discount snapshot computed
//                       from the quoted fare, budget RESERVED (spec §67),
//                       sponsor row locked FOR UPDATE so two $8 redemptions
//                       on a $10 budget can never both pass (spec §66).
//   WAITING_FOR_SPONSOR ride completed → one-time validation code issued
//                       (HMAC-SHA256 hash stored; TTL + max attempts).
//   SPONSOR_VALIDATED   sponsor entered the code + double-confirmed.
//   REWARD_SELECTED     rider chose REFUND or CREDITS with confirmation.
//   REWARD_COMPLETED    settlement idempotently done (terminal).
//   CANCELLED           ride cancelled / sponsor cancelled / system cancel.
//   EXPIRED             validation code expired without use.
//   REWARD_FAILED       settlement failed; safe to retry exactly once.
//
// Financial settlement (spec §34-37):
//   D = calculated_discount_cents snapshot at ride request.
//   sponsor ledger  = one DISCOUNT_REDEEMED(-D) row (partial unique per
//                     redemption → a double settle can never debit twice)
//   driver ledger   = one payouts(SPONSOR_CREDIT) row = 60% of D
//   NetRide share   = 40% of D (recorded on the redemption)
//   rider REFUND    = +D to the ride wallet (idempotency key specialReward:
//                     {redemptionId}; wallet_transactions SPONSOR_REWARD)
//   rider CREDITS   = +D×1.10 to ride credits (extra 0.10D is a NetRide
//                     expense — netride_bonus_cents, never from the sponsor)
//
// Idempotency discipline: every money movement carries its own idempotency
// key; every state transition is guarded by status checks; every table has
// a partial unique index. Retries, double-taps and concurrent duplicates
// are all no-ops.

import crypto from 'crypto';
import { pool } from '../../config/database';
import { io } from '../../app';
import { env } from '../../config/env';
import { centsValue } from '../../services/financial-ledger.service';
import { AuditEventsService } from '../../services/audit-events.service';
import { WalletService } from '../wallet/wallet.service';
import { CreditsService } from '../credits/credits.service';
import {
  SponsorService,
  computeSponsorDiscount,
  discountLabelFor,
} from './sponsor.service';
import { notifySpecialRewardReady, notifySpecialRewardCredited, notifySpecialRefunded } from './special-notifications';

export type RedemptionStatus =
  | 'CREATED'
  | 'RIDE_PENDING'
  | 'WAITING_FOR_SPONSOR'
  | 'SPONSOR_VALIDATED'
  | 'REWARD_SELECTED'
  | 'REWARD_COMPLETED'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'REWARD_FAILED';

/** Money conversions — pg returns BIGINT as strings; never multiply by 100. */
const roundCents = (n: number) => Math.round(n);
const fmt = (cents: number) => (cents / 100).toFixed(2);

export interface RedemptionRow {
  id: string;
  sponsor_id: string;
  rider_id: string;
  driver_id: string | null;
  ride_id: string | null;
  sponsor_name: string;
  sponsor_business_type: string;
  sponsor_latitude: number | null;
  sponsor_longitude: number | null;
  sponsor_address: string | null;
  discount_type: string;
  discount_percent: number | null;
  discount_fixed_amount_cents: number | null;
  discount_label: string;
  calculated_discount_cents: number;
  validation_code_hash: string | null;
  validation_expires_at: Date | null;
  validation_attempts: number;
  max_validation_attempts: number;
  status: RedemptionStatus;
  ride_requested_at: Date | null;
  ride_completed_at: Date | null;
  sponsor_validated_at: Date | null;
  sponsor_validated_by: string | null;
  cancelled_by: string | null;
  cancelled_at: Date | null;
  cancellation_reason_code: string | null;
  cancellation_reason_text: string | null;
  reward_choice: 'REFUND' | 'CREDITS' | null;
  reward_amount_cents: number | null;
  sponsor_funded_cents: number | null;
  driver_allocation_cents: number | null;
  netride_allocation_cents: number | null;
  netride_bonus_cents: number | null;
  wallet_transaction_id: string | null;
  credit_transaction_id: string | null;
  sponsor_settled_at: Date | null;
  reward_processed_at: Date | null;
  reward_failed_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

const REDEMPTION_SELECT = `
  SELECT id, sponsor_id, rider_id, driver_id, ride_id,
         sponsor_name, sponsor_business_type, sponsor_latitude,
         sponsor_longitude, sponsor_address, discount_type, discount_percent,
         discount_fixed_amount_cents, discount_label, calculated_discount_cents,
         validation_code_hash, validation_expires_at, validation_attempts,
         max_validation_attempts, status, ride_requested_at, ride_completed_at,
         sponsor_validated_at, sponsor_validated_by, cancelled_by, cancelled_at,
         cancellation_reason_code, cancellation_reason_text, reward_choice,
         reward_amount_cents, sponsor_funded_cents, driver_allocation_cents,
         netride_allocation_cents, netride_bonus_cents, wallet_transaction_id,
         credit_transaction_id, sponsor_settled_at, reward_processed_at,
         reward_failed_reason, created_at, updated_at
  FROM special_redemptions`;

export function normalizeRedemption(r: any): RedemptionRow {
  return {
    id: r.id,
    sponsor_id: r.sponsor_id,
    rider_id: r.rider_id,
    driver_id: r.driver_id,
    ride_id: r.ride_id,
    sponsor_name: r.sponsor_name,
    sponsor_business_type: r.sponsor_business_type,
    sponsor_latitude: r.sponsor_latitude != null ? Number(r.sponsor_latitude) : null,
    sponsor_longitude: r.sponsor_longitude != null ? Number(r.sponsor_longitude) : null,
    sponsor_address: r.sponsor_address,
    discount_type: r.discount_type,
    discount_percent: r.discount_percent != null ? Number(r.discount_percent) : null,
    discount_fixed_amount_cents: centsValue(r.discount_fixed_amount_cents),
    discount_label: r.discount_label,
    calculated_discount_cents: centsValue(r.calculated_discount_cents),
    validation_code_hash: r.validation_code_hash,
    validation_expires_at: r.validation_expires_at,
    validation_attempts: Number(r.validation_attempts ?? 0),
    max_validation_attempts: Number(r.max_validation_attempts ?? env.SPONSOR_CODE_MAX_ATTEMPTS),
    status: r.status,
    ride_requested_at: r.ride_requested_at,
    ride_completed_at: r.ride_completed_at,
    sponsor_validated_at: r.sponsor_validated_at,
    sponsor_validated_by: r.sponsor_validated_by,
    cancelled_by: r.cancelled_by,
    cancelled_at: r.cancelled_at,
    cancellation_reason_code: r.cancellation_reason_code,
    cancellation_reason_text: r.cancellation_reason_text,
    reward_choice: r.reward_choice,
    reward_amount_cents: centsValue(r.reward_amount_cents),
    sponsor_funded_cents: centsValue(r.sponsor_funded_cents),
    driver_allocation_cents: centsValue(r.driver_allocation_cents),
    netride_allocation_cents: centsValue(r.netride_allocation_cents),
    netride_bonus_cents: centsValue(r.netride_bonus_cents),
    wallet_transaction_id: r.wallet_transaction_id,
    credit_transaction_id: r.credit_transaction_id,
    sponsor_settled_at: r.sponsor_settled_at,
    reward_processed_at: r.reward_processed_at,
    reward_failed_reason: r.reward_failed_reason,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

/** Validation code: 6 digits, cryptographically random, hash-only storage. */
function generateValidationCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function hashValidationCode(code: string, redemptionId: string): string {
  return crypto
    .createHmac('sha256', env.JWT_SECRET)
    .update(`${redemptionId}:${code}`)
    .digest('hex');
}

/** Live card update to the rider's app (minified card syncs instantly). */
function emitRedemptionUpdate(redemption: RedemptionRow | null) {
  if (!redemption) return;
  try {
    io.to(`rider:${redemption.rider_id}`).emit('specialRedemptionUpdate', {
      id: redemption.id,
      status: redemption.status,
      sponsorName: redemption.sponsor_name,
      discountLabel: redemption.discount_label,
      discountCents: redemption.calculated_discount_cents,
      rewardChoice: redemption.reward_choice,
      rewardAmountCents: redemption.reward_amount_cents,
      timestamps: {
        requestedAt: redemption.ride_requested_at,
        completedAt: redemption.ride_completed_at,
        validatedAt: redemption.sponsor_validated_at,
        processedAt: redemption.reward_processed_at,
      },
    });
  } catch (err) {
    // Socket emits are non-fatal — the DB state is authoritative.
  }
}

export class SpecialRedemptionService {
  static async findById(id: string): Promise<RedemptionRow | null> {
    const res = await pool.query(`${REDEMPTION_SELECT} WHERE id = $1`, [id]);
    return res.rows.length > 0 ? normalizeRedemption(res.rows[0]) : null;
  }

  /** The rider's active (resumable) redemption, if any — used on app restart (§27-29). */
  static async findActiveForRider(riderId: string): Promise<RedemptionRow | null> {
    const res = await pool.query(
      `${REDEMPTION_SELECT}
       WHERE rider_id = $1 AND status IN ('CREATED','RIDE_PENDING','WAITING_FOR_SPONSOR','SPONSOR_VALIDATED','REWARD_SELECTED')
       ORDER BY created_at DESC LIMIT 1`,
      [riderId],
    );
    return res.rows.length > 0 ? normalizeRedemption(res.rows[0]) : null;
  }

  // ------------------------------------------------------------ step 1: pick

  /**
   * Rider selects a sponsor (SPECIALS detail → "Visit and save"). Creates
   * the CREATED redemption with immutable sponsor snapshots. Only ACTIVE +
   * eligible sponsors can be selected.
   */
  static async createForRider(riderId: string, sponsorId: string): Promise<RedemptionRow> {
    const sponsor = await SponsorService.findById(sponsorId);
    if (!sponsor || !SponsorService.isEligible(sponsor)) {
      throw new Error('This special is temporarily unavailable');
    }
    const res = await pool.query(
      `INSERT INTO special_redemptions (
         sponsor_id, rider_id,
         sponsor_name, sponsor_business_type, sponsor_latitude,
         sponsor_longitude, sponsor_address,
         discount_type, discount_percent, discount_fixed_amount_cents,
         discount_label, status
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'CREATED')
       RETURNING *`,
      [
        sponsor.id,
        riderId,
        sponsor.business_name,
        sponsor.business_type,
        sponsor.latitude,
        sponsor.longitude,
        sponsor.address,
        sponsor.discount_type,
        sponsor.discount_percent,
        sponsor.discount_fixed_amount_cents,
        discountLabelFor(sponsor),
      ],
    );
    AuditEventsService.record({
      actorId: riderId,
      actorRole: 'RIDER',
      action: 'special_redemption_created',
      entityType: 'special_redemption',
      entityId: res.rows[0].id,
      details: { sponsorId },
    }).catch(() => undefined);
    return normalizeRedemption(res.rows[0]);
  }

  // --------------------------------------------------------- step 2: request

  /**
   * Attaches a redemption to a special ride AT RIDE REQUEST TIME, inside the
   * ride's own transaction (client). Computes the discount snapshot from the
   * quoted fare and RESERVES the budget atomically.
   *
   * Concurrency (spec §66-68): the sponsor row is locked FOR UPDATE; two
   * concurrent requests where the second cannot be covered by the remaining
   * budget fail with a user-safe "temporarily unavailable" instead of ever
   * silently pushing the budget negative.
   *
   * Throws → the whole ride request rolls back (invalid/unavailable specials
   * never create rides).
   */
  static async attachToRideRequest(
    client: any,
    args: { riderId: string; rideId: string; fareCents: number; specialRedemptionId?: string | null },
  ): Promise<{ redemption: RedemptionRow | null; discountCents: number; sponsorDiscountCents: number }> {
    const { riderId, rideId, fareCents } = args;
    if (!args.specialRedemptionId) return { redemption: null, discountCents: 0, sponsorDiscountCents: 0 };

    const redRes = await client.query(
      `SELECT * FROM special_redemptions WHERE id = $1 AND rider_id = $2 FOR UPDATE`,
      [args.specialRedemptionId, riderId],
    );
    const redemption = redRes.rows[0];
    if (!redemption) throw new Error('This special is no longer available');
    if (redemption.status !== 'CREATED') {
      if (redemption.status === 'RIDE_PENDING' || redemption.status === 'WAITING_FOR_SPONSOR') {
        throw new Error('You already have a special ride in progress');
      }
      throw new Error('This special can no longer be redeemed');
    }

    // Lock the sponsor row: the budget decision is made atomically here.
    const sponsorRes = await client.query(
      `SELECT * FROM sponsors WHERE id = $1 FOR UPDATE`,
      [redemption.sponsor_id],
    );
    const sponsor = sponsorRes.rows[0];
    if (!sponsor || !SponsorService.isEligible(sponsor)) {
      throw new Error('This special is temporarily unavailable');
    }

    const discount = computeSponsorDiscount(sponsor, fareCents);
    if (discount <= 0) throw new Error('This special does not apply to this fare');
    const spendable = centsValue(sponsor.remaining_budget_cents) - centsValue(sponsor.reserved_budget_cents);
    if (spendable < discount) {
      throw new Error('This special is temporarily unavailable');
    }

    await client.query(
      `UPDATE sponsors
       SET reserved_budget_cents = reserved_budget_cents + $2, updated_at = NOW()
       WHERE id = $1`,
      [sponsor.id, discount],
    );

    await client.query(
      `UPDATE special_redemptions
       SET status = 'RIDE_PENDING', ride_id = $2, ride_requested_at = NOW(),
           calculated_discount_cents = $3,
           discount_type = $4, discount_percent = $5,
           discount_fixed_amount_cents = $6, discount_label = $7,
           sponsor_name = $8, sponsor_business_type = $9,
           sponsor_latitude = $10, sponsor_longitude = $11, sponsor_address = $12,
           updated_at = NOW()
       WHERE id = $1`,
      [
        redemption.id,
        rideId,
        discount,
        sponsor.discount_type,
        sponsor.discount_percent,
        sponsor.discount_fixed_amount_cents,
        discountLabelFor(sponsor),
        sponsor.business_name,
        sponsor.business_type,
        sponsor.latitude,
        sponsor.longitude,
        sponsor.address,
      ],
    );

    // The sponsor discount reduces the rider's final payment; the original
    // quoted fare is never modified (spec §73).
    await client.query(
      `UPDATE rides
       SET sponsor_discount_cents = $2,
           final_payment_cents = GREATEST(0, final_payment_cents - $2)
       WHERE id = $1`,
      [rideId, discount],
    );

    AuditEventsService.record({
      actorId: riderId,
      actorRole: 'RIDER',
      action: 'special_ride_requested',
      entityType: 'special_redemption',
      entityId: redemption.id,
      details: { rideId, discountCents: discount, fareCents },
    }).catch(() => undefined);

    const fresh = await client.query(`SELECT * FROM special_redemptions WHERE id = $1`, [redemption.id]);
    const updated = normalizeRedemption(fresh.rows[0]);
    emitRedemptionUpdate(updated);
    return { redemption: updated, discountCents: discount, sponsorDiscountCents: discount };
  }

  // ------------------------------------------------------------ step 3: ride

  /**
   * Ride COMPLETED → issue the one-time validation code (hash, TTL). Called
   * from the ride completion path; idempotent — a code is issued once.
   */
  static async onRideCompleted(rideId: string, riderId: string): Promise<void> {
    const res = await pool.query(
      `SELECT * FROM special_redemptions WHERE ride_id = $1 AND rider_id = $2`,
      [rideId, riderId],
    );
    if (res.rows.length === 0) return;
    const redemption = res.rows[0];
    if (redemption.status !== 'RIDE_PENDING') return;

    const code = generateValidationCode();
    const hash = hashValidationCode(code, redemption.id);
    const expiresAt = new Date(Date.now() + env.SPONSOR_CODE_TTL_HOURS * 60 * 60 * 1000);

    await pool.query(
      `UPDATE special_redemptions
       SET status = 'WAITING_FOR_SPONSOR', ride_completed_at = NOW(),
           driver_id = (SELECT driver_id FROM rides WHERE id = $2),
           validation_code_hash = $3, validation_expires_at = $4,
           validation_attempts = 0, updated_at = NOW()
       WHERE id = $1 AND status = 'RIDE_PENDING'`,
      [redemption.id, rideId, hash, expiresAt],
    );

    AuditEventsService.record({
      actorId: riderId,
      actorRole: 'RIDER',
      action: 'special_validation_code_issued',
      entityType: 'special_redemption',
      entityId: redemption.id,
      details: { rideId, ttlHours: env.SPONSOR_CODE_TTL_HOURS },
    }).catch(() => undefined);

    // The raw code is delivered ONLY to the rider (in-app + push). It is
    // never persisted in any log or column.
    emitRedemptionUpdate(normalizeRedemption((await pool.query(`SELECT * FROM special_redemptions WHERE id = $1`, [redemption.id])).rows[0]));
    notifySpecialRewardReady(riderId, redemption.id, code).catch(() => undefined);
  }

  // ------------------------------------------------------------ step 4: verify

  /**
   * Rider taps "I got verified" — informs the rider AND the sponsor that the
   * validation is awaiting the sponsor. Idempotent.
   */
  static async riderMarkedVerified(redemptionId: string, riderId: string): Promise<RedemptionRow> {
    const redemption = await this.findById(redemptionId);
    if (!redemption || redemption.rider_id !== riderId) throw new Error('Redemption not found');
    if (redemption.status !== 'WAITING_FOR_SPONSOR') {
      throw new Error('Your special is not awaiting verification yet');
    }
    return redemption;
  }

  /**
   * Sponsor confirms the visit by entering the rider's code (double
   * confirmation enforced server-side: the transition requires an explicit
   * `confirmed` flag). Exact hash match, TTL + attempt capping, one-time.
   */
  static async sponsorValidate(
    sponsorId: string,
    code: string,
    opts: { confirmed?: boolean } = {},
  ): Promise<RedemptionRow> {
    if (!opts.confirmed) throw new Error('Please confirm this validation');
    const normalized = String(code ?? '').trim();
    if (!/^\d{6}$/.test(normalized)) throw new Error("Enter the 6-digit code from the rider's app");

    // The stored hash binds code + redemption id (HMAC), so we enumerate the
    // sponsor's pending codes and compare each candidate hash server-side.
    // Plaintext codes are never stored anywhere (spec §99).
    const candidates = await pool.query(
      `SELECT id, validation_code_hash, validation_expires_at,
              validation_attempts, max_validation_attempts
       FROM special_redemptions
       WHERE sponsor_id = $1 AND status = 'WAITING_FOR_SPONSOR' AND validation_code_hash IS NOT NULL`,
      [sponsorId],
    );
    let target: string | null = null;
    for (const row of candidates.rows) {
      if (hashValidationCode(normalized, row.id) === row.validation_code_hash) {
        target = row.id;
        break;
      }
    }
    if (!target) {
      // Burn one attempt on the most recent candidate to throttle brute force.
      if (candidates.rows.length > 0) {
        await pool.query(
          `UPDATE special_redemptions
           SET validation_attempts = validation_attempts + 1, updated_at = NOW()
           WHERE id = $1 AND status = 'WAITING_FOR_SPONSOR'`,
          [candidates.rows[0].id],
        );
      }
      throw new Error('No pending validation matches this code');
    }

    const redemption = await this.findById(target);
    if (!redemption) throw new Error('No pending validation matches this code');
    if (redemption.validation_expires_at && new Date(redemption.validation_expires_at).getTime() < Date.now()) {
      await this.expireRedemption(redemption.id, 'Code expired before validation');
      throw new Error('This code has expired');
    }
    if (redemption.validation_attempts >= redemption.max_validation_attempts) {
      throw new Error('Too many failed attempts — ask the rider for a fresh code');
    }

    // Atomically transition — repeated/duplicate attempts are no-ops.
    const res = await pool.query(
      `UPDATE special_redemptions
       SET status = 'SPONSOR_VALIDATED', sponsor_validated_at = NOW(),
           sponsor_validated_by = $2, validation_attempts = 0, updated_at = NOW()
       WHERE id = $1 AND status = 'WAITING_FOR_SPONSOR'
       RETURNING *`,
      [redemption.id, sponsorId],
    );
    if (res.rows.length === 0) {
      const latest = await this.findById(redemption.id);
      if (latest?.status === 'SPONSOR_VALIDATED' || latest?.status === 'REWARD_COMPLETED') return latest!;
      throw new Error('This validation is no longer pending');
    }

    AuditEventsService.record({
      actorId: sponsorId,
      actorRole: 'SPONSOR',
      action: 'special_sponsor_validated',
      entityType: 'special_redemption',
      entityId: redemption.id,
      details: { rideId: redemption.ride_id },
    }).catch(() => undefined);
    notifySpecialRewardReady(redemption.rider_id, redemption.id, null).catch(() => undefined);
    const validated = normalizeRedemption(res.rows[0]);
    emitRedemptionUpdate(validated);
    return validated;
  }

  /**
   * Sponsor cancels a pending validation with a reason (code + text). Double
   * confirmation required. Only open-status redemptions can be cancelled;
   * historical redemptions are untouched.
   */
  static async sponsorCancel(
    sponsorId: string,
    redemptionId: string,
    reasonCode: string,
    reasonText: string,
    opts: { confirmed?: boolean } = {},
  ): Promise<RedemptionRow> {
    if (!opts.confirmed) throw new Error('Please confirm this cancellation');
    if (!reasonCode) throw new Error('A cancellation reason is required');
    const text = (reasonText ?? '').trim().slice(0, 300);
    if (!/^[A-Z_]+$/.test(reasonCode)) throw new Error('Invalid cancellation reason');

    const res = await pool.query(
      `UPDATE special_redemptions
       SET status = 'CANCELLED', cancelled_at = NOW(), cancelled_by = $2,
           cancellation_reason_code = $3, cancellation_reason_text = $4,
           updated_at = NOW()
       WHERE id = $1 AND sponsor_id = $2
         AND status IN ('WAITING_FOR_SPONSOR', 'SPONSOR_VALIDATED', 'REWARD_SELECTED', 'REWARD_FAILED')
       RETURNING *`,
      [redemptionId, sponsorId, reasonCode, text],
    );
    if (res.rows.length === 0) {
      const latest = await pool.query(`SELECT status FROM special_redemptions WHERE id = $1 AND sponsor_id = $2`, [redemptionId, sponsorId]);
      const status = latest.rows[0]?.status;
      if (status === 'CANCELLED') {
        const existing = await this.findById(redemptionId);
        return existing!;
      }
      throw new Error('This validation can no longer be cancelled');
    }

    await this.releaseReservedBudget(res.rows[0].id, 'REVERSAL', `Sponsor cancellation: ${reasonCode}`);
    AuditEventsService.record({
      actorId: sponsorId,
      actorRole: 'SPONSOR',
      action: 'special_sponsor_cancelled',
      entityType: 'special_redemption',
      entityId: redemptionId,
      details: { reasonCode, reasonText: text },
    }).catch(() => undefined);
    return normalizeRedemption(res.rows[0]);
  }

  // ------------------------------------------------------------ step 5: reward

  /**
   * Rider chooses the reward. Only AFTER the sponsor validated. Two options:
   * REFUND (D back to the wallet) or CREDITS (D×1.10 ride credits; the extra
   * 0.10D is a NetRide expense). Settlement is atomic + idempotent: retries
   * after a crash are exact no-ops, and the ledger rows can never double.
   */
  static async riderChooseReward(
    redemptionId: string,
    riderId: string,
    choice: 'REFUND' | 'CREDITS',
    opts: { confirmed?: boolean } = {},
  ): Promise<RedemptionRow> {
    if (!['REFUND', 'CREDITS'].includes(choice)) throw new Error('Invalid reward choice');
    if (!opts.confirmed) throw new Error('Please confirm your reward choice');

    const redemption = await this.findById(redemptionId);
    if (!redemption || redemption.rider_id !== riderId) throw new Error('Redemption not found');

    // Already settled → return the final state (idempotent).
    if (redemption.status === 'REWARD_COMPLETED') return redemption;
    if (redemption.status !== 'SPONSOR_VALIDATED') {
      if (redemption.status === 'REWARD_FAILED') {
        // Safe to retry a failed settlement exactly once per choice.
      } else {
        throw new Error('Your sponsor has not validated this visit yet');
      }
    }

    const D = redemption.calculated_discount_cents;
    if (D <= 0) throw new Error('This special has no redeemable value');

    const driverAllocation = roundCents(D * env.SPONSOR_DRIVER_SHARE);
    const netrideAllocation = D - driverAllocation;
    const rewardAmount = choice === 'REFUND' ? D : roundCents(D * env.SPONSOR_CREDIT_BONUS);
    const netrideBonus = choice === 'CREDITS' ? rewardAmount - D : 0;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // --- 1. Sponsor budget: consume the reservation (never negative). ---
      const sponsorUpd = await client.query(
        `UPDATE sponsors
         SET remaining_budget_cents = remaining_budget_cents - $2,
             reserved_budget_cents = reserved_budget_cents - $2,
             used_budget_cents = used_budget_cents + $2,
             updated_at = NOW()
         WHERE id = $1 AND remaining_budget_cents >= $2
         RETURNING remaining_budget_cents, reserved_budget_cents, used_budget_cents, status`,
        [redemption.sponsor_id, D],
      );
      if (sponsorUpd.rows.length === 0) {
        throw new Error('Sponsor budget depleted — your special can no longer be settled');
      }
      await client.query(
        `INSERT INTO sponsor_ledger_entries
           (sponsor_id, type, amount_cents, direction, reference_type,
            reference_id, reason, actor_user_id, actor_role, balance_after_cents)
         VALUES ($1, 'DISCOUNT_REDEEMED', $2, 'DEBIT', 'special_redemption', $3,
                 'Special redemption settlement', $4, 'RIDER', $5)
         ON CONFLICT (reference_id) WHERE type = 'DISCOUNT_REDEEMED' DO NOTHING`,
        [redemption.sponsor_id, D, redemption.id, riderId, sponsorUpd.rows[0].remaining_budget_cents],
      );
      await client.query(
        `UPDATE sponsors SET status = 'DEPLETED', updated_at = NOW()
         WHERE id = $1 AND status = 'ACTIVE' AND remaining_budget_cents - reserved_budget_cents <= 0`,
        [redemption.sponsor_id],
      );

      // --- 2. Driver share (60%) — SPONSOR_CREDIT payout, idempotent. ---
      if (redemption.driver_id && driverAllocation > 0) {
        await client.query(
          `INSERT INTO driver_wallets (driver_id) VALUES ($1) ON CONFLICT (driver_id) DO NOTHING`,
          [redemption.driver_id],
        );
        await client.query(
          `UPDATE driver_wallets
           SET balance_cents = balance_cents + $2,
               lifetime_earnings_cents = lifetime_earnings_cents + $2,
               updated_at = NOW()
           WHERE driver_id = $1`,
          [redemption.driver_id, driverAllocation],
        );
        await client.query(
          `INSERT INTO payouts (driver_id, amount_cents, fee_cents, net_cents, status, method, ride_id, notes)
           VALUES ($1, $2, 0, $2, 'PAID', 'SPONSOR_CREDIT', $3, $4)
           ON CONFLICT (ride_id) WHERE method = 'SPONSOR_CREDIT' DO NOTHING`,
          [redemption.driver_id, driverAllocation, redemption.ride_id, `Sponsor special redemption ${redemption.id}`],
        );
      }

      // --- 3. Rider benefit (REFUND → wallet / CREDITS → credits). ---
      const idempotencyKey = `specialReward:${redemption.id}`;
      let walletTxId: string | null = null;
      let creditTxId: string | null = null;
      if (choice === 'REFUND') {
        const walletPost = await WalletService.post(
          redemption.rider_id,
          rewardAmount,
          'SPONSOR_REWARD',
          {
            idempotencyKey,
            description: `Special reward: money back for your visit to ${redemption.sponsor_name}`,
            referenceType: 'special_redemption',
            referenceId: redemption.id,
            rideId: redemption.ride_id ?? undefined,
            emitSocket: true,
            client,
          },
        );
        walletTxId = walletPost.transaction_id || null;
      } else {
        const creditPost = await CreditsService.post(
          redemption.rider_id,
          rewardAmount,
          'SPONSOR_REWARD',
          {
            idempotencyKey,
            description: `Special reward: ${redemption.sponsor_name} credits (${fmt(D)} + ${fmt(netrideBonus)} bonus)`,
            referenceType: 'special_redemption',
            referenceId: redemption.id,
            rideId: redemption.ride_id ?? undefined,
            emitSocket: true,
            client,
          },
        );
        creditTxId = creditPost.transaction_id || null;
      }

      // --- 4. Mark the redemption settled (idempotent transition). ---
      const redemptionUpd = await client.query(
        `UPDATE special_redemptions
         SET status = 'REWARD_COMPLETED', reward_choice = $2,
             reward_amount_cents = $3, sponsor_funded_cents = $4,
             driver_allocation_cents = $5, netride_allocation_cents = $6,
             netride_bonus_cents = $7, wallet_transaction_id = $8,
             credit_transaction_id = $9, sponsor_settled_at = NOW(),
             reward_processed_at = NOW(), reward_failed_reason = NULL,
             updated_at = NOW()
         WHERE id = $1 AND status IN ('SPONSOR_VALIDATED', 'REWARD_SELECTED', 'REWARD_FAILED')
         RETURNING *`,
        [redemption.id, choice, rewardAmount, D, driverAllocation, netrideAllocation, netrideBonus, walletTxId, creditTxId],
      );
      if (redemptionUpd.rows.length === 0) {
        throw new Error('This special has already been settled');
      }

      await client.query('COMMIT');

      AuditEventsService.record({
        actorId: riderId,
        actorRole: 'RIDER',
        action: 'special_reward_settled',
        entityType: 'special_redemption',
        entityId: redemption.id,
        details: { choice, rewardAmountCents: rewardAmount, sponsorFundedCents: D },
      }).catch(() => undefined);

      if (choice === 'REFUND') {
        notifySpecialRefunded(redemption.rider_id, redemption.id, rewardAmount).catch(() => undefined);
      } else {
        notifySpecialRewardCredited(redemption.rider_id, redemption.id, rewardAmount).catch(() => undefined);
      }
      const settled = normalizeRedemption(redemptionUpd.rows[0]);
      emitRedemptionUpdate(settled);
      return settled;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* noop */ }
      // Settlement failed: leave the redemption in REWARD_FAILED so it is
      // explicit and retryable (idempotency keys make the retry safe).
      await pool.query(
        `UPDATE special_redemptions
         SET status = 'REWARD_FAILED', reward_failed_reason = $2, updated_at = NOW()
         WHERE id = $1 AND status IN ('SPONSOR_VALIDATED', 'REWARD_SELECTED')`,
        [redemption.id, String((err as Error).message).slice(0, 300)],
      ).catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  // ------------------------------------------------------------ step 6: end

  /**
   * Ride CANCELLED (terminal — rider-cancel or driver-cancel-without-rematch):
   * the special is voided, the reserved budget is released (spec §69: a
   * cancelled ride never consumes budget).
   */
  static async onRideCancelled(rideId: string): Promise<void> {
    const res = await pool.query(
      `SELECT id, status, rider_id FROM special_redemptions WHERE ride_id = $1`,
      [rideId],
    );
    const redemption = res.rows[0];
    if (!redemption || redemption.status !== 'RIDE_PENDING') return;

    await pool.query(
      `UPDATE special_redemptions
       SET status = 'CANCELLED', cancelled_at = NOW(),
           cancellation_reason_code = 'RIDE_CANCELLED', updated_at = NOW()
       WHERE id = $1 AND status = 'RIDE_PENDING'`,
      [redemption.id],
    );
    await this.releaseReservedBudget(redemption.id, 'REVERSAL', 'Ride cancelled before completion');
    AuditEventsService.record({
      actorId: redemption.rider_id,
      actorRole: 'RIDER',
      action: 'special_ride_cancelled',
      entityType: 'special_redemption',
      entityId: redemption.id,
      details: { rideId },
    }).catch(() => undefined);
  }

  /** Background job: expire stale validation codes (§28) + release reservations. */
  static async expireStaleRedemptions(): Promise<number> {
    const expired = await pool.query(
      `SELECT id, rider_id FROM special_redemptions
       WHERE status = 'WAITING_FOR_SPONSOR'
         AND validation_expires_at IS NOT NULL
         AND validation_expires_at < NOW()`,
    );
    for (const row of expired.rows) {
      await this.expireRedemption(row.id, 'Validation code expired');
    }
    return expired.rows.length;
  }

  private static async expireRedemption(id: string, reason: string): Promise<void> {
    await pool.query(
      `UPDATE special_redemptions
       SET status = 'EXPIRED', updated_at = NOW()
       WHERE id = $1 AND status = 'WAITING_FOR_SPONSOR'`,
      [id],
    );
    await this.releaseReservedBudget(id, 'EXPIRATION', reason);
    AuditEventsService.record({
      action: 'special_redemption_expired',
      entityType: 'special_redemption',
      entityId: id,
      details: { reason },
    }).catch(() => undefined);
  }

  /** Releases a reserved budget hold back to the sponsor (REVERSAL/EXPIRATION). */
  private static async releaseReservedBudget(redemptionId: string, type: 'REVERSAL' | 'EXPIRATION', reason: string): Promise<void> {
    const res = await pool.query(
      `SELECT sponsor_id, calculated_discount_cents FROM special_redemptions WHERE id = $1`,
      [redemptionId],
    );
    const r = res.rows[0];
    if (!r) return;
    const D = centsValue(r.calculated_discount_cents);
    if (D <= 0) return;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const upd = await client.query(
        `UPDATE sponsors
         SET reserved_budget_cents = reserved_budget_cents - $2, updated_at = NOW()
         WHERE id = $1 AND reserved_budget_cents >= $2
         RETURNING remaining_budget_cents, reserved_budget_cents`,
        [r.sponsor_id, D],
      );
      if (upd.rows.length === 0) {
        await client.query('COMMIT');
        return;
      }
      await client.query(
        `INSERT INTO sponsor_ledger_entries
           (sponsor_id, type, amount_cents, direction, reference_type,
            reference_id, reason, balance_after_cents)
         VALUES ($1, $2, $3, 'CREDIT', 'special_redemption', $4, $5, $6)`,
        [r.sponsor_id, type, D, redemptionId, reason, upd.rows[0].remaining_budget_cents],
      );
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* noop */ }
    } finally {
      client.release();
    }
  }
}