import { Server } from 'socket.io';
import { redis } from '../../config/redis';
import { RideRepository } from '../../modules/ride/ride.repository';
import { LocationsService } from '../../modules/location/locations.service';
import { GeospatialService } from '../../modules/geospatial/geospatial.service';
import { env } from '../../config/env';
import { dispatchAcceptOutcomeTotal } from '../../observability/metrics';
import { ScoredDriver } from '../../services/dispatch.service';
import { TripStatus } from '../../types';
import { DriverOfferService } from '../../services/driver-offer.service';
import { RideRejectionService } from '../../services/ride-rejection.service';

interface DispatchOfferJobData {
  tripId: string;
  drivers: ScoredDriver[];
  pickupLat: number;
  pickupLng: number;
}

export async function handleDispatchOffer(io: Server) {
  return async (job: any) => {
    const data: DispatchOfferJobData = job.data;
    const { tripId, drivers } = data;

    console.log(`[DISPATCH] Processing dispatch job ${job.id} for trip ${tripId} (${drivers.length} drivers)`);

    const trip = await RideRepository.findById(tripId);
    if (!trip || trip.status !== 'REQUESTED') {
      console.log(`[DISPATCH] Skipping trip ${tripId} — status=${trip?.status}`);
      return;
    }

    // Apply the same authoritative driver-rejection exclusion as the main
    // dispatch engine: drivers who already declined this ride must never
    // be re-offered it, even on this legacy fan-out path.
    const rejected = await RideRejectionService.rejectedDriverIds(tripId);
    const offerTargets = RideRejectionService.excludeRejected(drivers, rejected);
    if (offerTargets.length !== drivers.length) {
      console.log(
        `[DISPATCH] Excluded ${drivers.length - offerTargets.length} driver(s) for trip ${tripId} ` +
        `(previously rejected this ride)`,
      );
    }

    for (const driver of offerTargets) {
      const driverId = driver.id;

      const offer = await DriverOfferService.createOffer(tripId, driverId);
      if (!offer) {
        console.log(`[DISPATCH] Driver ${driverId} already has active offer — skipping`);
        continue;
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

      io.to(`driver:${driverId}`).emit('newTripRequest', {
        ...trip,
        offerId: offer.offerId,
        is_scheduled: (trip as any).is_scheduled,
        scheduled_at: (trip as any).scheduled_at,
        trip_distance_meters: tripRoute ? tripRoute.distance : distanceKm * 1000,
        trip_duration_seconds: tripRoute ? tripRoute.eta : (trip.duration_minutes ? trip.duration_minutes * 60 : 600),
        route_geometry: tripRoute ? tripRoute.geometry : null,
        driver_to_pickup_eta: driverToPickupRoute ? driverToPickupRoute.eta : null,
        driver_to_pickup_distance: driverToPickupRoute ? driverToPickupRoute.distance : null,
        expires_at: offer.expiresAt,
      });

      console.log(`[DISPATCH] Sent offer ${offer.offerId} to driver ${driverId} for trip ${tripId}`);
    }

    if (offerTargets.length > 0) {
      setTimeout(async () => {
        const t = await RideRepository.findById(tripId);
        if (t && t.status === 'REQUESTED') {
          const offers = offerTargets.map(d => DriverOfferService.getOfferForRide(tripId));
          const activeOffer = (await Promise.all(offers)).find(o => o !== null);
          if (!activeOffer) {
            console.log(`[DISPATCH] No driver accepted trip ${tripId}, re-enqueueing`);
            const { matchQueue } = await import('../../queue/queue');
            await matchQueue.add('matchRide', {
              tripId,
              pickupLat: (t as any).pickup?.lat ?? 0,
              pickupLng: (t as any).pickup?.lng ?? 0,
              riderId: t.rider_id,
              retryCount: 1,
            });
            dispatchAcceptOutcomeTotal.inc({ outcome: 'timeout_retry' });
          }
        }
      }, env.DRIVER_OFFER_TIMEOUT_MS);
    }
  };
}
