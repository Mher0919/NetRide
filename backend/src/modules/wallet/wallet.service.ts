// backend/src/modules/wallet/wallet.service.ts
//
// RIDER WALLET — default payment method for ride fares.
// ---------------------------------------------------------------------------
// - Balances live in `rider_wallets` as BIGINT cents.
// - Every movement is appended to `wallet_transactions` (never mutated).
// - All writes are transactional and atomic (guarded UPDATE + ledger row).
// - idempotency_key dedupes retries/concurrent callers.
// - The backend is the ONLY writer; clients only read.
//
// Payment semantics (mirrors real-world rides):
//   ride REQUESTED → wallet is charged the remaining fare AFTER promo +
//                    credits discounts (credits are a discount, wallet pays).
//   ride CANCELLED → the charge is refunded, once, idempotently.
//   ride COMPLETED → no further wallet movement (the charge already posted).

import { pool } from '../../config/database';
import { getIo } from '../../gateway/io-handle';
import { computeWalletCharge } from './wallet-cap';

export type WalletTxType =
  | 'ADMIN_GRANT'
  | 'RIDE_PAYMENT'
  | 'RIDE_REFUND'
  | 'ADJUSTMENT'
  | 'SPONSOR_REWARD'
  | 'WALLET_TOPUP';

export interface WalletAccount {
  user_id: string;
  balance_cents: number;
  lifetime_deposited_cents: number;
  lifetime_spent_cents: number;
  updated_at: Date;
}

export interface WalletResult {
  balance_cents: number;
  delta_cents: number;
  transaction_id: string;
  applied: boolean;
}

