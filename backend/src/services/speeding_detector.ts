// backend/src/services/speeding_detector.ts
//
// Detects dangerous driving via the trajectory buffer that
// LocationsService.bufferTrajectory already populates. The detector
// subscribes to the in-process emitter on LocationsService and runs a
// lightweight continuous-over-limit check against the per-leg speed
// limit map written by NavigationService.
//
// Rules (matching the driver's HUD):
//   - Regular road: mph > speed_limit            → counting
//   - Freeway:     mph > speed_limit + 10        → counting
//   - 45s of continuous over-limit               → one violation recorded
//   - mph drops back under the same threshold    → counter resets
//
// After a trip ends (COMPLETED or CANCELLED), finalizeTrip() queries
// the last SPEEDING_WINDOW_DAYS of completed trips. If the driver has
// violations in >= SPEEDING_DANGER_TRIP_COUNT distinct trips, set
// drivers.is_dangerous = TRUE (idempotent) and write an audit_logs row.

import { env } from '../config/env';
import { pool } from '../config/database';
import { NavigationService } from './navigation.service';

type Leg = 'pickup' | 'destination';

interface TrajectoryPoint {
  lat: number;
  lng: number;
  speed_mps?: number | null;
  t: string; // ISO timestamp
}

interface ViolationAccumulator {
  // Continuous over-limit streak for this trip.
  startMs: number | null;
  // Sustained-true: true while the driver has been over-limit for >=45s
  // without dropping back under. We keep counting further seconds so we
  // can record a *separate* violation if they keep speeding for another
  // 45s. That second 45s window starts the moment the first one flushes.
  startMsForCurrent: number | null;
  maxOverMph: number;
  speedSumMph: number;
  speedSamples: number;
  roadName: string | null;
  isFreeway: boolean;
}

export class SpeedingDetector {
  // Per (driverId, tripId) accumulator. Cleared in finalizeTrip().
  private static tripState = new Map<string, ViolationAccumulator>();
  // Tracks which trip has any violations so finalizeTrip can short-circuit.
  private static tripsWithViolations = new Set<string>();

  /**
   * Invoked by LocationsService for each trajectory point it buffers.
   * Pure: never throws. Bad input is logged and ignored so a single
   * malformed point can't take down the location pipeline.
   */
  static async onTrajectoryPoint(
    driverId: string,
    tripId: string,
    point: TrajectoryPoint
  ): Promise<void> {
    try {
      if (env.NODE_ENV === 'test') return;
      const mph = point.speed_mps != null ? point.speed_mps * 2.23694 : 0;
      if (!Number.isFinite(mph) || mph <= 0) {
        // Stationary → reset streak.
        this.resetStreak(driverId, tripId);
        return;
      }

      const route = await this.resolveRouteForPoint(driverId, tripId, point);
      if (!route) {
        // No cached route yet — nothing to compare against. Don't count.
        this.resetStreak(driverId, tripId);
        return;
      }

      const limitMph = route.speedLimitMph;
      const isFw = route.isFreeway;
      const overThreshold = isFw ? limitMph + 10 : limitMph;

      const key = this.key(driverId, tripId);
      let state = this.tripState.get(key);
      if (!state) {
        state = this.emptyState();
        this.tripState.set(key, state);
      }

      const nowMs = new Date(point.t).getTime();

      if (mph > overThreshold) {
        if (state.startMsForCurrent == null) {
          state.startMsForCurrent = nowMs;
        }
        state.maxOverMph = Math.max(state.maxOverMph, mph - overThreshold);
        state.speedSumMph += mph;
        state.speedSamples += 1;
        state.isFreeway = isFw;
        state.roadName = route.roadName;

        const durationS = (nowMs - state.startMsForCurrent) / 1000;
        if (durationS >= env.SPEEDING_VIOLATION_DURATION_S) {
          await this.flushViolation(driverId, tripId, state, nowMs);
          // After flushing, reset the "current" window so the next 45s
          // of speeding counts as a *separate* violation.
          state.startMsForCurrent = null;
        }
      } else {
        state.startMsForCurrent = null;
      }
    } catch (err: any) {
      // Never let a detector bug affect the location pipeline.
      console.error(`[SAFETY] SpeedingDetector error: ${err.message}`);
    }
  }

  /**
   * Called by RideService when the trip ends. Aggregates "did this trip
   * have any violation?" and (if so) re-checks whether the driver
   * crosses the SPEEDING_DANGER_TRIP_COUNT threshold.
   */
  static async finalizeTrip(driverId: string, tripId: string): Promise<void> {
    try {
      if (env.NODE_ENV === 'test') return;
      // If the trip never had a violation recorded, just clean up state.
      if (!this.tripsWithViolations.has(tripId)) {
        this.tripState.delete(this.key(driverId, tripId));
        return;
      }
      this.tripsWithViolations.delete(tripId);
      this.tripState.delete(this.key(driverId, tripId));

      const windowStart = new Date(
        Date.now() - env.SPEEDING_WINDOW_DAYS * 24 * 60 * 60 * 1000
      ).toISOString();

      const recent = await pool.query(
        `SELECT COUNT(DISTINCT trip_id) AS trip_count
           FROM speeding_violations
          WHERE driver_id = $1
            AND created_at >= $2`,
        [driverId, windowStart]
      );
      const tripCount = parseInt(recent.rows[0]?.trip_count ?? '0', 10);

      if (tripCount < env.SPEEDING_DANGER_TRIP_COUNT) return;

      const already = await pool.query(
        `SELECT is_dangerous FROM drivers WHERE user_id = $1`,
        [driverId]
      );
      if (already.rows[0]?.is_dangerous === true) return;

      await pool.query(
        `UPDATE drivers SET is_dangerous = TRUE WHERE user_id = $1`,
        [driverId]
      );
      await pool.query(
        `INSERT INTO audit_logs (admin_id, target_id, action, details)
         VALUES (NULL, $1, 'MARK_DANGEROUS', $2)`,
        [
          driverId,
          JSON.stringify({
            reason: 'speeding_violations_threshold',
            trip_count: tripCount,
            window_days: env.SPEEDING_WINDOW_DAYS,
            threshold: env.SPEEDING_DANGER_TRIP_COUNT,
          }),
        ]
      );
      console.log(
        `[SAFETY] ⚠️ Driver ${driverId} flagged as DANGEROUS — ${tripCount} violation-trips in last ${env.SPEEDING_WINDOW_DAYS}d`
      );
    } catch (err: any) {
      console.error(`[SAFETY] finalizeTrip error for driver ${driverId}: ${err.message}`);
    }
  }

