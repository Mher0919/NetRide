// backend/src/services/ride-rejection.service.ts
//
// Driver-specific ride interaction history — the persistent memory behind
// the dispatch rule "a driver who rejected OR accepted-then-cancelled ride R
// never receives R again" (while R stays offerable to every other eligible
// driver).
//
// Storage: `ride_driver_rejections (ride_id, driver_id, interaction_type,
// rejected_at, reason_code, reason_text)`. Despite the legacy table name this
// IS the rideDriverHistory store (migration 20260816 created it;
// 20260818_add_ride_driver_interaction_types.sql widened it); the
// interaction_type distinguishes:
//
//   REJECTED                 — driver declined BEFORE accepting
//   ACCEPTED_THEN_CANCELLED  — driver accepted, then cancelled pre-pickup
//
// For MATCHING purposes both types mean EXCLUDED (one query, no status
// filter); the history type is preserved for analytics/auditing.
//
// The composite primary key keeps the operation idempotent: repeated
// declines or repeated cancels from the same driver (double tap, network
// retry, app restart, listener replay) always collapse into the same single
// record.
//
// This is deliberately NOT a flag on the ride document: a ride rejected by
// one driver must remain offerable to others, and interaction history must
// survive app restarts, offer expiry, engine retries, and driver
// offline/online cycles. Rows cascade-delete with the ride, so they never
// leak beyond the ride lifecycle (spec: DRIVER_REJECTED_REQUEST !=
// DRIVER_CANCELLED_ACCEPTED_RIDE != RIDER_CANCELLED_RIDE).

import { pool } from '../config/database';

export const REJECTION_STATUS = 'REJECTED';
export const ACCEPTED_THEN_CANCELLED_STATUS = 'ACCEPTED_THEN_CANCELLED';

export type RideDriverInteractionStatus =
  | typeof REJECTION_STATUS
  | typeof ACCEPTED_THEN_CANCELLED_STATUS;

/**
 * Exported SQL (offline-testable contract, see
 * services/__tests__/ride-rejection.unit.test.ts). The upsert targets the
 * (ride_id, driver_id) primary-key pair, so repeated interactions collapse
 * into the same single record. interaction_type is preserved (a REJECTED is
 * never silently rewritten by a stale retry, and vice versa) — only missing
 * reason fields are backfilled; rejected_at is re-stamped.
 */
export const RECORD_REJECTION_SQL = `INSERT INTO ride_driver_rejections
       (ride_id, driver_id, status, interaction_type, reason_code, reason_text, rejected_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (ride_id, driver_id)
       DO UPDATE SET
         status = EXCLUDED.status,
         interaction_type = EXCLUDED.interaction_type,
         reason_code = COALESCE(EXCLUDED.reason_code, ride_driver_rejections.reason_code),
         reason_text = COALESCE(EXCLUDED.reason_text, ride_driver_rejections.reason_text),
         rejected_at = NOW()`;

export const REJECTED_DRIVER_IDS_SQL = `SELECT driver_id FROM ride_driver_rejections WHERE ride_id = $1`;

export const HAS_REJECTED_SQL = `SELECT 1 FROM ride_driver_rejections WHERE ride_id = $1 AND driver_id = $2`;

export class RideRejectionService {
  /**
   * Records (or re-confirms) that `driverId` rejected `rideId` BEFORE
   * accepting it. Idempotent: one logical record per (ride, driver) pair
   * regardless of how many times the decline arrives upstream.
   */
  static async recordRejection(rideId: string, driverId: string): Promise<void> {
    await RideRejectionService.recordInteraction(rideId, driverId, REJECTION_STATUS);
  }

  /**
   * Records that `driverId` ACCEPTED `rideId` and then cancelled it before
   * pickup. Same exclusion semantics as a pre-accept rejection — the driver
   * must never be offered this ride again — but the interaction_type
   * preserves the fact that the cancellation happened after acceptance
   * (spec §3.3/§12, ACCEPTED_THEN_CANCELLED). Idempotent.
   */
  static async recordCancelAfterAcceptance(
    rideId: string,
    driverId: string,
    opts: { reasonCode?: string | null; reasonText?: string | null } = {},
  ): Promise<void> {
    await RideRejectionService.recordInteraction(
      rideId,
      driverId,
      ACCEPTED_THEN_CANCELLED_STATUS,
      opts.reasonCode ?? null,
      opts.reasonText ?? null,
    );
  }

  /**
   * Single idempotent upsert shared by both interaction types.
   */
  static async recordInteraction(
    rideId: string,
    driverId: string,
    interactionType: RideDriverInteractionStatus,
    reasonCode: string | null = null,
    reasonText: string | null = null,
  ): Promise<void> {
    const reasonTextClean = reasonText ? String(reasonText).trim().slice(0, 300) || null : null;
    await pool.query(RECORD_REJECTION_SQL, [
      rideId,
      driverId,
      interactionType,
      interactionType,
      reasonCode,
      reasonTextClean,
    ]);
  }

  /**
   * All driver ids that have a terminal interaction (REJECTED or
   * ACCEPTED_THEN_CANCELLED) with this ride. Used by the dispatch pipeline
   * to shrink the candidate pool before a single offer is made. One query,
   * no status filter — both interaction types exclude the driver for
   * matching purposes (§12).
   */
  static async rejectedDriverIds(rideId: string): Promise<Set<string>> {
    const res = await pool.query(REJECTED_DRIVER_IDS_SQL, [rideId]);
    return new Set(res.rows.map((r) => r.driver_id));
  }

  /** Single-pair check (per-offer guard). Any interaction type excludes. */
  static async hasRejected(rideId: string, driverId: string): Promise<boolean> {
    const res = await pool.query(HAS_REJECTED_SQL, [rideId, driverId]);
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Pure filter — the ONE place that turns an excluded-driver set into an
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
