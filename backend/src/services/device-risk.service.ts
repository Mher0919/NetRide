// backend/src/services/device-risk.service.ts
//
// DEVICE / INSTALL RISK SIGNALS — referral reward eligibility.
// ---------------------------------------------------------------------------
// Collects privacy-conscious install identifiers (opaque id persisted at app
// install time — never a hardware identifier). A device is ONLY a signal:
// the reward pipeline still requires a completed paid ride, and the account
// is never banned solely for device sharing (family devices are expected).
//
// Risk ladder (per user, worst device across all their installs):
//   NORMAL  — no other account has ever used this install
//   REVIEW  — exactly one other account on the install (flag, still rewarded)
//   BLOCKED — two or more other accounts (reward eligibility rejected)
//
// The state is stored on users.device_risk_state and consumed at reward time
// inside referral.service.ts (processFirstRideCompleted) — the ONLY place
// money is minted, so the gate can never be bypassed by the UI.

import { pool } from '../config/database';
import { AuditEventsService } from './audit-events.service';

export const DEVICE_RISK_STATES = ['NORMAL', 'REVIEW', 'BLOCKED'] as const;
export type DeviceRiskState = (typeof DEVICE_RISK_STATES)[number];

export interface DeviceFingerprintInput {
  deviceId?: string | null;
  platform?: string | null;
  deviceModel?: string | null;
  appVersion?: string | null;
}

/** Pure risk ladder — exported for unit tests. */
export function accountsToRisk(accounts: number): DeviceRiskState {
  if (accounts >= 3) return 'BLOCKED';
  if (accounts === 2) return 'REVIEW';
  return 'NORMAL';
}

export class DeviceRiskService {
  /**
   * Registers (or refreshes) an install for the user, then recomputes the
   * user's risk state as the worst across every install they have used.
   * Returns the resulting state. Never throws — risk evaluation must never
   * break onboarding.
   */
  static async registerDevice(userId: string, input: DeviceFingerprintInput): Promise<DeviceRiskState> {
    const deviceId = input.deviceId?.trim();
    try {
      if (deviceId) {
        await pool.query(
          `INSERT INTO user_devices (user_id, device_id, platform, device_model, app_version)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (user_id, device_id) DO UPDATE SET
             last_seen_at = NOW(),
             platform = COALESCE(EXCLUDED.platform, user_devices.platform),
             device_model = COALESCE(EXCLUDED.device_model, user_devices.device_model),
             app_version = COALESCE(EXCLUDED.app_version, user_devices.app_version)`,
          [userId, deviceId.slice(0, 128), input.platform ?? null, input.deviceModel ?? null, input.appVersion ?? null],
        );
      }

      // Worst-case across every device this user has ever used.
      const counts = await pool.query(
        `SELECT MAX(n)::int AS max_accounts FROM (
           SELECT COUNT(DISTINCT d.user_id) AS n
           FROM user_devices d
           JOIN user_devices mine ON mine.device_id = d.device_id
           WHERE mine.user_id = $1
           GROUP BY d.device_id
         ) t`,
        [userId],
      );
      const computed = accountsToRisk(Number(counts.rows[0]?.max_accounts ?? 1));

      const current = await pool.query(
        `UPDATE users SET device_risk_state = $2, updated_at = NOW()
         WHERE id = $1 AND device_risk_state <> $2
         RETURNING device_risk_state`,
        [userId, computed],
      );
      if (computed !== 'NORMAL' && current.rows.length > 0) {
        await AuditEventsService.record({
          actorId: userId,
          actorRole: 'RIDER',
          action: 'DEVICE_RISK_DETECTED',
          entityType: 'USER',
          entityId: userId,
          details: {
            device_id: deviceId ?? null,
            accounts_on_device: Number(counts.rows[0]?.max_accounts ?? 1),
            risk_state: computed,
          },
        });
      }
      return computed;
    } catch (err: any) {
      console.warn(`[DEVICE-RISK] ⚠️ evaluation failed for ${userId}: ${err.message}`);
      return 'NORMAL';
    }
  }

  /** Read-only helper for admin dashboards. */
  static async getRiskState(userId: string): Promise<DeviceRiskState> {
    const res = await pool.query(`SELECT device_risk_state FROM users WHERE id = $1`, [userId]);
    return (res.rows[0]?.device_risk_state ?? 'NORMAL') as DeviceRiskState;
  }
}
