import { redis } from '../config/redis';
import { env } from '../config/env';
import { prisma } from '../services/prisma.service';
import { RideRepository } from '../modules/ride/ride.repository';
import { TripStatus } from '../types';
import { LocationsService } from '../modules/location/locations.service';
import { RideRejectionService } from './ride-rejection.service';

export interface DriverEligibility {
  eligible: boolean;
  reason?: string;
  locationFresh: boolean;
  hasActiveTrip: boolean;
  hasActiveOffer: boolean;
  isOnline: boolean;
  isActive: boolean;
  rejectedRide: boolean;
}

const DRIVER_HEARTBEAT_PREFIX = 'driver:heartbeat:';
const DRIVER_OFFER_PREFIX = 'driver:offer:';

export class DriverEligibilityService {
  /**
   * Comprehensive driver eligibility check.
   *
   * A driver is eligible if ALL of the following are true:
   *  - The driver account is active (is_active = true)
   *  - The heartbeat key exists in Redis (online within the last 90s)
   *  - The driver does NOT have an active trip (no driver:{id}:active_trip)
   *  - The driver does NOT have an active offer (no driver:offer:{id})
   *  - The driver's location in Redis is fresh
   *  - (when a rideId is given) the driver has NOT rejected this ride
   *    (persistent `ride_driver_rejections` exclusion)
   *
   * Returns a structured result so callers can understand WHY a driver
   * was rejected and log meaningful diagnostics.
   */
  static async checkEligibility(driverId: string, rideId?: string): Promise<DriverEligibility> {
    const [heartbeat, activeTripKey, activeOffer, driverDb] = await Promise.all([
      redis.get(`${DRIVER_HEARTBEAT_PREFIX}${driverId}`),
      redis.get(`driver:${driverId}:active_trip`),
      redis.get(`${DRIVER_OFFER_PREFIX}${driverId}`),
      prisma.driver.findUnique({
        where: { user_id: driverId },
        // `drivers.is_active` is the ADMIN-ONBOARDING approval flag and
        // stays FALSE for every self-serve / password-signup driver who
        // never went through admin approval — using it here filtered out
        // 100% of those drivers (the dispatch regression). The runtime gate
        // mirrors the one the driver app itself enforces to go online:
        // the USER account must be active (suspension flag); the compliance
        // blockers (docs/headshot/vehicle/pending changes) gate the app UI
        // before it ever emits `goOnline`.
        select: {
          is_active: true,
          user: { select: { is_active: true } },
        },
      }).catch(() => null),
    ]);

    const isOnline = heartbeat !== null;
    const isActive = driverDb?.user?.is_active === true;

    // Self-heal stale active-trip keys. The key is written at ACCEPT time
    // with a 4h TTL and only cleared on COMPLETE or CANCEL — when a test or
    // app kill leaves the ride dangling (or the ride was terminal in the DB
    // all along), the driver would otherwise be excluded from EVERY
    // dispatch for the full 4h while standing online at the pickup. This
    // mirrors the reconciliation acceptTrip() already performs on its own
    // path. A genuinely live IN_PROGRESS / ACCEPTED ride still blocks
    // (correct behavior) — only impossible or terminal states are healed.
    let hasActiveTrip = activeTripKey !== null;
    if (hasActiveTrip) {
      try {
        const trip = await RideRepository.findById(activeTripKey!);
        if (
          !trip ||
          trip.status === TripStatus.COMPLETED ||
          trip.status === TripStatus.CANCELLED ||
          trip.status === TripStatus.REQUESTED
        ) {
          await redis.del(`driver:${driverId}:active_trip`);
          console.log(
            `[DISPATCH] 🧹 Healed stale active_trip key for driver ${driverId} ` +
            `(was ${activeTripKey}, status=${trip?.status ?? 'missing'})`,
          );
          hasActiveTrip = false;
        } else if (trip.status === TripStatus.ACCEPTED && trip.driver_id !== driverId) {
          // Cached key points at a ride this driver is not assigned to.
          await redis.del(`driver:${driverId}:active_trip`);
          console.log(
            `[DISPATCH] 🧹 Cleared mismatched active_trip key for driver ${driverId} ` +
            `(was ${activeTripKey}, assigned to ${trip.driver_id})`,
          );
          hasActiveTrip = false;
        }
      } catch {
        // DB hiccup — keep blocking (conservative); the 4h TTL still self-heals.
      }
    }

    const hasActiveOffer = activeOffer !== null;
    const locationFresh = await DriverEligibilityService.isLocationFresh(driverId);

    // Driver-specific ride exclusion: if this driver already rejected this
    // ride, they must never receive it again — regardless of how many times
    // matching restarts (engine retry, decline re-enqueue, app restart).
    // Rides rejected by one driver stay offerable to every other driver;
    // this table is scoped to the (ride, driver) pair only.
    let rejectedRide = false;
    if (rideId) {
      rejectedRide = await RideRejectionService.hasRejected(rideId, driverId);
    }

    const eligible =
      isOnline && isActive && !hasActiveTrip && !hasActiveOffer && locationFresh && !rejectedRide;

    const reasons: string[] = [];
    if (!isOnline) reasons.push('offline');
    if (!isActive) reasons.push('deactivated');
    if (hasActiveTrip) reasons.push('has_active_trip');
    if (hasActiveOffer) reasons.push('has_active_offer');
    if (!locationFresh) reasons.push('stale_location');
    if (rejectedRide) reasons.push('rejected_ride');

    return {
      eligible,
      reason: reasons.length > 0 ? reasons.join(', ') : undefined,
      isOnline,
      hasActiveTrip,
      hasActiveOffer,
      isActive,
      locationFresh,
      rejectedRide,
    };
  }

