// backend/src/modules/payments/withdrawal.service.ts
//
// MANUAL WITHDRAWALS — drivers and sponsors share one weekly rule:
// ---------------------------------------------------------------------------
//   * exactly one withdrawal per calendar week;
//   * the availability window ALWAYS opens on Monday 00:00 UTC;
//   * a withdrawal on any day of the week makes the next opportunity the
//     FOLLOWING Monday ("no matter when they withdrew");
//   * accounts that never withdrew are immediately eligible.
//
// Nothing here runs automatically: the old WEEKLY_AUTO sweep is retired and
// every payout/withdrawal is created by the account owner pressing the
// Withdraw button, then paid out manually (driver) or issued as Stripe
// refunds of their funding charges (sponsor).

import { pool } from '../../config/database';
import { AuditEventsService } from '../../services/audit-events.service';
import { tryGetStripeGateway } from './stripe.gateway';
import { centsValue } from '../../services/financial-ledger.service';

// ---------------------------------------------------------------------------
// Pure week arithmetic (unit-tested)
// ---------------------------------------------------------------------------

/** Monday 00:00:00.000 UTC of the week containing `d`. */
export function startOfWeekUtc(d: Date): Date {
  const monday = new Date(d);
  monday.setUTCHours(0, 0, 0, 0);
  const day = monday.getUTCDay(); // 0 = Sun … 6 = Sat, Monday = 1
  monday.setUTCDate(monday.getUTCDate() - ((day + 6) % 7));
  return monday;
}

/** The Monday 00:00:00.000 UTC strictly after `d`. */
export function nextMondayUtc(d: Date): Date {
  const next = startOfWeekUtc(d);
  next.setUTCDate(next.getUTCDate() + 7);
  return next;
}

export interface WithdrawalState {
  eligible: boolean;
  nextAvailableAt: Date;
}

/**
 * Shared weekly rule. `lastWithdrawalAt` = the last request that counts
 * toward the weekly limit (PENDING/PROCESSING/PAID driver payouts, or any
 * non-failed sponsor withdrawal request).
 */
export function withdrawalStateFor(
  lastWithdrawalAt: Date | null,
  now: Date,
): WithdrawalState {
  if (!lastWithdrawalAt) {
    return { eligible: true, nextAvailableAt: now };
  }
  const weekStart = startOfWeekUtc(now);
  if (lastWithdrawalAt < weekStart) {
    return { eligible: true, nextAvailableAt: now };
  }
  return { eligible: false, nextAvailableAt: nextMondayUtc(now) };
}

// ---------------------------------------------------------------------------
// Drivers (payouts table, ON_DEMAND rows created by the driver)
// ---------------------------------------------------------------------------

/** Fisher-Yates-safe: MAX(requested_at) of count-toward-limit payout rows. */
export async function lastDriverWithdrawalAt(driverId: string): Promise<Date | null> {
  const res = await pool.query(
    `SELECT MAX(requested_at) AS last_at
     FROM payouts
     WHERE driver_id = $1
       AND method IN ('WEEKLY_AUTO','ON_DEMAND')
       AND status IN ('PENDING','PROCESSING','PAID')`,
    [driverId],
  );
  return res.rows[0]?.last_at ?? null;
}

export async function driverWithdrawalState(driverId: string): Promise<WithdrawalState> {
  return withdrawalStateFor(await lastDriverWithdrawalAt(driverId), new Date());
}

/**
 * Throws WITHDRAWAL_UNAVAILABLE with the next available timestamp when the
 * weekly limit was already used this week. Called inside the payout request
 * BEFORE any money moves.
 */
export async function assertDriverCanWithdraw(driverId: string): Promise<WithdrawalState> {
  const state = await driverWithdrawalState(driverId);
  if (!state.eligible) {
    const err: any = new Error(
      `WITHDRAWAL_UNAVAILABLE: You can withdraw once a week. Your next withdrawal opens ${state.nextAvailableAt.toISOString()}.`,
    );
    err.code = 'WITHDRAWAL_UNAVAILABLE';
    err.nextAvailableAt = state.nextAvailableAt.toISOString();
    throw err;
  }
  return state;
}

// ---------------------------------------------------------------------------
// Sponsors (sponsor_withdrawals rows, Stripe refunds of funding charges)
// ---------------------------------------------------------------------------

export async function lastSponsorWithdrawalAt(sponsorId: string): Promise<Date | null> {
  const res = await pool.query(
    `SELECT MAX(requested_at) AS last_at
     FROM sponsor_withdrawals
     WHERE sponsor_id = $1 AND status IN ('PENDING','COMPLETED')`,
    [sponsorId],
  );
  return res.rows[0]?.last_at ?? null;
}

export async function sponsorWithdrawalState(sponsorId: string): Promise<WithdrawalState> {
  return withdrawalStateFor(await lastSponsorWithdrawalAt(sponsorId), new Date());
}

