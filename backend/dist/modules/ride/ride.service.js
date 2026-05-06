"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RideService = void 0;
// backend/src/modules/ride/ride.service.ts
const ride_repository_1 = require("./ride.repository");
const locations_service_1 = require("../location/locations.service");
const geospatial_service_1 = require("../geospatial/geospatial.service");
const env_1 = require("../../config/env");
const app_1 = require("../../app");
const database_1 = require("../../config/database");
class RideService {
    static async rateRide(data) {
        const client = await database_1.pool.connect();
        try {
            await client.query('BEGIN');
            // 1. Check Ride
            const rideRes = await client.query('SELECT * FROM rides WHERE id = $1', [data.ride_id]);
            const ride = rideRes.rows[0];
            if (!ride)
                throw new Error('Ride not found');
            if (ride.status !== 'COMPLETED')
                throw new Error('Ride is not completed');
            if (ride.rider_id !== data.rider_id)
                throw new Error('Unauthorized');
            if (!ride.driver_id)
                throw new Error('No driver assigned to this ride');
            // 2. Create Rating
            const ratingRes = await client.query(`INSERT INTO ratings (ride_id, rider_id, driver_id, rating, review_text)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`, [data.ride_id, data.rider_id, ride.driver_id, data.rating, data.review_text]);
            // 3. Update Driver Rating
            const driverRes = await client.query('SELECT * FROM drivers WHERE user_id = $1', [ride.driver_id]);
            const driver = driverRes.rows[0];
            if (driver) {
                const newTotalRides = parseInt(driver.total_rides) + 1;
                const newRating = ((parseFloat(driver.rating) * driver.total_rides) + data.rating) / newTotalRides;
                await client.query(`UPDATE drivers SET total_rides = $1, rating = $2 WHERE user_id = $3`, [newTotalRides, parseFloat(newRating.toFixed(1)), ride.driver_id]);
            }
            await client.query('COMMIT');
            return ratingRes.rows[0];
        }
        catch (e) {
            await client.query('ROLLBACK');
            throw e;
        }
        finally {
            client.release();
        }
    }
    static async requestRide(riderId, pickup, destination) {
        console.log(`[RIDE] New request from rider ${riderId}. Pickup: ${pickup.lat}, ${pickup.lng}`);
        const trip = await ride_repository_1.RideRepository.create({
            rider_id: riderId,
            pickup_lat: pickup.lat,
            pickup_lng: pickup.lng,
            pickup_address: pickup.address,
            destination_lat: destination.lat,
            destination_lng: destination.lng,
            destination_address: destination.address,
        });
        // ... rest of method remains same as before Prisma refactor
        const route = await geospatial_service_1.GeospatialService.getRoute([pickup.lat, pickup.lng], [destination.lat, destination.lng]).catch(() => null);
        if (route) {
            trip.route_geometry = route.geometry;
            trip.distance_meters = route.distance;
            trip.eta_seconds = route.eta;
        }
        let nearbyDrivers = await locations_service_1.LocationsService.findNearbyDrivers(pickup, env_1.env.DRIVER_MATCH_RADIUS_KM || 50);
        nearbyDrivers.forEach(d => {
            app_1.io.to(`driver:${d.id}`).emit('newTripRequest', trip);
        });
        return trip;
    }
    static async acceptTrip(tripId, driverId) {
        const trip = await ride_repository_1.RideRepository.findById(tripId);
        if (!trip)
            throw new Error('Trip not found');
        if (trip.status !== 'REQUESTED')
            throw new Error('Trip already taken or cancelled');
        const updatedTrip = await ride_repository_1.RideRepository.updateStatus(tripId, 'ACCEPTED', {
            driver_id: driverId,
            accepted_at: new Date()
        });
        const driverLoc = await locations_service_1.LocationsService.getDriverLocation(driverId);
        updatedTrip.driver_location = driverLoc;
        app_1.io.to(`rider:${trip.rider_id}`).emit('tripUpdate', updatedTrip);
        app_1.io.to(`driver:${driverId}`).emit('tripUpdate', updatedTrip);
        return updatedTrip;
    }
    static async updateTripStatus(tripId, status) {
        const extra = {};
        if (status === 'IN_PROGRESS')
            extra.started_at = new Date();
        if (status === 'COMPLETED')
            extra.completed_at = new Date();
        const updatedTrip = await ride_repository_1.RideRepository.updateStatus(tripId, status, extra);
        if (updatedTrip.driver_id) {
            const driverLoc = await locations_service_1.LocationsService.getDriverLocation(updatedTrip.driver_id);
            updatedTrip.driver_location = driverLoc;
        }
        app_1.io.to(`rider:${updatedTrip.rider_id}`).emit('tripUpdate', updatedTrip);
        if (updatedTrip.driver_id) {
            app_1.io.to(`driver:${updatedTrip.driver_id}`).emit('tripUpdate', updatedTrip);
        }
        return updatedTrip;
    }
    static async cancelTrip(tripId) {
        const trip = await ride_repository_1.RideRepository.findById(tripId);
        if (!trip)
            throw new Error('Trip not found');
        const updatedTrip = await ride_repository_1.RideRepository.updateStatus(tripId, 'CANCELLED');
        app_1.io.to(`rider:${trip.rider_id}`).emit('tripUpdate', updatedTrip);
        if (trip.driver_id) {
            app_1.io.to(`driver:${trip.driver_id}`).emit('tripUpdate', updatedTrip);
        }
        return updatedTrip;
    }
    static async getHistory(userId, role) {
        if (role === 'driver') {
            return ride_repository_1.RideRepository.findByDriverId(userId);
        }
        return ride_repository_1.RideRepository.findByRiderId(userId);
    }
    static async getCurrentRide(userId, role) {
        if (role === 'driver') {
            return ride_repository_1.RideRepository.findCurrentByDriverId(userId);
        }
        return ride_repository_1.RideRepository.findCurrentByRiderId(userId);
    }
    static async deleteHistory(rideId, userId) {
        return ride_repository_1.RideRepository.delete(rideId, userId);
    }
}
exports.RideService = RideService;
//# sourceMappingURL=ride.service.js.map