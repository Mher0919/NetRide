// backend/src/services/ride-rejection.service.ts
//
// Driver-specific ride request rejections — the persistent memory behind
// the dispatch rule "a driver who explicitly rejected ride R never receives
// R again" (while R stays offerable to every other eligible driver).
//
// Storage: `ride_driver_rejections (ride_id, driver_id, status, rejected_at)`
// (migration 20260816_add_ride_driver_rejections.sql). The composite primary
// key keeps the operation idempotent: repeated declines from the same driver
// (double tap, network retry, app restart, listener replay) always collapse
// into the same single record.
//
// This is deliberately NOT a flag on the ride document: a ride rejected by
// one driver must remain offerable to others, and rejection history must
// survive app restarts, offer expiry, engine retries, and driver
// offline/online cycles. Rows cascade-delete with the ride, so they never
// leak beyond the ride lifecycle (spec: DRIVER_REJECTED != RIDER_CANCELLED).

import { pool } from '../config/database';

export const REJECTION_STATUS = 'REJECTED';

/**
 * Exported SQL (offline-testable contract, see
 * services/__tests__/ride-rejection.unit.test.ts). The upsert targets the
 * (ride_id, driver_id) primary-key pair, so repeated declines collapse into
 * the same single record.
 */
export const RECORD_REJECTION_SQL = `INSERT INTO ride_driver_rejections (ride_id, driver_id, status, rejected_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (ride_id, driver_id)
       DO UPDATE SET status = EXCLUDED.status, rejected_at = NOW()`;

export const REJECTED_DRIVER_IDS_SQL = `SELECT driver_id FROM ride_driver_rejections WHERE ride_id = $1`;

export const HAS_REJECTED_SQL = `SELECT 1 FROM ride_driver_rejections WHERE ride_id = $1 AND driver_id = $2`;

export class RideRejectionService {
  /**
   * Records (or re-confirms) that `driverId` rejected `rideId`.
   *
   * Idempotent: one logical record per (ride, driver) pair regardless of
   * how many times the decline arrives upstream.
   */
  static async recordRejection(rideId: string, driverId: string): Promise<void> {
    await pool.query(RECORD_REJECTION_SQL, [rideId, driverId, REJECTION_STATUS]);
  }

  /**
   * All driver ids that rejected this ride. Used by the dispatch pipeline
   * to shrink the candidate pool before a single offer is made.
   */
  static async rejectedDriverIds(rideId: string): Promise<Set<string>> {
    const res = await pool.query(REJECTED_DRIVER_IDS_SQL, [rideId]);
    return new Set(res.rows.map((r) => r.driver_id));
  }

  /** Single-pair check (per-offer guard). */
  static async hasRejected(rideId: string, driverId: string): Promise<boolean> {
    const res = await pool.query(HAS_REJECTED_SQL, [rideId, driverId]);
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Pure filter — the ONE place that turns a rejected-driver set into an
   * exclusion over an otherwise-scored candidate list. Shared by every
   * dispatch path so no screen/job can drift into its own filter.
   */
  static excludeRejected<T extends { id: string }>(
    drivers: readonly T[],
    rejected: ReadonlySet<string>,
  ): T[] {
    if (rejected.size === 0) return drivers as T[];
    return drivers.filter((d) => !rejected.has(d.id));
  }
}