export async function listSponsorWithdrawals(sponsorId: string, limit = 50, offset = 0) {
  const res = await pool.query(
    `SELECT id, amount_cents, currency, status, refund_ids, failure_reason,
            requested_at, completed_at
     FROM sponsor_withdrawals
     WHERE sponsor_id = $1
     ORDER BY requested_at DESC
     LIMIT $2 OFFSET $3`,
    [sponsorId, Math.min(Math.max(limit, 1), 200), Math.max(offset, 0)],
  );
  return res.rows.map((r: any) => ({
    ...r,
    amount_cents: centsValue(r.amount_cents),
    refund_ids: Array.isArray(r.refund_ids) ? r.refund_ids : [],
  }));
}

/**
 * Requests a sponsor budget withdrawal. Two phases:
 *   1. (transaction) weekly check + spendable check (`remaining - reserved`,
 *      reservations are never clawed back), sponsor_withdrawals row + ledger
 *      WITHDRAWAL debit. All-or-nothing: concurrent requests lose.
 *   2. (outside the tx) refund the sponsor's funding charges to reach the
 *      requested amount. Each refund carries the idempotency key
 *      `sponsor-withdrawal:{withdrawalId}:{chargeId}`, so retries replay
 *      safely. FAILED rows are retried by the sweep cron.
 */
export async function requestSponsorWithdrawal(args: {
  sponsorId: string;
  amountCents: number;
  actorUserId?: string | null;
}): Promise<{ withdrawal: any; state: WithdrawalState }> {
  const amount = Math.round(args.amountCents);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Withdrawal amount must be positive');
  }
  // Withdrawals are refunds of funding charges, so the budget must actually
  // be backed by settle-able Stripe charges.
  const funding = await pool.query(
    `SELECT COUNT(*)::int AS n FROM stripe_payments
     WHERE sponsor_id = $1 AND purpose = 'SPONSOR_BUDGET_TOPUP' AND status = 'SUCCEEDED'`,
    [args.sponsorId],
  );
  if (Number(funding.rows[0]?.n ?? 0) === 0) {
    throw new Error('No refundable funding on file — fund your budget first');
  }

  const client = await pool.connect();
  let withdrawalId: string;
  try {
    await client.query('BEGIN');
    const sponsorRes = await client.query(
      `SELECT remaining_budget_cents, reserved_budget_cents FROM sponsors WHERE id = $1 FOR UPDATE`,
      [args.sponsorId],
    );
    const sponsor = sponsorRes.rows[0];
    if (!sponsor) throw new Error('Sponsor not found');

    const state = withdrawalStateFor(await lastSponsorWithdrawalAt(args.sponsorId), new Date());
    if (!state.eligible) {
      const err: any = new Error(
        `WITHDRAWAL_UNAVAILABLE: Budget withdrawals open once a week on Mondays. Next available ${state.nextAvailableAt.toISOString()}.`,
      );
      err.code = 'WITHDRAWAL_UNAVAILABLE';
      err.nextAvailableAt = state.nextAvailableAt.toISOString();
      throw err;
    }

    const spendable = centsValue(sponsor.remaining_budget_cents) - centsValue(sponsor.reserved_budget_cents);
    if (spendable < amount) {
      throw new Error('INSUFFICIENT_FUNDS: Requested amount exceeds the available budget.');
    }

    const ins = await client.query(
      `INSERT INTO sponsor_withdrawals (sponsor_id, amount_cents, status, created_by)
       VALUES ($1, $2, 'PENDING', $3) RETURNING *`,
      [args.sponsorId, amount, args.actorUserId ?? null],
    );
    withdrawalId = ins.rows[0].id;

    // Ledger + balances: a withdrawal reduces remaining AND initial so the
    // `initial = remaining + reserved + used` invariant stays intact.
    await client.query(
      `UPDATE sponsors
       SET remaining_budget_cents = remaining_budget_cents - $2,
           initial_budget_cents = initial_budget_cents - $2,
           updated_at = NOW()
       WHERE id = $1`,
      [args.sponsorId, amount],
    );
    await client.query(
      `INSERT INTO sponsor_ledger_entries
         (sponsor_id, type, amount_cents, direction, reference_type,
          reference_id, reason, actor_user_id, actor_role, balance_after_cents, idempotency_key)
       VALUES ($1, 'WITHDRAWAL', $2, 'DEBIT', 'sponsor_withdrawal', $3,
               'Manual budget withdrawal', $4, 'SPONSOR', $5, $6)`,
      [
        args.sponsorId,
        amount,
        withdrawalId,
        args.actorUserId ?? null,
        centsValue(sponsor.remaining_budget_cents) - amount,
        `sponsor-withdrawal:${withdrawalId}`,
      ],
    );
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* noop */ }
    throw err;
  } finally {
    client.release();
  }

  await executeSponsorWithdrawalRefunds(withdrawalId, args.sponsorId, amount);

  const withdrawal = (
    await pool.query(`SELECT * FROM sponsor_withdrawals WHERE id = $1`, [withdrawalId])
  ).rows[0];
  await AuditEventsService.record({
    actorId: args.actorUserId ?? null,
    actorRole: 'SPONSOR',
    action: 'sponsor_withdrawal_requested',
    entityType: 'sponsor',
    entityId: args.sponsorId,
    details: { amountCents: amount, withdrawalId, status: withdrawal.status },
  }).catch(() => undefined);

  return { withdrawal, state: await sponsorWithdrawalState(args.sponsorId) };
}

