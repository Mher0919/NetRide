import { Server } from 'socket.io';
import { redis } from '../config/redis';
import { env } from '../config/env';
import { RideRepository } from '../modules/ride/ride.repository';
import { LocationsService } from '../modules/location/locations.service';
import { GeospatialService } from '../modules/geospatial/geospatial.service';
import { resolveRideFare } from './pricing.service';
import { DispatchService, ScoredDriver } from './dispatch.service';
import { DriverEligibilityService } from './driver-eligibility.service';
import { DriverOfferService, OfferStatus } from './driver-offer.service';
import { dispatchAcceptOutcomeTotal } from '../observability/metrics';
import { TripStatus } from '../types';

const RIDE_LOCK_PREFIX = 'ride:lock:';

export interface MatchingState {
  stage: number;
  candidateIndex: number;
  attemptCount: number;
}

export class DispatchEngine {
  static async acquireRideLock(rideId: string): Promise<boolean> {
    const key = `${RIDE_LOCK_PREFIX}${rideId}`;
    const acquired = await redis.set(key, '1', 'EX', 120, 'NX');
    return acquired !== null;
  }

  static async releaseRideLock(rideId: string): Promise<void> {
    await redis.del(`${RIDE_LOCK_PREFIX}${rideId}`);
  }

  static async saveMatchingState(rideId: string, state: MatchingState): Promise<void> {
    await redis.set('ride:matching:' + rideId, JSON.stringify(state), 'EX', 300);
  }

  static async clearMatchingState(rideId: string): Promise<void> {
    await redis.del('ride:matching:' + rideId);
  }

  static radiusForStage(stage: number): number {
    switch (stage) {
      case 0: return env.DISPATCH_INITIAL_RADIUS_KM;
      case 1: return env.DISPATCH_SECONDARY_RADIUS_KM;
      case 2: return env.DISPATCH_MAX_RADIUS_KM;
      default: return env.DISPATCH_MAX_RADIUS_KM;
    }
  }

  static async findCandidates(
    pickup: { lat: number; lng: number },
    radiusKm: number,
    riderId?: string,
    favoritePriority: boolean = false,
  ): Promise<ScoredDriver[]> {
    const scored = await DispatchService.getWeightedDrivers(pickup, radiusKm, riderId, favoritePriority);
    if (scored.length === 0) return [];
    const eligibleIds = await DriverEligibilityService.filterEligible(scored.map(d => d.id));
    return scored.filter(d => eligibleIds.includes(d.id));
  }

  static async executeMatching(
    io: Server,
    rideId: string,
    pickupLat: number,
    pickupLng: number,
    riderId?: string,
    favoritePriority: boolean = false,
    resumeFrom?: MatchingState,
  ): Promise<'assigned' | 'cancelled' | 'failed'> {
    const initialStage = resumeFrom?.stage ?? 0;
    const candidateOffset = resumeFrom?.candidateIndex ?? 0;
    let attemptCount = resumeFrom?.attemptCount ?? 0;

    for (let stage = initialStage; stage <= 2; stage++) {
      const radius = DispatchEngine.radiusForStage(stage);
      console.log(`[DISPATCH] Stage ${stage}: radius=${radius}km ride=${rideId}`);

      const candidates = await DispatchEngine.findCandidates(
        { lat: pickupLat, lng: pickupLng }, radius, riderId, favoritePriority,
      );
      if (candidates.length === 0) {
        console.log(`[DISPATCH] No candidates stage ${stage} (${radius}km) ride=${rideId}`);
        continue;
      }

      const slice = candidateOffset > 0 ? candidates.slice(candidateOffset) : candidates;
      for (const driver of slice) {
        attemptCount++;
        const trip = await RideRepository.findById(rideId);
        if (!trip || trip.status !== TripStatus.REQUESTED) {
          console.log(`[DISPATCH] Ride ${rideId} no longer REQUESTED (${trip?.status})`);
          if (trip?.status === TripStatus.CANCELLED) return 'cancelled';
          if (trip?.status === TripStatus.ACCEPTED) return 'assigned';
          return 'failed';
        }

        await DispatchEngine.saveMatchingState(rideId, {
          stage, candidateIndex: candidates.indexOf(driver), attemptCount,
        });

        const result = await DispatchEngine._offerToDriver(io, rideId, driver, trip);
        if (result === 'accepted') {
          console.log(`[DISPATCH] Ride ${rideId} assigned to driver ${driver.id} after ${attemptCount} attempts`);
          await DispatchEngine.clearMatchingState(rideId);
          dispatchAcceptOutcomeTotal.inc({ outcome: 'accepted' });
          return 'assigned';
        }
        if (result === 'ride_cancelled') {
          await DispatchEngine.clearMatchingState(rideId);
          return 'cancelled';
        }
        dispatchAcceptOutcomeTotal.inc({ outcome: result === 'declined' ? 'declined' : 'timeout' });
      }
      if (candidateOffset > 0 && stage === initialStage) continue;
    }

  console.log(`[DISPATCH] No eligible driver for ride ${rideId} after ${attemptCount} attempts`);
    await DispatchEngine.clearMatchingState(rideId);
    return 'failed';
  }

