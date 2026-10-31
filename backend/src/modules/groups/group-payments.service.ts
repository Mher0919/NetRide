// backend/src/modules/groups/group-payments.service.ts
//
// Individual payment confirmation for group rides.
//
// Integration with NetRide's existing payment rails:
//   * ride credits  -> CreditsService (append-only ledger, idempotent)
//   * saved cards   -> PaymentsService.chargeRiderOffSession (real Stripe
//                      PaymentIntent, server-side verification + webhook
//                      reconciliation; the client is never trusted)
//
// All amounts come from the server-generated quote shares. A client can only
// confirm its OWN payment; it can never submit an amount or another user's id.

import { pool } from '../../config/database';
import { CreditsService } from '../credits/credits.service';
import { PaymentsService } from '../payments/payments.service';
import {
  canTransitionPayment,
  type PaymentStatus,
} from './group-state.rules';
import {
  emitGroupPaymentUpdated,
  emitGroupUpdated,
} from './group-events';

export class GroupPaymentError extends Error {
  readonly code: string;
  readonly statusCode: number;
  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface GroupPaymentRow {
  id: string;
  group_id: string;
  quote_id: string;
  participant_id: string;
  amount_cents: string | number;
  currency: string;
  status: PaymentStatus;
  method: string;
  stripe_payment_id: string | null;
  stripe_payment_intent_id: string | null;
  credit_transaction_id: string | null;
  credit_cents: string | number;
  card_cents: string | number;
  attempt_count: number;
  failure_reason: string | null;
  updated_at?: string | Date | null;
}

function cents(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

export class GroupPaymentsService {
  static async rowsForQuote(quoteId: string, client: any = pool): Promise<any[]> {
    const res = await client.query(
      `SELECT * FROM ride_group_payments WHERE quote_id = $1 ORDER BY participant_id`,
      [quoteId],
    );
    return res.rows;
  }

  /**
   * Recompute the group's payment gate from the authoritative rows of the
   * CURRENT quote. Only required shares (amount > 0) must be confirmed.
   * Caller owns the transaction when `client` is provided.
   */
  static async recomputeGroupReady(
    client: any,
    groupId: string,
    quoteId: string,
  ): Promise<{ ready: boolean; allPaid: boolean }> {
    const quoteRes = await client.query(
      `SELECT id, status FROM ride_group_quotes WHERE id = $1 AND group_id = $2 FOR UPDATE`,
      [quoteId, groupId],
    );
    const quote = quoteRes.rows[0];
    if (!quote || quote.status !== 'ACTIVE') return { ready: false, allPaid: false };

    const rows = await this.rowsForQuote(quoteId, client);
    const required = rows.filter((r) => cents(r.amount_cents) > 0);
    const allPaid = required.every(
      (r) => r.status === 'SUCCEEDED' || r.status === 'NOT_REQUIRED',
    );
    const anyProcessing = rows.some((r) => r.status === 'PROCESSING');

    // Member-level status mirrors the individual payment record (the host is
    // a participant too).
    for (const row of rows) {
      await client.query(
        `UPDATE ride_group_members
            SET payment_status = $3, updated_at = NOW()
          WHERE group_id = $1 AND user_id = $2`,
        [groupId, row.participant_id, row.status],
      );
    }

    const groupRes = await client.query(
      `SELECT status FROM ride_groups WHERE id = $1 FOR UPDATE`,
      [groupId],
    );
    const status = groupRes.rows[0]?.status as string | undefined;
    if (
      status &&
      ['DRAFT', 'COLLECTING_MEMBERS', 'CONFIGURING', 'AWAITING_PAYMENT', 'READY_TO_REQUEST'].includes(status)
    ) {
      const next = allPaid ? 'READY_TO_REQUEST' : 'AWAITING_PAYMENT';
      if (status !== next) {
        await client.query(
          `UPDATE ride_groups SET status = $2, updated_at = NOW() WHERE id = $1`,
          [groupId, next],
        );
        if (next === 'READY_TO_REQUEST') {
          await client.query(
            `INSERT INTO ride_group_messages (group_id, sender_id, message_type, content, metadata)
             VALUES ($1, NULL, 'PAYMENT', 'All required payments are confirmed. The host can request the ride.', $2::jsonb)`,
            [groupId, JSON.stringify({ quoteId })],
          );
        }
      }
    }
    return { ready: allPaid && !anyProcessing, allPaid };
  }

  /**
   * Confirm one participant's share.
   *
   * Idempotent: a duplicate confirmation returns the existing success. A
   * retry after a declined card only re-attempts the card remainder; ride
   * credits already debited are never charged twice.
   */
  static async confirmPayment(args: {
    groupId: string;
    userId: string;
    useCredits: boolean;
  }): Promise<{ payment: any; ready: boolean }> {
    const { groupId, userId } = args;
    const client = await pool.connect();
    let payment: GroupPaymentRow | null = null;
    let quoteId = '';
    let cardCents = 0;
    let attempt = 0;
    try {
      await client.query('BEGIN');
      const groupRes = await client.query(
        `SELECT * FROM ride_groups WHERE id = $1 FOR UPDATE`,
        [groupId],
      );
      const group = groupRes.rows[0];
      if (!group) throw new GroupPaymentError('GROUP_NOT_FOUND', 'Group not found', 404);
      if (['RIDE_REQUESTED', 'DRIVER_MATCHING', 'DRIVER_ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'EXPIRED'].includes(group.status)) {
        throw new GroupPaymentError('GROUP_LOCKED', 'This group ride is no longer accepting payments', 409);
      }
      const memberRes = await client.query(
        `SELECT * FROM ride_group_members
          WHERE group_id = $1 AND user_id = $2 AND status IN ('JOINED','PICKUP_PENDING','PICKUP_CONFIRMED')
          FOR UPDATE`,
        [groupId, userId],
      );
      if (!memberRes.rows[0]) {
        throw new GroupPaymentError('NOT_MEMBER', 'You are not a participant in this group', 403);
      }
      const quoteRes = await client.query(
        `SELECT * FROM ride_group_quotes
          WHERE id = $1 AND group_id = $2 FOR UPDATE`,
        [group.current_quote_id, groupId],
      );
      const quote = quoteRes.rows[0];
      if (!quote) {
        throw new GroupPaymentError('NO_QUOTE', 'The host has not created a current fare split yet', 409);
      }
      if (quote.status !== 'ACTIVE') {
        throw new GroupPaymentError('QUOTE_STALE', 'The fare quote changed. Please review the new amount.', 409);
      }
      if (new Date(quote.expires_at).getTime() <= Date.now()) {
        await client.query(
          `UPDATE ride_group_quotes SET status = 'EXPIRED' WHERE id = $1`,
          [quote.id],
        );
        await client.query(
          `UPDATE ride_groups
              SET status = 'CONFIGURING', current_quote_id = NULL, updated_at = NOW()
            WHERE id = $1 AND status IN ('AWAITING_PAYMENT','READY_TO_REQUEST','CONFIGURING')`,
          [groupId],
        );
        throw new GroupPaymentError('QUOTE_EXPIRED', 'This fare quote expired. Ask the host to refresh it.', 409);
      }
      quoteId = quote.id;

      const payRes = await client.query(
        `SELECT * FROM ride_group_payments
          WHERE quote_id = $1 AND participant_id = $2 FOR UPDATE`,
        [quoteId, userId],
      );
      payment = payRes.rows[0];
      if (!payment) {
        throw new GroupPaymentError('PAYMENT_NOT_FOUND', 'No payment is due for this participant', 404);
      }
      if (payment.status === 'SUCCEEDED') {
        await client.query('COMMIT');
        return { payment, ready: true };
      }
      if (payment.status === 'NOT_REQUIRED' || cents(payment.amount_cents) === 0) {
        await client.query(
          `UPDATE ride_group_payments
              SET status = 'NOT_REQUIRED', method = 'NONE', updated_at = NOW()
            WHERE id = $1`,
          [payment.id],
        );
        await this.recomputeGroupReady(client, groupId, quoteId);
        await client.query('COMMIT');
        await emitGroupPaymentUpdated(groupId, { quoteId, participantId: userId, ready: false });
        return { payment: { ...payment, status: 'NOT_REQUIRED' }, ready: false };
      }
      if (payment.status === 'REFUNDED' || payment.status === 'CANCELLED') {
        throw new GroupPaymentError('PAYMENT_CLOSED', 'This payment is closed. Ask the host to refresh the quote.', 409);
      }

      // If a prior attempt left the row PROCESSING, reconcile against the
      // verified Stripe state before starting a new charge. A concurrent or
      // recent in-flight attempt MUST be rejected here — otherwise two
      // confirm taps could create two PaymentIntents.
      if (payment.status === 'PROCESSING') {
        if (payment.stripe_payment_id) {
          const stripe = await client.query(
            `SELECT status, failure_reason, stripe_payment_intent_id
               FROM stripe_payments WHERE id = $1`,
            [payment.stripe_payment_id],
          );
          const row = stripe.rows[0];
          if (row?.status === 'SUCCEEDED') {
            await client.query(
              `UPDATE ride_group_payments
                  SET status = 'SUCCEEDED', succeeded_at = COALESCE(succeeded_at, NOW()),
                      updated_at = NOW()
                WHERE id = $1`,
              [payment.id],
            );
            await this.recomputeGroupReady(client, groupId, quoteId);
            await client.query('COMMIT');
            await emitGroupPaymentUpdated(groupId, { quoteId, participantId: userId, ready: true });
            return { payment: { ...payment, status: 'SUCCEEDED' }, ready: true };
          }
          if (!row || !['FAILED', 'CANCELED'].includes(row.status)) {
            await client.query('COMMIT');
            throw new GroupPaymentError(
              'PAYMENT_PROCESSING',
              'Your payment is still processing. Please wait a moment and refresh.',
              409,
            );
          }
          // Definitive failure: allow a new attempt.
          await client.query(
            `UPDATE ride_group_payments
                SET status = 'FAILED', failure_reason = $2, updated_at = NOW()
              WHERE id = $1`,
            [payment.id, row.failure_reason ?? 'Previous payment attempt failed'],
          );
        } else {
          const updatedAt = Date.parse(String(payment.updated_at ?? ''));
          const stale = Number.isFinite(updatedAt) && Date.now() - updatedAt > 120_000;
          if (!stale) {
            await client.query('COMMIT');
            throw new GroupPaymentError(
              'PAYMENT_PROCESSING',
              'Your payment is still processing. Please wait a moment and refresh.',
              409,
            );
          }
          // A crashed attempt that never created a Stripe row: release it.
          await client.query(
            `UPDATE ride_group_payments
                SET status = 'FAILED', failure_reason = 'Previous attempt was interrupted',
                    updated_at = NOW()
              WHERE id = $1`,
            [payment.id],
          );
        }
      }

      const amountCents = cents(payment.amount_cents);
      let creditCents = cents(payment.credit_cents);
      let creditTxId = payment.credit_transaction_id;

      if (args.useCredits && creditCents === 0) {
        const account = await client.query(
          `INSERT INTO ride_credit_accounts (user_id) VALUES ($1)
           ON CONFLICT (user_id) DO NOTHING`,
          [userId],
        );
        void account;
        const balRes = await client.query(
          `SELECT balance_cents FROM ride_credit_accounts WHERE user_id = $1 FOR UPDATE`,
          [userId],
        );
        const balance = cents(balRes.rows[0]?.balance_cents);
        const toApply = Math.min(balance, amountCents);
        if (toApply > 0) {
          const result = await CreditsService.post(userId, -toApply, 'RIDE_APPLIED', {
            client,
            idempotencyKey: `group-credit:${quoteId}:${userId}`,
            description: `Ride credits applied to group ride quote ${quoteId}`,
            referenceType: 'group_quote',
            referenceId: quoteId,
          });
          creditCents = result.applied ? toApply : 0;
          creditTxId = result.transaction_id || null;
        }
      }

      cardCents = Math.max(0, amountCents - creditCents);
      attempt = Number(payment.attempt_count ?? 0) + 1;
      await client.query(
        `UPDATE ride_group_payments
            SET status = $2, credit_cents = $3, card_cents = $4,
                credit_transaction_id = $5, attempt_count = $6,
                failure_reason = NULL, updated_at = NOW()
          WHERE id = $1`,
        [
          payment.id,
          cardCents > 0 ? 'PROCESSING' : 'SUCCEEDED',
          creditCents,
          cardCents,
          creditTxId,
          attempt,
        ],
      );
      if (cardCents <= 0) {
        await client.query(
          `UPDATE ride_group_payments
              SET method = 'CREDITS', succeeded_at = NOW(), updated_at = NOW()
            WHERE id = $1`,
          [payment.id],
        );
      } else {
        await client.query(
          `UPDATE ride_group_payments SET method = $2, updated_at = NOW() WHERE id = $1`,
          [payment.id, creditCents > 0 ? 'MIXED' : 'CARD'],
        );
      }
      await this.recomputeGroupReady(client, groupId, quoteId);
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* noop */ }
      throw err;
    } finally {
      client.release();
    }

    if (!payment) throw new GroupPaymentError('PAYMENT_NOT_FOUND', 'No payment is due', 404);

    // Card charge runs OUTSIDE the database transaction: holding a row lock
    // across an external Stripe call would block the whole group.
    let stripeResult: any = null;
    if (cardCents > 0) {
      stripeResult = await PaymentsService.chargeRiderOffSession({
        riderId: userId,
        amountCents: cardCents,
        purpose: 'RIDE_CHARGE',
        description: `NetRide group ride share (${groupId})`,
        idempotencyKey: `group-pay:${payment.id}:${attempt}`,
        metadata: {
          group_id: groupId,
          group_payment_id: payment.id,
          group_quote_id: quoteId,
        },
      });
    }

    const update = await pool.connect();
    try {
      await update.query('BEGIN');
      if (cardCents <= 0) {
        await update.query(
          `UPDATE ride_group_payments
              SET status = 'SUCCEEDED', succeeded_at = COALESCE(succeeded_at, NOW()),
                  updated_at = NOW()
            WHERE id = $1`,
          [payment.id],
        );
      } else if (stripeResult?.ok) {
        await update.query(
          `UPDATE ride_group_payments
              SET status = 'SUCCEEDED', stripe_payment_id = $2,
                  stripe_payment_intent_id = $3, succeeded_at = NOW(),
                  failure_reason = NULL, updated_at = NOW()
            WHERE id = $1`,
          [payment.id, stripeResult.paymentRowId ?? null, stripeResult.paymentIntentId ?? null],
        );
      } else {
        // Off-session SCA cannot be completed inside this flow. Mark it
        // failed so the rider can add/choose another card or use credits;
        // never leave the group stuck in PROCESSING forever.
        const status: PaymentStatus = 'FAILED';
        await update.query(
          `UPDATE ride_group_payments
              SET status = $2, stripe_payment_id = $3,
                  stripe_payment_intent_id = $4, failure_reason = $5, updated_at = NOW()
            WHERE id = $1`,
          [
            payment.id,
            status,
            stripeResult?.paymentRowId ?? null,
            stripeResult?.paymentIntentId ?? null,
            stripeResult?.requiresAction
              ? 'Your card requires additional verification. Add another card or use ride credits.'
              : String(stripeResult?.failureReason ?? stripeResult?.reason ?? 'Payment could not be completed').slice(0, 300),
          ],
        );
      }
      const ready = await this.recomputeGroupReady(update, groupId, quoteId);
      await update.query('COMMIT');
      await emitGroupPaymentUpdated(groupId, {
        quoteId,
        participantId: userId,
        ready: ready.ready,
      });
      if (ready.ready) await emitGroupUpdated(groupId, { status: 'READY_TO_REQUEST' });
      if (cardCents > 0 && !stripeResult?.ok) {
        throw new GroupPaymentError(
          'PAYMENT_FAILED',
          stripeResult?.requiresAction
            ? 'Your card requires additional verification. Use ride credits or a different card.'
            : 'Your payment could not be completed. Please try another payment method.',
          402,
        );
      }
      return { payment: { ...payment, status: cardCents > 0 ? 'SUCCEEDED' : 'SUCCEEDED' }, ready: ready.ready };
    } catch (err) {
      try { await update.query('ROLLBACK'); } catch { /* noop */ }
      throw err;
    } finally {
      update.release();
    }
  }

  /**
   * Refund every successful participant payment for a quote. Used when a
   * quote is invalidated and when a group is cancelled before the ride
   * completes. Idempotent per payment row.
   */
  static async refundQuotePayments(
    quoteId: string,
    reason: string,
  ): Promise<{ refunded: number; failed: number }> {
    // Include FAILED/CANCELLED rows whose ride credits were already debited
    // (a card failure after a credit debit must still return that credit).
    const res = await pool.query(
      `SELECT * FROM ride_group_payments
        WHERE quote_id = $1
          AND status <> 'REFUNDED'
          AND (
            status IN ('SUCCEEDED','PROCESSING')
            OR (status IN ('FAILED','CANCELLED') AND (credit_cents > 0 OR stripe_payment_id IS NOT NULL))
          )`,
      [quoteId],
    );
    let refunded = 0;
    let failed = 0;
    for (const row of res.rows) {
      const ok = await this.refundOne(row, reason);
      if (ok) refunded += 1;
      else failed += 1;
    }
    return { refunded, failed };
  }

  static async refundGroupPaymentsForRide(rideId: string, reason: string): Promise<void> {
    const res = await pool.query(
      `SELECT gp.*
         FROM ride_group_payments gp
         JOIN rides r ON r.group_id = gp.group_id
        WHERE r.id = $1
          AND gp.status <> 'REFUNDED'
          AND (
            gp.status IN ('SUCCEEDED','PROCESSING')
            OR (gp.status IN ('FAILED','CANCELLED') AND (gp.credit_cents > 0 OR gp.stripe_payment_id IS NOT NULL))
          )`,
      [rideId],
    );
    for (const row of res.rows) {
      await this.refundOne(row, reason);
    }
  }

  private static async refundOne(row: any, reason: string): Promise<boolean> {
    let ok = true;
    try {
      if (row.stripe_payment_id) {
        const result = await PaymentsService.refundPayment({
          stripePaymentId: row.stripe_payment_id,
          reason,
          idempotencyKey: `group-refund:${row.id}`,
        });
        if (!result.ok && result.reason !== 'not_collected') {
          ok = false;
        }
      }
      if (cents(row.credit_cents) > 0) {
        await CreditsService.post(row.participant_id, cents(row.credit_cents), 'RIDE_REFUND', {
          idempotencyKey: `group-credit-refund:${row.id}`,
          description: `Refunded ride credits for group payment ${row.id}`,
          referenceType: 'group_payment',
          referenceId: row.id,
        });
      }
      if (ok) {
        await pool.query(
          `UPDATE ride_group_payments
              SET status = 'REFUNDED', refunded_at = NOW(),
                  failure_reason = CASE WHEN failure_reason IS NULL THEN $2 ELSE failure_reason END,
                  updated_at = NOW()
            WHERE id = $1 AND status <> 'REFUNDED'`,
          [row.id, reason.slice(0, 300)],
        );
      } else {
        await pool.query(
          `UPDATE ride_group_payments
              SET failure_reason = $2, updated_at = NOW()
            WHERE id = $1`,
          [row.id, `REFUND_FAILED: ${reason}`.slice(0, 300)],
        );
      }
      return ok;
    } catch (err: any) {
      await pool.query(
        `UPDATE ride_group_payments SET failure_reason = $2, updated_at = NOW() WHERE id = $1`,
        [row.id, `REFUND_FAILED: ${String(err?.message ?? err)}`.slice(0, 300)],
      ).catch(() => undefined);
      return false;
    }
  }

  /**
   * Retry refunds for superseded/expired quotes (e.g. Stripe was briefly
   * unavailable when the host changed the fare). Idempotent; safe to run on a
   * schedule. Only ACTIVE/CONSUMED quotes are excluded.
   */
  static async sweepPendingQuoteRefunds(limit = 25): Promise<number> {
    const res = await pool.query(
      `SELECT q.id
         FROM ride_group_quotes q
         JOIN ride_group_payments gp ON gp.quote_id = q.id
        WHERE q.status IN ('SUPERSEDED','EXPIRED')
          AND gp.status <> 'REFUNDED'
          AND (
            gp.status IN ('SUCCEEDED','PROCESSING')
            OR (gp.status IN ('FAILED','CANCELLED') AND (gp.credit_cents > 0 OR gp.stripe_payment_id IS NOT NULL))
          )
        GROUP BY q.id
        ORDER BY MAX(gp.created_at) ASC
        LIMIT $1`,
      [Math.min(100, Math.max(1, Math.round(limit)))],
    );
    let processed = 0;
    for (const row of res.rows) {
      await this.refundQuotePayments(row.id, 'quote replaced or expired');
      processed += 1;
    }
    return processed;
  }

  /** Webhook reconciliation: verify + apply a successful Stripe charge. */
  static async applyVerifiedStripeSuccess(stripePaymentId: string): Promise<void> {
    let res = await pool.query(
      `SELECT * FROM ride_group_payments WHERE stripe_payment_id = $1`,
      [stripePaymentId],
    );
    let payment = res.rows[0];
    if (!payment) {
      // Crash window: Stripe charged before the group payment row learned
      // its stripe_payment_id. The server-written metadata is the link.
      const meta = await pool.query(
        `SELECT metadata FROM stripe_payments WHERE id = $1`,
        [stripePaymentId],
      );
      const groupPaymentId = meta.rows[0]?.metadata?.group_payment_id;
      if (groupPaymentId) {
        res = await pool.query(
          `SELECT * FROM ride_group_payments WHERE id = $1`,
          [groupPaymentId],
        );
        payment = res.rows[0];
      }
    }
    if (!payment) return;
    if (payment.status === 'SUCCEEDED') return;
    const stripe = await pool.query(
      `SELECT stripe_payment_intent_id FROM stripe_payments WHERE id = $1`,
      [stripePaymentId],
    );
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE ride_group_payments
            SET status = 'SUCCEEDED', succeeded_at = COALESCE(succeeded_at, NOW()),
                stripe_payment_id = COALESCE(stripe_payment_id, $3),
                stripe_payment_intent_id = COALESCE(stripe_payment_intent_id, $2),
                failure_reason = NULL, updated_at = NOW()
          WHERE id = $1 AND status <> 'REFUNDED'`,
        [payment.id, stripe.rows[0]?.stripe_payment_intent_id ?? null, stripePaymentId],
      );
      const ready = await this.recomputeGroupReady(client, payment.group_id, payment.quote_id);
      await client.query('COMMIT');
      await emitGroupPaymentUpdated(payment.group_id, {
        quoteId: payment.quote_id,
        participantId: payment.participant_id,
        ready: ready.ready,
      });
      if (ready.ready) await emitGroupUpdated(payment.group_id, { status: 'READY_TO_REQUEST' });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* noop */ }
      throw err;
    } finally {
      client.release();
    }
  }

  static async applyVerifiedStripeFailure(
    stripePaymentId: string,
    failureReason: string | null,
  ): Promise<void> {
    let res = await pool.query(
      `SELECT * FROM ride_group_payments WHERE stripe_payment_id = $1`,
      [stripePaymentId],
    );
    let payment = res.rows[0];
    if (!payment) {
      const meta = await pool.query(
        `SELECT metadata FROM stripe_payments WHERE id = $1`,
        [stripePaymentId],
      );
      const groupPaymentId = meta.rows[0]?.metadata?.group_payment_id;
      if (groupPaymentId) {
        res = await pool.query(
          `SELECT * FROM ride_group_payments WHERE id = $1`,
          [groupPaymentId],
        );
        payment = res.rows[0];
      }
    }
    if (!payment || payment.status === 'SUCCEEDED' || payment.status === 'REFUNDED') return;
    await pool.query(
      `UPDATE ride_group_payments
          SET status = 'FAILED', failure_reason = $2,
              stripe_payment_id = COALESCE(stripe_payment_id, $3),
              updated_at = NOW()
        WHERE id = $1 AND status <> 'REFUNDED'`,
      [payment.id, String(failureReason ?? 'Payment failed').slice(0, 300), stripePaymentId],
    );
    await emitGroupPaymentUpdated(payment.group_id, {
      quoteId: payment.quote_id,
      participantId: payment.participant_id,
      ready: false,
    });
  }

  static canMovePayment(from: PaymentStatus, to: PaymentStatus): boolean {
    return canTransitionPayment(from, to);
  }
}
