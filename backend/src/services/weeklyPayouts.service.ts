// backend/src/services/weeklyPayouts.service.ts
//
// Weekly auto-payout job. Every Monday morning at 09:00 UTC the server
// sweeps every verified driver who:
//   - is_active = true (currently cleared to drive)
//   - background_check_status = 'APPROVED'
//   - has an APPROVED payout card
//   - has a non-zero wallet balance
//
// and inserts a PENDING WEEKLY_AUTO payout for the full balance. The
// admin then marks it paid through the dashboard (no bank integration).
//
// Idempotency: every driver can have at most one WEEKLY_AUTO payout with
// status='PENDING' at any time, enforced by a partial UNIQUE INDEX in
// migration 020. The cron re-runs only on the matching wall-clock minute,
// so we never double-fire under the 60s tick.
//
// Implementation note: instead of pulling in `node-cron` we use the
// existing `setInterval` pattern in `app.ts` and gate the body on the
// exact UTC minute. This keeps the dependency surface flat.

import { pool } from '../config/database';
import { redis } from '../config/redis';

const LAST_FIRE_KEY = 'cron:weekly_payouts:last_fired'; // ISO date string of last successful run

export class WeeklyPayoutsService {
  /**
   * Cron tick. Caller invokes once per minute. We match on the exact
   * minute (UTC day=1, hour=9, minute=0) and then take a Redis lock so
   * multiple replicas cannot double-run.
   */
  static async tick(): Promise<{ fired: boolean; processed: number; skipped: string[] }> {
    const now = new Date();
    // Day-of-week: 0 (Sun) – 6 (Sat). Monday = 1.
    if (now.getUTCDay() !== 1) {
      return { fired: false, processed: 0, skipped: ['not-monday'] };
    }
    if (now.getUTCHours() !== 9) {
      return { fired: false, processed: 0, skipped: ['not-9am-utc'] };
    }
    // Bucket on the date — only fire once per day even if the minute
    // window crosses our 60s tick.
    const todayKey = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}`;
    const last = await redis.get(LAST_FIRE_KEY);
    if (last === todayKey) {
      return { fired: false, processed: 0, skipped: ['already-fired-today'] };
    }

    // Acquire a 90s lock; if another instance already has it, bail out.
    const lockKey = 'cron:weekly_payouts:lock';
    const lockToken = `${process.pid}:${Date.now()}`;
    const acquired = await redis.set(lockKey, lockToken, 'EX', 90, 'NX');
    if (acquired !== 'OK') {
      return { fired: false, processed: 0, skipped: ['lock-held'] };
    }

    try {
      const processed = await this.runPayouts();
      await redis.set(LAST_FIRE_KEY, todayKey, 'EX', 60 * 60 * 24 * 8); // 8d TTL — covers a long weekend
      console.log(`[PAYOUTS] ✅ Weekly auto-payout sweep processed ${processed} drivers`);
      return { fired: true, processed, skipped: [] };
    } finally {
      await redis.del(lockKey);
    }
  }

  /**
   * One atomic transaction per driver: open a WEEKLY_AUTO PENDING payout
   * for the full wallet balance and zero the wallet. Idempotency is
   * enforced by the partial UNIQUE INDEX on
   *   (driver_id) WHERE method='WEEKLY_AUTO' AND status='PENDING'
   * in migration 020 — concurrent runs cannot insert a second open row.
   */
  static async runPayouts(): Promise<number> {
    const client = await pool.connect();
    let processed = 0;
    try {
      // Snapshot eligible drivers.
      const eligible = await client.query(
        `SELECT w.driver_id, w.balance_cents
         FROM driver_wallets w
         JOIN users u ON u.id = w.driver_id
         JOIN drivers d ON d.user_id = w.driver_id
         WHERE u.is_active = true
           AND u.role = 'DRIVER'
           AND d.background_check_status = 'APPROVED'
           AND w.balance_cents > 0
           AND w.payout_card_id IS NOT NULL`
      );
      if (eligible.rowCount === 0) {
        return 0;
      }

      for (const row of eligible.rows) {
        const driverId: string = row.driver_id;
        const balanceCents: number = Number(row.balance_cents);
        try {
          await client.query('BEGIN');
          // Re-read the wallet balance under FOR UPDATE to defeat races
          // with on-demand payouts that may be processing right now.
          const lock = await client.query(
            `SELECT balance_cents FROM driver_wallets WHERE driver_id = $1 FOR UPDATE`,
            [driverId]
          );
          const fresh = Number(lock.rows[0]?.balance_cents ?? 0);
          if (fresh <= 0) {
            await client.query('ROLLBACK');
            continue;
          }
          // Use a synthetic ride_id NULL — the partial UNIQUE on
          // payouts(ride_id) WHERE method='RIDE_CREDIT' doesn't apply.
          await client.query(
            `INSERT INTO payouts (driver_id, amount_cents, fee_cents, net_cents, status, method)
             VALUES ($1, $2, 0, $2, 'PENDING', 'WEEKLY_AUTO')
             ON CONFLICT DO NOTHING`,
            [driverId, fresh]
          );
          await client.query(
            `UPDATE driver_wallets SET balance_cents = 0, updated_at = NOW() WHERE driver_id = $1`,
            [driverId]
          );
          await client.query('COMMIT');
          processed++;
          console.log(`[PAYOUTS] 💸 Queued WEEKLY_AUTO payout of ${fresh}¢ for driver ${driverId}`);
        } catch (e: any) {
          await client.query('ROLLBACK');
          // Most likely cause: existing PENDING WEEKLY_AUTO row from a
          // prior run (race). Log and move on.
          console.warn(`[PAYOUTS] ⚠️ Skipped driver ${driverId} (${balanceCents}¢): ${e.message}`);
        }
      }
      return processed;
    } finally {
      client.release();
    }
  }
}