  /**
   * Check if a driver's location is fresh enough to dispatch.
   * Uses heartbeat TTL as a proxy for location freshness.
   * A driver who sent a heartbeat within the freshness window is
   * considered to have a fresh location.
   */
  static async isLocationFresh(driverId: string): Promise<boolean> {
    const heartbeat = await redis.get(`${DRIVER_HEARTBEAT_PREFIX}${driverId}`);
    if (!heartbeat) return false;
    const ttl = await redis.ttl(`${DRIVER_HEARTBEAT_PREFIX}${driverId}`);
    const maxAge = env.DRIVER_LOCATION_FRESHNESS_S;
    return ttl > 0 && (90 - ttl) <= maxAge;
  }

  /**
   * Check if a driver who is currently IN_PROGRESS is eligible
   * as a "near-completion" candidate. The driver must:
   *  - Be the assigned driver on an active IN_PROGRESS ride
   *  - Be predicted to finish within the near-completion threshold
   */
  static async checkNearCompletionEligibility(
    driverId: string,
    newPickupLat: number,
    newPickupLng: number,
  ): Promise<{ eligible: boolean; etaMinutes?: number; reason?: string }> {
    const activeTripId = await redis.get(`driver:${driverId}:active_trip`);
    if (!activeTripId) return { eligible: false, reason: 'no_active_trip' };

    const trip = await RideRepository.findById(activeTripId);
    if (!trip || trip.status !== TripStatus.IN_PROGRESS) {
      return { eligible: false, reason: `trip_status=${trip?.status ?? 'unknown'}` };
    }

    const driverLoc = await LocationsService.getDriverLocation(driverId);
    if (!driverLoc) return { eligible: false, reason: 'no_driver_location' };

    try {
      const { GeospatialService } = await import('../modules/geospatial/geospatial.service');
      const [remainingRoute, toNewPickupRoute] = await Promise.all([
        GeospatialService.getRoute(
          [driverLoc.lat, driverLoc.lng],
          [trip.destination.lat, trip.destination.lng],
        ).catch(() => null),
        GeospatialService.getRoute(
          [trip.destination.lat, trip.destination.lng],
          [newPickupLat, newPickupLng],
        ).catch(() => null),
      ]);

      if (!remainingRoute || !toNewPickupRoute) {
        return { eligible: false, reason: 'route_calc_failed' };
      }

      const remainingSeconds = remainingRoute.eta;
      const transferSeconds = toNewPickupRoute.eta;
      const totalSeconds = remainingSeconds + transferSeconds;

      if (remainingSeconds > env.NEAR_COMPLETION_THRESHOLD_S) {
        return {
          eligible: false,
          etaMinutes: Math.round(totalSeconds / 60),
          reason: `remaining_${Math.round(remainingSeconds / 60)}m_exceeds_threshold`,
        };
      }

      return {
        eligible: true,
        etaMinutes: Math.round(totalSeconds / 60),
      };
    } catch {
      return { eligible: false, reason: 'eligibility_check_error' };
    }
  }

  /**
   * Batch eligibility filter — efficiently filters a list of driver IDs
   * to only those who are eligible. Returns the eligible subset.
   *
   * When a rideId is given, drivers who already rejected that ride are
   * excluded FIRST (one query for the whole batch) — the enforcement point
   * of the persistent driver-rejection rule. Every dispatch path funnels
   * through this filter, so the exclusion lives in exactly one place.
   *
   * Skipped drivers are logged with their reasons — a silent empty result
   * here reads as "no candidates" in the dispatch pipeline, which hid the
   * real cause (e.g. a stuck active-trip key) for far too long.
   */
  static async filterEligible(driverIds: string[], rideId?: string): Promise<string[]> {
    if (driverIds.length === 0) return [];

    const remainingIds = rideId
      ? RideRejectionService.excludeRejected(
          driverIds.map(id => ({ id })),
          await RideRejectionService.rejectedDriverIds(rideId),
        ).map(d => d.id)
      : driverIds;

    if (remainingIds.length === 0) return [];

    const results = await Promise.allSettled(
      remainingIds.map(id => DriverEligibilityService.checkEligibility(id)),
    );

    const eligible: string[] = [];
    for (let i = 0; i < remainingIds.length; i++) {
      const r = results[i];
      if (r.status === 'fulfilled' && r.value.eligible) {
        eligible.push(remainingIds[i]);
      } else {
        const reason =
          r.status === 'fulfilled'
            ? (r.value.reason ?? 'unknown')
            : `check_failed: ${r.reason?.message ?? 'error'}`;
        console.log(`[DISPATCH] Skipping driver ${remainingIds[i]}: ${reason}`);
      }
    }

    return eligible;
  }
}
