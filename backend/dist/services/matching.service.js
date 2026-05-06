"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.matchingService = void 0;
const redis_1 = require("../config/redis");
const env_1 = require("../config/env");
const ride_repository_1 = require("../modules/ride/ride.repository");
const types_1 = require("../types");
const locations_service_1 = require("../modules/location/locations.service");
exports.matchingService = {
    async findAndDispatch(io, tripId, pickupLat, pickupLng) {
        const drivers = await locations_service_1.LocationsService.findNearbyDrivers({ lat: pickupLat, lng: pickupLng }, env_1.env.DRIVER_MATCH_RADIUS_KM);
        if (drivers.length === 0) {
            await ride_repository_1.RideRepository.updateStatus(tripId, types_1.TripStatus.CANCELLED);
            // Notify rider
            const trip = await ride_repository_1.RideRepository.findById(tripId);
            if (trip) {
                io.to(`rider:${trip.rider_id}`).emit('tripUpdate', {
                    ...trip,
                    status: types_1.TripStatus.CANCELLED,
                    cancelReason: 'No drivers available',
                });
            }
            return;
        }
        await this.dispatchToNextDriver(io, tripId, drivers, 0);
    },
    async dispatchToNextDriver(io, tripId, drivers, index) {
        if (index >= drivers.length) {
            await ride_repository_1.RideRepository.updateStatus(tripId, types_1.TripStatus.CANCELLED);
            const trip = await ride_repository_1.RideRepository.findById(tripId);
            if (trip) {
                io.to(`rider:${trip.rider_id}`).emit('tripUpdate', {
                    ...trip,
                    status: types_1.TripStatus.CANCELLED,
                    cancelReason: 'All nearby drivers declined',
                });
            }
            return;
        }
        const driverId = drivers[index].id;
        const trip = await ride_repository_1.RideRepository.findById(tripId);
        if (!trip)
            return;
        // Send ride request to this driver
        io.to(`driver:${driverId}`).emit('newTripRequest', trip);
        // Store pending dispatch in Redis with TTL
        await redis_1.redis.setex(`dispatch:${tripId}`, Math.ceil(env_1.env.DRIVER_ACCEPT_TIMEOUT_MS / 1000), JSON.stringify({ driverId, index, drivers }));
        // Timeout: move to next driver if no response
        setTimeout(async () => {
            const pending = await redis_1.redis.get(`dispatch:${tripId}`);
            if (pending) {
                const parsed = JSON.parse(pending);
                if (parsed.index === index) {
                    await redis_1.redis.del(`dispatch:${tripId}`);
                    await this.dispatchToNextDriver(io, tripId, drivers, index + 1);
                }
            }
        }, env_1.env.DRIVER_ACCEPT_TIMEOUT_MS);
    },
    async handleDriverResponse(io, driverId, tripId, accepted) {
        const pendingRaw = await redis_1.redis.get(`dispatch:${tripId}`);
        if (!pendingRaw)
            return;
        const pending = JSON.parse(pendingRaw);
        if (pending.driverId !== driverId)
            return;
        await redis_1.redis.del(`dispatch:${tripId}`);
        if (!accepted) {
            await this.dispatchToNextDriver(io, tripId, pending.drivers, pending.index + 1);
            return;
        }
        // Accepted — update trip
        const updatedTrip = await ride_repository_1.RideRepository.updateStatus(tripId, types_1.TripStatus.ACCEPTED, {
            driver_id: driverId,
            accepted_at: new Date()
        });
        // Notify rider and driver
        io.to(`rider:${updatedTrip.rider_id}`).emit('tripUpdate', updatedTrip);
        io.to(`driver:${driverId}`).emit('tripUpdate', updatedTrip);
    },
};
//# sourceMappingURL=matching.service.js.map