  private static async _offerToDriver(
    io: Server, rideId: string, driver: ScoredDriver, trip: any,
  ): Promise<'accepted' | 'declined' | 'timeout' | 'ride_cancelled'> {
    const driverId = driver.id;
    const eligibility = await DriverEligibilityService.checkEligibility(driverId);
    if (!eligibility.eligible) {
      console.log(`[DISPATCH] Driver ${driverId} not eligible: ${eligibility.reason}`);
      return 'declined';
    }

    const offer = await DriverOfferService.createOffer(rideId, driverId);
    if (!offer) {
      console.log(`[DISPATCH] Driver ${driverId} already has active offer`);
      return 'declined';
    }

    let driverLoc = null;
    let driverToPickupRoute = null;
    try {
      driverLoc = await LocationsService.getDriverLocation(driverId);
      if (driverLoc) {
        driverToPickupRoute = await GeospatialService.getRoute(
          [driverLoc.lat, driverLoc.lng], [trip.pickup.lat, trip.pickup.lng],
        ).catch(() => null);
      }
    } catch { /* skip */ }

    let tripRoute = null;
    try {
      tripRoute = await GeospatialService.getRoute(
        [trip.pickup.lat, trip.pickup.lng], [trip.destination.lat, trip.destination.lng],
      ).catch(() => null);
    } catch { /* skip */ }

    const distanceKm = tripRoute ? (tripRoute.distance / 1000) : (trip.distance_km || 10.0);
    const calculatedPrice = await resolveRideFare(rideId, {
      distanceMeters: tripRoute ? tripRoute.distance : (trip.distance_km || 10.0) * 1000,
      durationSeconds: tripRoute ? tripRoute.eta : (trip.duration_minutes ? trip.duration_minutes * 60 : 600),
    });

    console.log(
      `[DISPATCH] Sending exclusive offer ${offer.offerId} to driver ${driverId}` +
      ` for ride ${rideId} (price=$${calculatedPrice}, dist=${distanceKm.toFixed(2)}km)`,
    );

    io.to(`driver:${driverId}`).emit('newTripRequest', {
      ...trip,
      offerId: offer.offerId,
      is_scheduled: (trip as any).is_scheduled,
      scheduled_at: (trip as any).scheduled_at,
      calculated_price: calculatedPrice,
      trip_distance_meters: tripRoute ? tripRoute.distance : distanceKm * 1000,
      trip_duration_seconds: tripRoute ? tripRoute.eta : (trip.duration_minutes ? trip.duration_minutes * 60 : 600),
      route_geometry: tripRoute ? tripRoute.geometry : null,
      driver_to_pickup_eta: driverToPickupRoute ? driverToPickupRoute.eta : null,
      driver_to_pickup_distance: driverToPickupRoute ? driverToPickupRoute.distance : null,
      expires_at: offer.expiresAt,
    });

    return DispatchEngine._waitForOfferResponse(rideId, driverId, offer.offerId);
  }

  private static async _waitForOfferResponse(
    rideId: string, driverId: string, offerId: string,
  ): Promise<'accepted' | 'declined' | 'timeout' | 'ride_cancelled'> {
    return new Promise((resolve) => {
      let settled = false;
      const timeoutMs = env.DRIVER_OFFER_TIMEOUT_MS;

      const poll = setInterval(async () => {
        if (settled) return;
        const offer = await DriverOfferService.getOffer(offerId);
        if (!offer) {
          settled = true;
          clearInterval(poll);
          resolve('ride_cancelled');
          return;
        }
        switch (offer.status) {
          case 'ACCEPTED':
            settled = true;
            clearInterval(poll);
            resolve('accepted');
            break;
          case 'DECLINED':
            settled = true;
            clearInterval(poll);
            resolve('declined');
            break;
          case 'CANCELLED':
            settled = true;
            clearInterval(poll);
            resolve('ride_cancelled');
            break;
        }
      }, 500);

      setTimeout(async () => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        await DriverOfferService.transitionOffer(offerId, OfferStatus.SENT, OfferStatus.EXPIRED);
        await DriverOfferService.releaseDriver(driverId);
        console.log(`[DISPATCH] Offer ${offerId} expired for driver ${driverId}`);
        resolve('timeout');
      }, timeoutMs);
    });
  }
}