/**
 * Refunds the sponsor's SUCCEEDED funding charges (oldest first) until the
 * withdrawal amount is reached. Idempotent per (withdrawal, charge).
 */
export async function executeSponsorWithdrawalRefunds(
  withdrawalId: string,
  sponsorId: string,
  amountNeeded: number,
): Promise<void> {
  const gateway = tryGetStripeGateway();
  if (!gateway) {
    await pool.query(
      `UPDATE sponsor_withdrawals SET status = 'FAILED',
              failure_reason = 'Stripe is not configured', updated_at = NOW()
       WHERE id = $1 AND status = 'PENDING'`,
      [withdrawalId],
    );
    return;
  }

  // Already-completed refunds for this withdrawal (crash between refunds).
  const own = await pool.query(`SELECT refund_ids FROM sponsor_withdrawals WHERE id = $1`, [withdrawalId]);
  const already = new Set<string>(own.rows[0]?.refund_ids ?? []);

  // Candidate charges, oldest first, with every previously refunded amount
  // subtracted (across all completed withdrawals). refund_ids stores the
  // payment-intent ids, which are unique per funding charge.
  const charges = await pool.query(
    `SELECT p.id AS payment_id, p.stripe_payment_intent_id, p.amount_cents
     FROM stripe_payments p
     WHERE p.sponsor_id = $1 AND p.purpose = 'SPONSOR_BUDGET_TOPUP'
       AND p.status = 'SUCCEEDED'
       AND p.stripe_payment_intent_id IS NOT NULL
     ORDER BY p.succeeded_at ASC, p.created_at ASC`,
    [sponsorId],
  );
  const priorRefunds = await pool.query(
    `SELECT refund_ids FROM sponsor_withdrawals
     WHERE sponsor_id = $1 AND status = 'COMPLETED' AND id <> $2`,
    [sponsorId, withdrawalId],
  );
  const priorRefundedCounts = new Map<string, number>();
  for (const row of priorRefunds.rows) {
    for (const pid of (row.refund_ids ?? []) as string[]) {
      priorRefundedCounts.set(pid, (priorRefundedCounts.get(pid) ?? 0) + 1);
    }
  }

  let remaining = amountNeeded;
  const appliedRefunds: string[] = [];
  try {
    for (const ch of charges.rows) {
      if (remaining <= 0) break;
      const chargeAmount = centsValue(ch.amount_cents);
      const piId: string = ch.stripe_payment_intent_id;
      const refundedSoFar = priorRefundedCounts.get(piId) ?? 0;
      const refundable = chargeAmount - refundedSoFar;
      if (refundable <= 0) continue;

      const refundKey = `sponsor-withdrawal:${withdrawalId}:${piId}`;
      if (already.has(piId)) {
        appliedRefunds.push(piId);
        remaining -= Math.min(refundable, remaining);
        continue;
      }

      const refundAmount = Math.min(refundable, remaining);
      const refund = await gateway.createRefund({
        paymentIntentId: piId,
        amountCents: refundAmount,
        reason: 'requested_by_customer',
        idempotencyKey: refundKey,
      });
      if (refund.status === 'pending' || refund.status === 'succeeded') {
        appliedRefunds.push(piId);
        remaining -= refundAmount;
      }
    }

    if (remaining <= 0) {
      await pool.query(
        `UPDATE sponsor_withdrawals
         SET status = 'COMPLETED', refund_ids = $2::jsonb, completed_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [withdrawalId, JSON.stringify(appliedRefunds)],
      );
    } else {
      await pool.query(
        `UPDATE sponsor_withdrawals
         SET status = 'FAILED', refund_ids = $2::jsonb,
             failure_reason = 'Not enough refundable funding', updated_at = NOW()
         WHERE id = $1`,
        [withdrawalId, JSON.stringify(appliedRefunds)],
      );
    }
  } catch (err: any) {
    await pool.query(
      `UPDATE sponsor_withdrawals
       SET status = 'FAILED', refund_ids = $2::jsonb,
           failure_reason = $3, updated_at = NOW()
       WHERE id = $1`,
      [withdrawalId, JSON.stringify(appliedRefunds), String(err?.message ?? 'refund failed').slice(0, 300)],
    );
  }
}

/** Cron: retry PENDING/FAILED sponsor withdrawals (idempotent refunds). */
export async function sweepSponsorWithdrawals(): Promise<number> {
  const res = await pool.query(
    `SELECT id, sponsor_id, amount_cents FROM sponsor_withdrawals
     WHERE status IN ('PENDING','FAILED')
       AND updated_at < NOW() - INTERVAL '5 minutes'
     ORDER BY requested_at ASC
     LIMIT 25`,
  );
  let processed = 0;
  for (const row of res.rows) {
    try {
      await executeSponsorWithdrawalRefunds(row.id, row.sponsor_id, centsValue(row.amount_cents));
      processed++;
    } catch (err: any) {
      console.warn(`[WITHDRAWAL] ⚠️ retry failed for ${row.id}: ${err.message}`);
    }
  }
  return processed;
}