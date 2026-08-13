import { redis } from '../config/redis';
import { env } from '../config/env';
import { prisma } from '../services/prisma.service';
import { RideRepository } from '../modules/ride/ride.repository';
import { TripStatus } from '../types';
import { LocationsService } from '../modules/location/locations.service';

export interface DriverEligibility {
  eligible: boolean;
  reason?: string;
  locationFresh: boolean;
  hasActiveTrip: boolean;
  hasActiveOffer: boolean;
  isOnline: boolean;
  isActive: boolean;
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
   *
   * Returns a structured result so callers can understand WHY a driver
   * was rejected and log meaningful diagnostics.
   */
  static async checkEligibility(driverId: string): Promise<DriverEligibility> {
    const [heartbeat, activeTrip, activeOffer, driverDb] = await Promise.all([
      redis.get(`${DRIVER_HEARTBEAT_PREFIX}${driverId}`),
      redis.get(`driver:${driverId}:active_trip`),
      redis.get(`${DRIVER_OFFER_PREFIX}${driverId}`),
      prisma.driver.findUnique({
        where: { user_id: driverId },
        select: { is_active: true },
      }).catch(() => null),
    ]);

    const isOnline = heartbeat !== null;
    const isActive = driverDb?.is_active === true;
    const hasActiveTrip = activeTrip !== null;
    const hasActiveOffer = activeOffer !== null;
    const locationFresh = await DriverEligibilityService.isLocationFresh(driverId);

    const eligible = isOnline && isActive && !hasActiveTrip && !hasActiveOffer && locationFresh;

    const reasons: string[] = [];
    if (!isOnline) reasons.push('offline');
    if (!isActive) reasons.push('deactivated');
    if (hasActiveTrip) reasons.push('has_active_trip');
    if (hasActiveOffer) reasons.push('has_active_offer');
    if (!locationFresh) reasons.push('stale_location');

    return {
      eligible,
      reason: reasons.length > 0 ? reasons.join(', ') : undefined,
      isOnline,
      hasActiveTrip,
      hasActiveOffer,
      isActive,
      locationFresh,
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
   */
  static async filterEligible(driverIds: string[]): Promise<string[]> {
    if (driverIds.length === 0) return [];

    const results = await Promise.allSettled(
      driverIds.map(id => DriverEligibilityService.checkEligibility(id)),
    );

    const eligible: string[] = [];
    for (let i = 0; i < driverIds.length; i++) {
      const r = results[i];
      if (r.status === 'fulfilled' && r.value.eligible) {
        eligible.push(driverIds[i]);
      }
    }

    return eligible;
  }
}
