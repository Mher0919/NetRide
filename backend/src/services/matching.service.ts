// backend/src/services/matching.service.ts
import { Server } from 'socket.io';
import { redis } from '../config/redis';
import { env } from '../config/env';
import { RideRepository } from '../modules/ride/ride.repository';
import { TripStatus } from '../types';
import { LocationsService } from '../modules/location/locations.service';

export const matchingService = {
  async findAndDispatch(io: Server, tripId: string, pickupLat: number, pickupLng: number) {
    const drivers = await LocationsService.findNearbyDrivers({ lat: pickupLat, lng: pickupLng }, env.DRIVER_MATCH_RADIUS_KM);

    if (drivers.length === 0) {
      await RideRepository.updateStatus(tripId, TripStatus.CANCELLED);
      // Notify rider
      const trip = await RideRepository.findById(tripId);
      if (trip) {
        io.to(`rider:${trip.rider_id}`).emit('tripUpdate', {
          ...trip,
          status: TripStatus.CANCELLED,
          cancelReason: 'No drivers available',
        });
      }
      return;
    }

    await this.dispatchToNextDriver(io, tripId, drivers, 0);
  },

  async dispatchToNextDriver(
    io: Server,
    tripId: string,
    drivers: { id: string; distance: number }[],
    index: number
  ) {
    if (index >= drivers.length) {
      await RideRepository.updateStatus(tripId, TripStatus.CANCELLED);
      const trip = await RideRepository.findById(tripId);
      if (trip) {
        io.to(`rider:${trip.rider_id}`).emit('tripUpdate', {
          ...trip,
          status: TripStatus.CANCELLED,
          cancelReason: 'All nearby drivers declined',
        });
      }
      return;
    }

    const driverId = drivers[index].id;
    const trip = await RideRepository.findById(tripId);
    if (!trip) return;

    // Send ride request to this driver
    io.to(`driver:${driverId}`).emit('newTripRequest', trip);

    // Store pending dispatch in Redis with TTL
    await redis.setex(
      `dispatch:${tripId}`,
      Math.ceil(env.DRIVER_ACCEPT_TIMEOUT_MS / 1000),
      JSON.stringify({ driverId, index, drivers })
    );

    // Timeout: move to next driver if no response
    setTimeout(async () => {
      const pending = await redis.get(`dispatch:${tripId}`);
      if (pending) {
        const parsed = JSON.parse(pending);
        if (parsed.index === index) {
            await redis.del(`dispatch:${tripId}`);
            await this.dispatchToNextDriver(io, tripId, drivers, index + 1);
        }
      }
    }, env.DRIVER_ACCEPT_TIMEOUT_MS);
  },

  async handleDriverResponse(
    io: Server,
    driverId: string,
    tripId: string,
    accepted: boolean
  ) {
    const pendingRaw = await redis.get(`dispatch:${tripId}`);
    if (!pendingRaw) return;

    const pending = JSON.parse(pendingRaw);
    if (pending.driverId !== driverId) return;

    await redis.del(`dispatch:${tripId}`);

    if (!accepted) {
      await this.dispatchToNextDriver(io, tripId, pending.drivers, pending.index + 1);
      return;
    }

    // Accepted — update trip
    const updatedTrip = await RideRepository.updateStatus(tripId, TripStatus.ACCEPTED, {
      driver_id: driverId,
      accepted_at: new Date()
    });

    // Notify rider and driver
    io.to(`rider:${updatedTrip.rider_id}`).emit('tripUpdate', updatedTrip);
    io.to(`driver:${driverId}`).emit('tripUpdate', updatedTrip);
  },
};