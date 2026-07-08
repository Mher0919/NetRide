import { Server } from 'socket.io';
import { redis } from '../../config/redis';
import { RideRepository } from '../../modules/ride/ride.repository';
import { LocationsService } from '../../modules/location/locations.service';
import { GeospatialService } from '../../modules/geospatial/geospatial.service';
import { pool } from '../../config/database';
import { env } from '../../config/env';
import { dispatchAcceptOutcomeTotal } from '../../observability/metrics';
import { ScoredDriver } from '../../services/dispatch.service';
import { TripStatus } from '../../types';

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

    const trip = await RideRepository.findById(tripId);
    if (!trip || trip.status !== 'REQUESTED') return;

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

      let driverPricePerMile = 2.00;
      try {
        const driverPricing = await pool.query('SELECT price_per_mile FROM drivers WHERE user_id = $1', [driverId]);
        if (driverPricing.rows.length > 0) {
          driverPricePerMile = parseFloat(driverPricing.rows[0].price_per_mile || '2.00');
        }
      } catch { /* skip */ }

      const distanceKm = tripRoute ? (tripRoute.distance / 1000) : (trip.distance_km || 10.0);
      const distanceMiles = distanceKm * 0.621371;
      const calculatedFare = Math.round(driverPricePerMile * distanceMiles * 100) / 100;
      const maxFare = parseFloat((trip as any).initial_max_fare || '999');
      const calculatedPrice = Math.min(maxFare, Math.max(5.00, calculatedFare));

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
        driver_price_per_mile: driverPricePerMile,
      });

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
            await RideRepository.updateStatus(tripId, TripStatus.CANCELLED);
            io.to(`rider:${t.rider_id}`).emit('tripUpdate', {
              ...t,
              status: TripStatus.CANCELLED,
              cancelReason: 'No driver accepted in time',
            });
            offeredDrivers.forEach(did => {
              io.to(`driver:${did}`).emit('tripUpdate', {
                ...t,
                status: TripStatus.CANCELLED,
                cancelReason: 'Another driver accepted',
              });
            });
            dispatchAcceptOutcomeTotal.inc({ outcome: 'timeout' });
          }
        }
      }, env.DRIVER_ACCEPT_TIMEOUT_MS);
    }
  };
}
