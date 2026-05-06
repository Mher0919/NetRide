"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.locationRepository = void 0;
// backend/src/modules/location/location.repository.ts
const redis_1 = require("../../config/redis");
exports.locationRepository = {
    /**
     * Updates the driver's current location in Redis using GEOADD.
     */
    async updateDriverLocation(driverId, location) {
        await redis_1.redis.geoadd(redis_1.DRIVER_LOCATIONS_KEY, location.lng, location.lat, driverId);
    },
    /**
     * Retrieves the driver's current location from Redis.
     */
    async getDriverLocation(driverId) {
        const pos = await redis_1.redis.geopos(redis_1.DRIVER_LOCATIONS_KEY, driverId);
        if (!pos || !pos[0])
            return null;
        return {
            lng: parseFloat(pos[0][0]),
            lat: parseFloat(pos[0][1]),
        };
    },
    /**
     * Removes the driver's location from Redis (e.g., when they go offline).
     */
    async removeDriverLocation(driverId) {
        await redis_1.redis.zrem(redis_1.DRIVER_LOCATIONS_KEY, driverId);
    },
    /**
     * Finds nearby drivers within a certain radius.
     */
    async findNearbyDrivers(location, radiusKm) {
        const results = await redis_1.redis.georadius(redis_1.DRIVER_LOCATIONS_KEY, location.lng, location.lat, radiusKm, 'km');
        return results;
    }
};
//# sourceMappingURL=location.repository.js.map