"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.matchingService = void 0;
const redis_1 = require("../config/redis");
const env_1 = require("../config/env");
const ride_repository_1 = require("../modules/ride/ride.repository");
const types_1 = require("../types");
const locations_service_1 = require("../modules/location/locations.service");
const dispatch_service_1 = require("./dispatch.service");
const geospatial_service_1 = require("../modules/geospatial/geospatial.service");
const database_1 = require("../config/database");
exports.matchingService = {
    async findAndDispatch(io, tripId, pickupLat, pickupLng, requestedClass, riderId) {
        const drivers = await dispatch_service_1.DispatchService.getWeightedDrivers({ lat: pickupLat, lng: pickupLng }, requestedClass, env_1.env.DRIVER_MATCH_RADIUS_KM || 10, riderId);
        if (drivers.length === 0) {
            const trip = await ride_repository_1.RideRepository.findById(tripId);
            if (trip && !trip.is_scheduled) {
                await ride_repository_1.RideRepository.updateStatus(tripId, types_1.TripStatus.CANCELLED);
                io.to(`rider:${trip.rider_id}`).emit('tripUpdate', {
                    ...trip,
                    status: types_1.TripStatus.CANCELLED,
                    cancelReason: 'No drivers available in this class',
                });
            }
            return;
        }
        await this.dispatchToNextDriver(io, tripId, drivers, 0);
    },
    async dispatchToNextDriver(io, tripId, drivers, index) {
        if (index >= drivers.length) {
            const trip = await ride_repository_1.RideRepository.findById(tripId);
            if (trip && !trip.is_scheduled) {
                await ride_repository_1.RideRepository.updateStatus(tripId, types_1.TripStatus.CANCELLED);
                io.to(`rider:${trip.rider_id}`).emit('tripUpdate', {
                    ...trip,
                    status: types_1.TripStatus.CANCELLED,
                    cancelReason: 'All nearby drivers declined or timed out',
                });
            }
            return;
        }
        const driverId = drivers[index].id;
        const trip = await ride_repository_1.RideRepository.findById(tripId);
        if (!trip)
            return;
        // 1. Fetch driver location & OSRM routes
        let driverLoc = null;
        let driverToPickupRoute = null;
        try {
            driverLoc = await locations_service_1.LocationsService.getDriverLocation(driverId);
            if (driverLoc) {
                driverToPickupRoute = await geospatial_service_1.GeospatialService.getRoute([driverLoc.lat, driverLoc.lng], [trip.pickup.lat, trip.pickup.lng]).catch(() => null);
            }
        }
        catch (e) {
            console.error(`[DISPATCH] Error getting driver-to-pickup route:`, e);
        }
        let tripRoute = null;
        try {
            tripRoute = await geospatial_service_1.GeospatialService.getRoute([trip.pickup.lat, trip.pickup.lng], [trip.destination.lat, trip.destination.lng]).catch(() => null);
        }
        catch (e) {
            console.error(`[DISPATCH] Error getting trip route:`, e);
        }
        // 2. Fetch driver pricing
        let driverPricePerMile = 2.00;
        try {
            const driverPricing = await database_1.pool.query('SELECT price_per_mile FROM drivers WHERE user_id = $1', [driverId]);
            if (driverPricing.rows.length > 0) {
                driverPricePerMile = parseFloat(driverPricing.rows[0].price_per_mile || '2.00');
            }
        }
        catch (e) {
            console.error(`[DISPATCH] Error getting driver pricing:`, e);
        }
        // 3. Calculate fare amount for this specific driver
        const distanceKm = tripRoute ? (tripRoute.distance / 1000) : (trip.distance_km || 10.0);
        const distanceMiles = distanceKm * 0.621371;
        const calculatedFare = Math.round(driverPricePerMile * distanceMiles * 100) / 100;
        const maxFare = parseFloat(trip.initial_max_fare || '999');
        const calculatedPrice = Math.min(maxFare, Math.max(5.00, calculatedFare));
        console.log(`[DISPATCH] Offering trip ${tripId} to driver ${driverId} (Score: ${drivers[index].score.toFixed(2)}) - Price: $${calculatedPrice}, Dist: ${distanceKm.toFixed(2)}km`);
        io.to(`driver:${driverId}`).emit('newTripRequest', {
            ...trip,
            is_scheduled: trip.is_scheduled,
            scheduled_at: trip.scheduled_at,
            calculated_price: calculatedPrice,
            trip_distance_meters: tripRoute ? tripRoute.distance : distanceKm * 1000,
            trip_duration_seconds: tripRoute ? tripRoute.eta : (trip.duration_minutes ? trip.duration_minutes * 60 : 600),
            route_geometry: tripRoute ? tripRoute.geometry : null,
            driver_to_pickup_eta: driverToPickupRoute ? driverToPickupRoute.eta : null,
            driver_to_pickup_distance: driverToPickupRoute ? driverToPickupRoute.distance : null,
            driver_price_per_mile: driverPricePerMile
        });
        await redis_1.redis.setex(`dispatch:${tripId}`, Math.ceil(env_1.env.DRIVER_ACCEPT_TIMEOUT_MS / 1000), JSON.stringify({ driverId, index, drivers }));
        setTimeout(async () => {
            const pending = await redis_1.redis.get(`dispatch:${tripId}`);
            if (pending) {
                const parsed = JSON.parse(pending);
                if (parsed.index === index) {
                    await redis_1.redis.del(`dispatch:${tripId}`);
                    console.log(`[DISPATCH] Driver ${driverId} timed out for trip ${tripId}. Moving to next.`);
                    await this.dispatchToNextDriver(io, tripId, drivers, index + 1);
                }
            }
        }, env_1.env.DRIVER_ACCEPT_TIMEOUT_MS);
    },
    /**
     * Driver explicitly declined an incoming request. Move immediately to the
     * next-best driver without waiting for the accept timeout to elapse.
     */
    async handleDecline(io, tripId, driverId) {
        const pending = await redis_1.redis.get(`dispatch:${tripId}`);
        if (!pending)
            return;
        const parsed = JSON.parse(pending);
        if (parsed.driverId !== driverId || parsed.index === undefined)
            return;
        // Clear dispatch key so the pending setTimeout becomes a no-op.
        await redis_1.redis.del(`dispatch:${tripId}`);
        console.log(`[DISPATCH] Driver ${driverId} declined trip ${tripId}. Moving to next.`);
        await this.dispatchToNextDriver(io, tripId, parsed.drivers, parsed.index + 1);
    },
};
//# sourceMappingURL=matching.service.js.map