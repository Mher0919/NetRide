// backend/src/services/weeklyPayouts.service.ts
//
// RETIRED — automatic payouts are gone.
// ---------------------------------------------------------------------------
// Withdrawals are MANUAL only: drivers press "Withdraw" in the driver app
// (once per week, window opens Monday 00:00 UTC — see
// modules/payments/withdrawal.service.ts for the shared rule). On-demand
// payout rows are created by the driver and paid out manually by NetRide.
//
// This class is kept only so existing call sites (cron registration, tests)
// fail loudly instead of silently creating automatic payouts: runPayouts is
// a no-op by design.

import { pool } from '../config/database';

export class WeeklyPayoutsService {
  static async tick(): Promise<{ fired: boolean; processed: number; skipped: string[] }> {
    return { fired: false, processed: 0, skipped: ['manual-withdrawals-only'] };
  }

  /** No-op: automatic weekly payouts must never run. */
  static async runPayouts(): Promise<number> {
    const remaining = await pool
      .query(`SELECT COUNT(*)::int AS n FROM payouts WHERE method = 'WEEKLY_AUTO' AND status = 'PENDING'`)
      .catch(() => ({ rows: [{ n: 0 }] }));
    console.warn(
      `[PAYOUTS] ⏹️ Automatic weekly payout sweep retired (manual withdrawals only). ` +
        `PENDING WEEKLY_AUTO rows outstanding: ${remaining.rows[0]?.n ?? 0}`,
    );
    return 0;
  }
}