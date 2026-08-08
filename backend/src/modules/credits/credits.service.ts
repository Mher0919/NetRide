// backend/src/modules/credits/credits.service.ts
//
// RIDE CREDITS — single source of truth for rider credit balances.
// ---------------------------------------------------------------------------
// - Balances live in `ride_credit_accounts` as BIGINT cents.
// - Every movement is appended to `credit_transactions` (never mutated).
// - All writes are transactional and atomic (guarded UPDATE + ledger row).
// - idempotency_key dedupes retries/concurrent callers.
// - The backend is the ONLY writer; clients only read.

import { pool } from '../../config/database';
import { io } from '../../app';
import { computeCreditApplication, roundCents } from './credits-cap';

export type CreditTxType =
  | 'REFERRAL_REWARD'
  | 'ADMIN_GRANT'
  | 'RIDE_APPLIED'
  | 'RIDE_REFUND'
  | 'ADJUSTMENT';

export interface CreditAccount {
  user_id: string;
  balance_cents: number;
  lifetime_earned_cents: number;
  updated_at: Date;
}

export interface CreditResult {
  balance_cents: number;
  delta_cents: number;
  transaction_id: string;
  applied: boolean;
}

function emitBalanceChange(userId: string, balanceCents: number, deltaCents: number, type: string) {
  try {
    io.to(`rider:${userId}`).emit('creditBalanceChanged', {
      balance_cents: balanceCents,
      delta_cents: deltaCents,
      type,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.warn(`[CREDITS] ⚠️ balance socket emit failed: ${err.message}`);
  }
}

export class CreditsService {
  /** Ensures a credit account exists and returns it. */
  static async getAccount(userId: string): Promise<CreditAccount> {
    const res = await pool.query(
      `INSERT INTO ride_credit_accounts (user_id) VALUES ($1)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId],
    );
    const acc = await pool.query(
      `SELECT user_id, balance_cents, lifetime_earned_cents, updated_at
       FROM ride_credit_accounts WHERE user_id = $1`,
      [userId],
    );
    return {
      user_id: acc.rows[0].user_id,
      balance_cents: Number(acc.rows[0].balance_cents),
      lifetime_earned_cents: Number(acc.rows[0].lifetime_earned_cents),
      updated_at: acc.rows[0].updated_at,
    };
  }

  /**
   * Posts a signed amount to a rider's account inside one transaction.
   * Negative amounts are guarded by `balance_cents >= 0` — an overdraft
   * aborts the whole transaction.
   *
   * Idempotent: if `idempotencyKey` was already posted, returns the original
   * result without touching the balance a second time.
   */
  static async post(
    userId: string,
    deltaCents: number,
    type: CreditTxType,
    opts: {
      idempotencyKey?: string;
      description?: string;
      referenceType?: string;
      referenceId?: string;
      rideId?: string;
      emitSocket?: boolean;
      client?: any;
    } = {},
  ): Promise<CreditResult> {
    const delta = roundCents(deltaCents);
    if (delta === 0) {
      const acc = await this.getAccount(userId);
      return { balance_cents: acc.balance_cents, delta_cents: 0, transaction_id: '', applied: false };
    }

    const useClient = opts.client ?? pool;

    if (opts.idempotencyKey) {
      const existing = await useClient.query(
        `SELECT id, balance_after_cents FROM credit_transactions WHERE idempotency_key = $1`,
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
        `INSERT INTO ride_credit_accounts (user_id) VALUES ($1)
         ON CONFLICT (user_id) DO NOTHING`,
        [userId],
      );

      if (delta < 0) {
        // Guarded debit — refuses to overdraw the account.
        const upd = await useClient.query(
          `UPDATE ride_credit_accounts
           SET balance_cents = balance_cents + $1, updated_at = NOW()
           WHERE user_id = $2 AND balance_cents >= $3
           RETURNING balance_cents`,
          [delta, userId, Math.abs(delta)],
        );
        if (upd.rowCount === 0) {
          throw new Error('Insufficient ride credits');
        }
      } else {
        await useClient.query(
          `UPDATE ride_credit_accounts
           SET balance_cents = balance_cents + $1,
               lifetime_earned_cents = lifetime_earned_cents + $1,
               updated_at = NOW()
           WHERE user_id = $2
           RETURNING balance_cents`,
          [delta, userId],
        );
      }

      const balRes = await useClient.query(
        `SELECT balance_cents FROM ride_credit_accounts WHERE user_id = $1`,
        [userId],
      );
      const balanceAfter = Number(balRes.rows[0].balance_cents);

      const tx = await useClient.query(
        `INSERT INTO credit_transactions
           (user_id, amount_cents, type, reference_type, reference_id, ride_id,
            description, balance_after_cents, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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
 * Applies credits to a ride: debits min(balance, maxCents, capCents) and
 * records the ledger entry. `capCents` lets the rider choose a partial
 * amount instead of the whole balance. Returns how many cents were
 * actually applied (0 if none). Must run inside the caller's transaction
 * context when a `client` is provided so the ride row + ledger stay
 * consistent.
 */
static async applyToRide(
    riderId: string,
    rideId: string,
    maxCents: number,
    opts: { client?: any; capCents?: number } = {},
  ): Promise<{ appliedCents: number; balanceCents: number }> {
    const useClient = opts.client ?? pool;
    const acc = await this.getAccount(riderId);
    const applied = computeCreditApplication(
      acc.balance_cents,
      maxCents,
      opts.capCents,
    );
    if (applied <= 0) {
      return { appliedCents: 0, balanceCents: acc.balance_cents };
    }
    const result = await this.post(riderId, -applied, 'RIDE_APPLIED', {
      idempotencyKey: `ride-applied:${rideId}`,
      description: `Ride credits applied to ride ${rideId}`,
      referenceType: 'ride',
      referenceId: rideId,
      rideId,
      emitSocket: true,
      client: useClient,
    });
    return { appliedCents: result.applied ? applied : 0, balanceCents: result.balance_cents };
  }

  /**
   * Refunds the credits a ride consumed. Idempotent — the refund ledger row
   * carries its own idempotency key, so concurrent cancels post once.
   */
  static async refundRide(riderId: string, rideId: string): Promise<CreditResult> {
    const applied = await pool.query(
      `SELECT amount_cents FROM credit_transactions
       WHERE ride_id = $1 AND type = 'RIDE_APPLIED' AND idempotency_key = $2`,
      [rideId, `ride-applied:${rideId}`],
    );
    if (applied.rows.length === 0) {
      return { balance_cents: 0, delta_cents: 0, transaction_id: '', applied: false };
    }
    const refundCents = Math.abs(Number(applied.rows[0].amount_cents));
    return this.post(riderId, refundCents, 'RIDE_REFUND', {
      idempotencyKey: `ride-refund:${rideId}`,
      description: `Refunded ride credits for cancelled ride ${rideId}`,
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
  ): Promise<CreditResult> {
    const delta = roundCents(amountCents);
    if (delta === 0) throw new Error('Grant amount must be non-zero');
    const type: CreditTxType = delta > 0 ? 'ADMIN_GRANT' : 'ADJUSTMENT';
    return this.post(userId, delta, type, {
      idempotencyKey: `admin:${adminId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      description: reason || (type === 'ADMIN_GRANT' ? 'Admin credit grant' : 'Admin adjustment'),
      referenceType: 'admin',
    });
  }

  static async listTransactions(userId: string, limit = 50, offset = 0) {
    const res = await pool.query(
      `SELECT id, amount_cents, type, reference_type, reference_id, ride_id,
              description, balance_after_cents, created_at
       FROM credit_transactions
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

  /** Admin: search riders + balances (paginated). */
  static async listAccountsAdmin(search: string, limit = 50, offset = 0) {
    const res = await pool.query(
      `SELECT u.id AS user_id, u.full_name, u.email, u.phone_number, u.is_active,
              COALESCE(rca.balance_cents, 0)::bigint AS balance_cents,
              COALESCE(rca.lifetime_earned_cents, 0)::bigint AS lifetime_earned_cents,
              rca.updated_at
       FROM users u
       LEFT JOIN ride_credit_accounts rca ON rca.user_id = u.id
       WHERE u.role = 'RIDER' OR EXISTS (SELECT 1 FROM drivers d WHERE d.user_id = u.id)
       AND ($1 = '' OR u.full_name ILIKE '%' || $1 || '%' OR u.email ILIKE '%' || $1 || '%'
            OR u.phone_number ILIKE '%' || $1 || '%')
       ORDER BY rca.balance_cents DESC NULLS LAST
       LIMIT $2 OFFSET $3`,
      [search || '', Math.min(Math.max(limit, 1), 200), Math.max(offset, 0)],
    );
    return res.rows.map((r: any) => ({
      ...r,
      balance_cents: Number(r.balance_cents),
      lifetime_earned_cents: Number(r.lifetime_earned_cents),
    }));
  }
}
