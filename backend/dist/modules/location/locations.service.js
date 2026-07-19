"use strict";
// backend/src/modules/location/locations.service.ts
//
// Owns the live driver location tracking + per-trip trajectory buffer
// in Redis. Exposes an in-process EventEmitter (`trajectoryEvents`)
// so downstream consumers (the speeding detector, future safety
// modules) can subscribe to the *same* trajectory stream without
// duplicating the Redis read or branching the hot path.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.LocationsService = exports.trajectoryEvents = void 0;
const events_1 = require("events");
const redis_1 = require("../../config/redis");
const geohash = __importStar(require("ngeohash"));
exports.trajectoryEvents = new events_1.EventEmitter();
// Safety detectors can run on long trips; raise the cap so we never
// hit the "MaxListenersExceeded" warning when more than 10 listeners
// attach (current consumers: SpeedingDetector + future ML pipeline).
exports.trajectoryEvents.setMaxListeners(64);
class LocationsService {
    /**
     * Updates a driver's real-time location in Redis
     * Also sets a heartbeat to track online status and returns the geohash for room management.
     */
    static async updateDriverLocation(driverId, loc) {
        const pipeline = redis_1.redis.pipeline();
        // 1. Update Geospatial position
        pipeline.geoadd(redis_1.DRIVER_LOCATIONS_KEY, loc.lng, loc.lat, driverId);
        // 2. Set heartbeat with TTL (15 seconds) - if this expires, driver is "ghost"
        pipeline.set(`${redis_1.DRIVER_HEARTBEAT_PREFIX}${driverId}`, '1', 'EX', 15);
        await pipeline.exec();
        // 3. Trajectory Buffering - ONLY if driver is on a trip
        // We use a separate async task to not block the main location update
        this.bufferTrajectory(driverId, loc).catch(err => {
            console.error(`[GEO] ❌ Trajectory buffering failed for driver ${driverId}:`, err.message);
        });
        // 4. Return geohash precision 6 (~1.2km x 0.6km) for socket room management
        return geohash.encode(loc.lat, loc.lng, 6);
    }
    /**
     * Internal helper to buffer trajectory points in Redis.
     *
     * Side effect: emits `point` on `trajectoryEvents` after the
     * throttle/buffer work so the speeding detector (and any future
     * safety module) can subscribe without re-reading the buffer.
     */
    static async bufferTrajectory(driverId, loc) {
        // Check if driver has an active trip (Cached in Redis ideally, but let's use a key for now)
        const tripId = await redis_1.redis.get(`driver:${driverId}:active_trip`);
        if (!tripId)
            return;
        const trajectoryKey = `trip:${tripId}:trajectory`;
        // Throttling: only save if last point was > 5 seconds ago or > 20 meters away
        // For simplicity, let's just do a 5-second throttle using a Redis key
        const throttleKey = `driver:${driverId}:trajectory_throttle`;
        const isThrottled = await redis_1.redis.get(throttleKey);
        const timestamp = new Date().toISOString();
        const payload = {
            lat: loc.lat,
            lng: loc.lng,
            speed_mps: typeof loc.speed === 'number' ? loc.speed : null,
            t: timestamp,
        };
        if (!isThrottled) {
            const point = JSON.stringify(payload);
            await redis_1.redis.pipeline()
                .rpush(trajectoryKey, point)
                .expire(trajectoryKey, 86400) // 24h safety TTL
                .set(throttleKey, '1', 'EX', 5) // 5 seconds throttle
                .exec();
            // Fire-and-forget; the detector swallows its own errors.
            exports.trajectoryEvents.emit('point', {
                driverId,
                tripId,
                point: payload,
            });
        }
    }
    static async getTrajectory(tripId) {
        const points = await redis_1.redis.lrange(`trip:${tripId}:trajectory`, 0, -1);
        return points.map(p => JSON.parse(p));
    }
    static async clearTrajectory(tripId) {
        await redis_1.redis.del(`trip:${tripId}:trajectory`);
    }
    /**
     * Finds nearby online drivers within a radius
     * Filters out drivers whose heartbeats have expired using pipelined MGET.
     */
    static async findNearbyDrivers(loc, radiusKm) {
        console.log(`[GEO] Searching nearby drivers. Pickup: lat=${loc.lat}, lng=${loc.lng}, radius=${radiusKm}km`);
        const searchRadius = Math.max(radiusKm, 0.1);
        try {
            const results = await redis_1.redis.georadius(redis_1.DRIVER_LOCATIONS_KEY, loc.lng, loc.lat, searchRadius, 'km', 'WITHDIST', 'ASC');
            if (!results || results.length === 0)
                return [];
            const ids = results.map(([id]) => id);
            const heartbeatKeys = ids.map((id) => `${redis_1.DRIVER_HEARTBEAT_PREFIX}${id}`);
            const heartbeats = await redis_1.redis.mget(...heartbeatKeys);
            const nearbyDrivers = [];
            const staleIds = [];
            results.forEach(([id, distance], i) => {
                if (heartbeats[i]) {
                    nearbyDrivers.push({ id, distance: parseFloat(distance) });
                }
                else {
                    staleIds.push(id);
                }
            });
            if (staleIds.length > 0) {
                await redis_1.redis.pipeline()
                    .zrem(redis_1.DRIVER_LOCATIONS_KEY, ...staleIds)
                    .del(...staleIds.map((id) => `${redis_1.DRIVER_HEARTBEAT_PREFIX}${id}`))
                    .exec();
            }
            return nearbyDrivers;
        }
        catch (error) {
            console.error(`[GEO] Error in georadius:`, error);
            return [];
        }
    }
    /**
     * Removes a driver from online tracking
     */
    static async removeDriverLocation(driverId) {
        await redis_1.redis.pipeline()
            .zrem(redis_1.DRIVER_LOCATIONS_KEY, driverId)
            .del(`${redis_1.DRIVER_HEARTBEAT_PREFIX}${driverId}`)
            .exec();
    }
    static async getDriverLocation(driverId) {
        const pos = await redis_1.redis.geopos(redis_1.DRIVER_LOCATIONS_KEY, driverId);
        if (pos && pos[0]) {
            return {
                lng: parseFloat(pos[0][0]),
                lat: parseFloat(pos[0][1]),
            };
        }
        return null;
    }
}
exports.LocationsService = LocationsService;
//# sourceMappingURL=locations.service.js.map