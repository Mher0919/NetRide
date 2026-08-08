import { Server } from 'socket.io';
import { redis } from '../../config/redis';
import { RideRepository } from '../../modules/ride/ride.repository';
import { LocationsService } from '../../modules/location/locations.service';
import { GeospatialService } from '../../modules/geospatial/geospatial.service';
import { env } from '../../config/env';
import { dispatchAcceptOutcomeTotal } from '../../observability/metrics';
import { ScoredDriver } from '../../services/dispatch.service';
import { TripStatus } from '../../types';
import { resolveRideFare } from '../../services/pricing.service';
import { matchQueue } from '../queue';

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

    console.log(`[DISPATCH] 📤 Processing dispatch job ${job.id} for trip ${tripId} → ${drivers.length} driver(s)`);

    const trip = await RideRepository.findById(tripId);
    if (!trip || trip.status !== 'REQUESTED') {
      console.log(`[DISPATCH] ⏭️ Skipping trip ${tripId} — status=${trip?.status}`);
      return;
    }

    const offeredDrivers: string[] = [];

    for (const driver of drivers) {
      const driverId = driver.id;
      let driverLoc = null;
      let driverToPickupRoute = null;

      try {
        driverLoc = await LocationsService.getDriverLocation(driverId);
        if (driverLoc) {
          driverToPickupRoute = await GeospatialService.getRoute(
            [driverLoc.lat, driverLoc.lng],
            [trip.pickup.lat, trip.pickup.lng]
          ).catch(() => null);
        }
      } catch { /* skip */ }

      let tripRoute = null;
      try {
        tripRoute = await GeospatialService.getRoute(
          [trip.pickup.lat, trip.pickup.lng],
          [trip.destination.lat, trip.destination.lng]
        ).catch(() => null);
      } catch { /* skip */ }

      const distanceKm = tripRoute ? (tripRoute.distance / 1000) : (trip.distance_km || 10.0);
      // Platform price — identical for every driver, from the ride's price snapshot.
      const calculatedPrice = await resolveRideFare(tripId, {
        distanceMeters: tripRoute ? tripRoute.distance : (trip.distance_km || 10.0) * 1000,
        durationSeconds: tripRoute ? tripRoute.eta : (trip.duration_minutes ? trip.duration_minutes * 60 : 600),
      });

      io.to(`driver:${driverId}`).emit('newTripRequest', {
        ...trip,
        is_scheduled: (trip as any).is_scheduled,
        scheduled_at: (trip as any).scheduled_at,
        calculated_price: calculatedPrice,
        trip_distance_meters: tripRoute ? tripRoute.distance : distanceKm * 1000,
        trip_duration_seconds: tripRoute ? tripRoute.eta : (trip.duration_minutes ? trip.duration_minutes * 60 : 600),
        route_geometry: tripRoute ? tripRoute.geometry : null,
        driver_to_pickup_eta: driverToPickupRoute ? driverToPickupRoute.eta : null,
        driver_to_pickup_distance: driverToPickupRoute ? driverToPickupRoute.distance : null,
        expires_at: new Date(Date.now() + env.DRIVER_ACCEPT_TIMEOUT_MS).toISOString(),
      });

      console.log(`[DISPATCH] ✅ Sent newTripRequest to driver:${driverId} for trip ${tripId} (price=$${calculatedPrice})`);
      offeredDrivers.push(driverId);
    }

    if (offeredDrivers.length > 0) {
      await redis.setex(
        `dispatch:lock:${tripId}`,
        Math.ceil(env.DRIVER_ACCEPT_TIMEOUT_MS / 1000),
        JSON.stringify({ offeredDrivers, index: 0 })
      );

      setTimeout(async () => {
        const pending = await redis.get(`dispatch:lock:${tripId}`);
        if (pending) {
          await redis.del(`dispatch:lock:${tripId}`);
          const t = await RideRepository.findById(tripId);
          if (t && t.status === 'REQUESTED') {
            // Instead of cancelling immediately, re-enqueue a fresh match cycle
            // so the system keeps searching for a driver. The match job has its
            // own retry limit (MAX_MATCH_RETRIES) that will eventually cancel.
            // Preserve retry count by reading from match queue metadata.
            let nextRetryCount = 0;
            try {
              const matchMeta = await redis.get(`match:queue:dispatched:${tripId}`);
              if (matchMeta) {
                const parsed = JSON.parse(matchMeta);
                nextRetryCount = (parsed as any).retryCount ?? 0;
              }
            } catch { /* ignore */ }
            console.log(`[DISPATCH] ⏳ No driver accepted for trip ${tripId}, re-enqueueing match cycle (retry ${nextRetryCount + 1})`);
            offeredDrivers.forEach(did => {
              io.to(`driver:${did}`).emit('tripUpdate', {
                ...t,
                status: TripStatus.CANCELLED,
                cancelReason: 'Offer expired',
              });
            });
            await matchQueue.add('matchRide', {
              tripId,
              pickupLat: (t as any).pickup?.lat ?? 0,
              pickupLng: (t as any).pickup?.lng ?? 0,
              riderId: t.rider_id,
              retryCount: nextRetryCount + 1,
            });
            dispatchAcceptOutcomeTotal.inc({ outcome: 'timeout_retry' });
          }
        }
      }, env.DRIVER_ACCEPT_TIMEOUT_MS);
    }
  };
}