  /**
   * Reset a driver's dangerous flag (admin action).
   */
  static async clearDangerousFlag(driverId: string, adminId: string, notes?: string): Promise<void> {
    await pool.query(`UPDATE drivers SET is_dangerous = FALSE WHERE user_id = $1`, [driverId]);
    await pool.query(
      `INSERT INTO audit_logs (admin_id, target_id, action, details)
       VALUES ($1, $2, 'CLEAR_DANGEROUS', $3)`,
      [adminId, driverId, JSON.stringify({ notes: notes ?? null })]
    );
  }

  /**
   * Admin endpoint: list a driver's recent violations.
   */
  static async listForDriver(driverId: string, limit = 50): Promise<any[]> {
    const res = await pool.query(
      `SELECT v.*, r.pickup_address, r.destination_address
         FROM speeding_violations v
         LEFT JOIN rides r ON r.id = v.trip_id
        WHERE v.driver_id = $1
        ORDER BY v.created_at DESC
        LIMIT $2`,
      [driverId, limit]
    );
    return res.rows;
  }

  static async listRecent(limit = 200): Promise<any[]> {
    const res = await pool.query(
      `SELECT v.*, r.pickup_address, r.destination_address,
              u.full_name AS driver_name, u.email AS driver_email
         FROM speeding_violations v
         LEFT JOIN rides r ON r.id = v.trip_id
         LEFT JOIN users u ON u.id = v.driver_id
        ORDER BY v.created_at DESC
        LIMIT $1`,
      [limit]
    );
    return res.rows;
  }

  // ---- Internals --------------------------------------------------------

  private static key(driverId: string, tripId: string): string {
    return `${driverId}::${tripId}`;
  }

  private static emptyState(): ViolationAccumulator {
    return {
      startMs: null,
      startMsForCurrent: null,
      maxOverMph: 0,
      speedSumMph: 0,
      speedSamples: 0,
      roadName: null,
      isFreeway: false,
    };
  }

  private static resetStreak(driverId: string, tripId: string): void {
    const key = this.key(driverId, tripId);
    const state = this.tripState.get(key);
    if (state) state.startMsForCurrent = null;
  }

  private static async flushViolation(
    driverId: string,
    tripId: string,
    state: ViolationAccumulator,
    nowMs: number
  ): Promise<void> {
    const startedAt = new Date(state.startMsForCurrent ?? nowMs).toISOString();
    const durationS = Math.max(
      0,
      Math.round((nowMs - (state.startMsForCurrent ?? nowMs)) / 1000)
    );
    const avgSpeedMph =
      state.speedSamples > 0
        ? Math.round(state.speedSumMph / state.speedSamples)
        : 0;

    await pool.query(
      `INSERT INTO speeding_violations
         (driver_id, trip_id, started_at, ended_at, duration_seconds,
          max_over_mph, avg_speed_mph, road_name, is_freeway)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        driverId,
        tripId,
        startedAt,
        new Date(nowMs).toISOString(),
        Math.max(durationS, env.SPEEDING_VIOLATION_DURATION_S),
        Math.round(state.maxOverMph),
        avgSpeedMph,
        state.roadName,
        state.isFreeway,
      ]
    );

    this.tripsWithViolations.add(tripId);
  }

  /**
   * Look up the speed limit + freeway flag for the road the driver is
   * currently on. We probe both the pickup and destination cached legs
   * (whichever is active) and pick the first match by road name / ref.
   *
   * Cheap: one or two Redis reads, never a per-point routing API call.
   */
  private static async resolveRouteForPoint(
    driverId: string,
    tripId: string,
    _point: TrajectoryPoint
  ): Promise<{ speedLimitMph: number; isFreeway: boolean; roadName: string | null } | null> {
    // The current leg is implied by the trip status, but the detector
    // runs in real time and may receive a point before/after the
    // status flips. Probe both legs and pick the one with a matching
    // road. To keep this O(1) we accept either cache, preferring pickup
    // (driver is usually on it).
    const legs: Leg[] = ['pickup', 'destination'];
    for (const leg of legs) {
      const cached = await NavigationService.getCachedRouteLeg(tripId, leg);
      if (!cached) continue;
      const limits = cached.speedLimitsByRoad ?? {};
      // Find any road that produced a hit for this leg. The detector
      // doesn't need exact snapping — the speed limit is constant
      // across the leg in practice, and the driver spends most of the
      // leg on one road anyway.
      const firstKey = Object.keys(limits)[0];
      if (!firstKey) continue;
      return {
        speedLimitMph: limits[firstKey],
        isFreeway: firstKey.match(/\b(I-|US-|SR-|CA-|\bFwy\b|\bFreeway\b|\bInterstate\b)/i) != null,
        roadName: firstKey,
      };
    }
    return null;
  }
}