function emitBalanceChange(userId: string, balanceCents: number, deltaCents: number, type: string) {
  try {
    getIo().to(`rider:${userId}`).emit('walletBalanceChanged', {
      balance_cents: balanceCents,
      delta_cents: deltaCents,
      type,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.warn(`[WALLET] ⚠️ balance socket emit failed: ${err.message}`);
  }
}

export class WalletService {
  /** Ensures a wallet exists and returns it. */
  static async getAccount(userId: string): Promise<WalletAccount> {
    await pool.query(
      `INSERT INTO rider_wallets (user_id) VALUES ($1)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId],
    );
    const acc = await pool.query(
      `SELECT user_id, balance_cents, lifetime_deposited_cents, lifetime_spent_cents, updated_at
       FROM rider_wallets WHERE user_id = $1`,
      [userId],
    );
    return {
      user_id: acc.rows[0].user_id,
      balance_cents: Number(acc.rows[0].balance_cents),
      lifetime_deposited_cents: Number(acc.rows[0].lifetime_deposited_cents),
      lifetime_spent_cents: Number(acc.rows[0].lifetime_spent_cents),
      updated_at: acc.rows[0].updated_at,
    };
  }

  /**
   * Posts a signed amount to a rider's wallet inside one transaction.
   * Negative amounts are guarded by `balance_cents >= 0` — an overdraft
   * aborts the whole transaction.
   *
   * Idempotent: if `idempotencyKey` was already posted, returns the original
   * result without touching the balance a second time.
   */
  static async post(
    userId: string,
    deltaCents: number,
    type: WalletTxType,
    opts: {
      idempotencyKey?: string;
      description?: string;
      referenceType?: string;
      referenceId?: string;
      rideId?: string;
      emitSocket?: boolean;
      client?: any;
      stripePaymentIntentId?: string;
    } = {},
  ): Promise<WalletResult> {
    const delta = Math.round(deltaCents);
    if (delta === 0) {
      const acc = await this.getAccount(userId);
      return { balance_cents: acc.balance_cents, delta_cents: 0, transaction_id: '', applied: false };
    }

    const useClient = opts.client ?? pool;

    if (opts.idempotencyKey) {
      const existing = await useClient.query(
        `SELECT id, balance_after_cents FROM wallet_transactions WHERE idempotency_key = $1`,
        [opts.idempotencyKey],
      );
      if (existing.rows.length > 0) {
        return {
          balance_cents: Number(existing.rows[0].balance_after_cents),
          delta_cents: delta,
          transaction_id: existing.rows[0].id,
          applied: true,
        };
      }
    }

    await useClient.query('BEGIN');
    let began = true;
    try {
      await useClient.query(
        `INSERT INTO rider_wallets (user_id) VALUES ($1)
         ON CONFLICT (user_id) DO NOTHING`,
        [userId],
      );

      if (delta < 0) {
        // Guarded debit — refuses to overdraw the wallet.
        const upd = await useClient.query(
          `UPDATE rider_wallets
           SET balance_cents = balance_cents + $1,
               lifetime_spent_cents = lifetime_spent_cents + ABS($1),
               updated_at = NOW()
           WHERE user_id = $2 AND balance_cents >= $3
           RETURNING balance_cents`,
          [delta, userId, Math.abs(delta)],
        );
        if (upd.rowCount === 0) {
          throw new Error('Insufficient wallet balance');
        }
      } else {
        await useClient.query(
          `UPDATE rider_wallets
           SET balance_cents = balance_cents + $1,
               lifetime_deposited_cents = lifetime_deposited_cents + $1,
               updated_at = NOW()
           WHERE user_id = $2
           RETURNING balance_cents`,
          [delta, userId],
        );
      }

      const balRes = await useClient.query(
        `SELECT balance_cents FROM rider_wallets WHERE user_id = $1`,
        [userId],
      );
      const balanceAfter = Number(balRes.rows[0].balance_cents);

      const tx = await useClient.query(
        `INSERT INTO wallet_transactions
           (user_id, amount_cents, type, reference_type, reference_id, ride_id,
            description, balance_after_cents, idempotency_key, stripe_payment_intent_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id`,
        [
          userId,
          delta,
          type,
          opts.referenceType ?? null,
          opts.referenceId ?? null,
          opts.rideId ?? null,
          opts.description ?? null,
          balanceAfter,
          opts.idempotencyKey ?? null,
          opts.stripePaymentIntentId ?? null,
        ],
      );

      await useClient.query('COMMIT');
      began = false;

      if (opts.emitSocket !== false) {
        emitBalanceChange(userId, balanceAfter, delta, type);
      }

      return {
        balance_cents: balanceAfter,
        delta_cents: delta,
        transaction_id: tx.rows[0]?.id ?? '',
        applied: tx.rows[0]?.id ? true : false,
      };
    } catch (err) {
      if (began) {
        try { await useClient.query('ROLLBACK'); } catch { /* already rolled back */ }
      }
      throw err;
    }
  }

  /**
   * Charges the rider's wallet for a ride: the wallet pays the FULL amount
   * due (remaining fare after promo + credits) up to the available balance.
   * Must run inside the caller's transaction context when a `client` is
   * provided so the ride row + ledger stay consistent.
   *
   * Returns how many cents were actually charged (0 when the wallet is
   * empty) and the final amount still owed after the wallet payment.
   */
  static async chargeForRide(
    riderId: string,
    rideId: string,
    amountDueCents: number,
    opts: { client?: any } = {},
  ): Promise<{ walletChargeCents: number; finalCents: number; balanceCents: number }> {
    const useClient = opts.client ?? pool;
    const acc = await this.getAccount(riderId);
    const { walletChargeCents, finalCents } = computeWalletCharge(
      amountDueCents,
      acc.balance_cents,
    );
    if (walletChargeCents <= 0) {
      return { walletChargeCents: 0, finalCents, balanceCents: acc.balance_cents };
    }
    const result = await this.post(riderId, -walletChargeCents, 'RIDE_PAYMENT', {
      idempotencyKey: `wallet-charge:${rideId}`,
      description: `Wallet payment for ride ${rideId}`,
      referenceType: 'ride',
      referenceId: rideId,
      rideId,
      emitSocket: true,
      client: useClient,
    });
    return {
      walletChargeCents: result.applied ? walletChargeCents : 0,
      finalCents: result.applied ? finalCents : amountDueCents,
      balanceCents: result.balance_cents,
    };
  }

  /**
   * Refunds the wallet payment a cancelled ride consumed. Idempotent — the
   * refund ledger row carries its own idempotency key, so concurrent
   * cancels post once.
   */
  static async refundRide(riderId: string, rideId: string): Promise<WalletResult> {
    const applied = await pool.query(
      `SELECT amount_cents FROM wallet_transactions
       WHERE ride_id = $1 AND type = 'RIDE_PAYMENT' AND idempotency_key = $2`,
      [rideId, `wallet-charge:${rideId}`],
    );
    if (applied.rows.length === 0) {
      return { balance_cents: 0, delta_cents: 0, transaction_id: '', applied: false };
    }
    const refundCents = Math.abs(Number(applied.rows[0].amount_cents));
    return this.post(riderId, refundCents, 'RIDE_REFUND', {
      idempotencyKey: `wallet-refund:${rideId}`,
      description: `Wallet refund for cancelled ride ${rideId}`,
      referenceType: 'ride',
      referenceId: rideId,
      rideId,
    });
  }

  /** Admin grant (or ADJUSTMENT when negative). */
  static async adminGrant(
    adminId: string,
    userId: string,
    amountCents: number,
    reason: string,
  ): Promise<WalletResult> {
    const delta = Math.round(amountCents);
    if (delta === 0) throw new Error('Grant amount must be non-zero');
    const type: WalletTxType = delta > 0 ? 'ADMIN_GRANT' : 'ADJUSTMENT';
    return this.post(userId, delta, type, {
      idempotencyKey: `admin:wallet:${adminId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      description: reason || (type === 'ADMIN_GRANT' ? 'Admin wallet grant' : 'Admin wallet adjustment'),
      referenceType: 'admin',
    });
  }

  static async listTransactions(userId: string, limit = 50, offset = 0) {
    const res = await pool.query(
      `SELECT id, amount_cents, type, reference_type, reference_id, ride_id,
              description, balance_after_cents, created_at
       FROM wallet_transactions
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, Math.min(Math.max(limit, 1), 200), Math.max(offset, 0)],
    );
    return res.rows.map((r: any) => ({
      ...r,
      amount_cents: Number(r.amount_cents),
      balance_after_cents: Number(r.balance_after_cents),
    }));
  }
}
