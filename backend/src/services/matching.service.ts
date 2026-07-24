// backend/src/services/matching.service.ts
import { Server } from 'socket.io';
import { redis } from '../config/redis';
import { env } from '../config/env';
import { RideRepository } from '../modules/ride/ride.repository';
import { TripStatus, VehicleClass } from '../types';
import { LocationsService } from '../modules/location/locations.service';
import { DispatchService, ScoredDriver } from './dispatch.service';
import { GeospatialService } from '../modules/geospatial/geospatial.service';
import { pool } from '../config/database';
import { dispatchAcceptOutcomeTotal } from '../observability/metrics';

/** @deprecated Use BullMQ queue (matchQueue.add) instead. Kept for LEGACY_SYNC_MATCHING fallback. */
export const matchingService = {
  async findAndDispatch(io: Server, tripId: string, pickupLat: number, pickupLng: number, requestedClass: VehicleClass, riderId?: string) {
    const drivers = await DispatchService.getWeightedDrivers(
      { lat: pickupLat, lng: pickupLng }, 
      requestedClass,
      env.DRIVER_MATCH_RADIUS_KM || 10,
      riderId
    );

    if (drivers.length === 0) {
      const trip = await RideRepository.findById(tripId);
      if (trip && !(trip as any).is_scheduled) {
        await RideRepository.updateStatus(tripId, TripStatus.CANCELLED);
        io.to(`rider:${trip.rider_id}`).emit('tripUpdate', {
          ...trip,
          status: TripStatus.CANCELLED,
          cancelReason: 'No drivers available in this class',
        });
      }
      return;
    }

    await this.dispatchToNextDriver(io, tripId, drivers, 0);
  },

  async dispatchToNextDriver(
    io: Server,
    tripId: string,
    drivers: ScoredDriver[],
    index: number
  ) {
    if (index >= drivers.length) {
      const trip = await RideRepository.findById(tripId);
      if (trip && !(trip as any).is_scheduled) {
        await RideRepository.updateStatus(tripId, TripStatus.CANCELLED);
        io.to(`rider:${trip.rider_id}`).emit('tripUpdate', {
          ...trip,
          status: TripStatus.CANCELLED,
          cancelReason: 'All nearby drivers declined or timed out',
        });
      }
      return;
    }

    const driverId = drivers[index].id;
    const trip = await RideRepository.findById(tripId);
    if (!trip) return;

    // 1. Fetch driver location & routes (via RoutingService / ORS)
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
    } catch (e) {
      console.error(`[DISPATCH] Error getting driver-to-pickup route:`, e);
    }

    let tripRoute = null;
    try {
      tripRoute = await GeospatialService.getRoute(
        [trip.pickup.lat, trip.pickup.lng],
        [trip.destination.lat, trip.destination.lng]
      ).catch(() => null);
    } catch (e) {
      console.error(`[DISPATCH] Error getting trip route:`, e);
    }

    // 2. Fetch driver pricing
    let driverPricePerMile = 2.00;
    try {
      const driverPricing = await pool.query('SELECT price_per_mile FROM drivers WHERE user_id = $1', [driverId]);
      if (driverPricing.rows.length > 0) {
        driverPricePerMile = parseFloat(driverPricing.rows[0].price_per_mile || '2.00');
      }
    } catch (e) {
      console.error(`[DISPATCH] Error getting driver pricing:`, e);
    }

    // 3. Calculate fare amount for this specific driver
    const distanceKm = tripRoute ? (tripRoute.distance / 1000) : (trip.distance_km || 10.0);
    const distanceMiles = distanceKm * 0.621371;
    const calculatedFare = Math.round(driverPricePerMile * distanceMiles * 100) / 100;
    const maxFare = parseFloat((trip as any).initial_max_fare || '999');
    const calculatedPrice = Math.min(maxFare, Math.max(5.00, calculatedFare));

    console.log(`[DISPATCH] Offering trip ${tripId} to driver ${driverId} (Score: ${drivers[index].score.toFixed(2)}) - Price: $${calculatedPrice}, Dist: ${distanceKm.toFixed(2)}km`);
    
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
      driver_price_per_mile: driverPricePerMile
    });

    await redis.setex(
      `dispatch:${tripId}`,
      Math.ceil(env.DRIVER_ACCEPT_TIMEOUT_MS / 1000),
      JSON.stringify({ driverId, index, drivers })
    );

    setTimeout(async () => {
      const pending = await redis.get(`dispatch:${tripId}`);
      if (pending) {
        const parsed = JSON.parse(pending);
        if (parsed.index === index) {
            await redis.del(`dispatch:${tripId}`);
            // Guard: only proceed if the trip is still REQUESTED (not already accepted)
            const currentTrip = await RideRepository.findById(tripId);
            if (!currentTrip || currentTrip.status !== TripStatus.REQUESTED) {
              console.log(`[DISPATCH] Driver ${driverId} timed out for trip ${tripId}, but ride is already ${currentTrip?.status}. Skipping.`);
              return;
            }
            console.log(`[DISPATCH] Driver ${driverId} timed out for trip ${tripId}. Moving to next.`);
            await this.dispatchToNextDriver(io, tripId, drivers, index + 1);
        }
      }
    }, env.DRIVER_ACCEPT_TIMEOUT_MS);
  },

  /**
   * Driver explicitly declined an incoming request in the parallel fan-out model.
   * Removes the driver from the dispatched set and updates metrics.
   */
  async handleDecline(io: Server, tripId: string, driverId: string) {
    dispatchAcceptOutcomeTotal.inc({ outcome: 'declined' });
    const dispatchedJson = await redis.get(`match:queue:dispatched:${tripId}`);
    if (dispatchedJson) {
      const dispatchedDrivers: string[] = JSON.parse(dispatchedJson);
      const filtered = dispatchedDrivers.filter(d => d !== driverId);
      if (filtered.length === 0) {
        await redis.del(`match:queue:dispatched:${tripId}`);
      } else {
        await redis.setex(`match:queue:dispatched:${tripId}`, 300, JSON.stringify(filtered));
      }
    }
    console.log(`[DISPATCH] Driver ${driverId} declined trip ${tripId}.`);
  },
};
