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
const h3_js_1 = require("h3-js");
const redis_1 = require("../../config/redis");
const geohash = __importStar(require("ngeohash"));
exports.trajectoryEvents = new events_1.EventEmitter();
// Safety detectors can run on long trips; raise the cap so we never
// hit the "MaxListenersExceeded" warning when more than 10 listeners
// attach (current consumers: SpeedingDetector + future ML pipeline).
exports.trajectoryEvents.setMaxListeners(64);
// H3 resolution for the driver-cell index. Res 6 hexagons have an average
// edge length of ~3.2 km — a good balance between index size and the number
// of cells we must touch for the 10/15/20 km dispatch rings.
const H3_MATCHING_RESOLUTION = 6;
// Average H3 hexagon edge length in km at res 6 (≈3.2 km). Used to convert a
// search radius into a gridDisk ring count.
const H3_EDGE_KM = 3.2;
/**
 * Atomically moves a driver between H3 cell sets. Reads the driver's current
 * cell, removes them from that cell's set if it changed, adds them to the new
 * cell's set, and stores the new cell mapping — all in one Lua script so two
 * concurrent location updates can never leak a stale membership.
 */
const MOVE_DRIVER_CELL_LUA = `
  local cellKey = KEYS[1]
  local cellPrefix = KEYS[2]
  local driverId = ARGV[1]
  local cell = ARGV[2]
  local prevCell = redis.call('GET', cellKey)
  if prevCell and prevCell ~= cell then
    redis.call('SREM', cellPrefix .. prevCell, driverId)
  end
  redis.call('SADD', cellPrefix .. cell, driverId)
  redis.call('SET', cellKey, cell)
  return 1
`;
/**
 * Converts a search radius (km) into a gridDisk ring count so the ring fully
 * covers the radius (plus a safety margin of one extra ring).
 */
function radiusToGridDiskRings(radiusKm) {
    // Center-to-center distance between adjacent res-6 hexagons ≈ edge * sqrt(3).
    const stepKm = H3_EDGE_KM * Math.sqrt(3);
    return Math.max(1, Math.ceil(radiusKm / stepKm) + 1);
}
/** Great-circle distance in km between two coordinates. */
function haversineKm(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos((lat1 * Math.PI) / 180) *
            Math.cos((lat2 * Math.PI) / 180) *
            Math.sin(dLng / 2) *
            Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(a));
}
class LocationsService {
    /**
     * Updates a driver's real-time location in Redis
     * Also sets a heartbeat to track online status and returns the geohash for room management.
     */
    static async updateDriverLocation(driverId, loc) {
        const pipeline = redis_1.redis.pipeline();
        // 1. Update Geospatial position
        pipeline.geoadd(redis_1.DRIVER_LOCATIONS_KEY, loc.lng, loc.lat, driverId);
        // 2. Set heartbeat with TTL (90 seconds). This is long enough to
        // survive brief socket disconnects (free-tier spin-down, network
        // blip) without making truly offline drivers invisible to matching.
        pipeline.set(`${redis_1.DRIVER_HEARTBEAT_PREFIX}${driverId}`, '1', 'EX', 90);
        // 3. Maintain the H3 hexagonal cell index. Each online driver lives in
        // the set of their current cell; matching only queries the small ring of
        // cells around the pickup instead of scanning the global GEO set. The
        // move between cell sets is atomic (Lua) so concurrent updates never leak
        // stale memberships.
        const cell = (0, h3_js_1.latLngToCell)(loc.lat, loc.lng, H3_MATCHING_RESOLUTION);
        pipeline.eval(MOVE_DRIVER_CELL_LUA, 2, `${redis_1.DRIVER_H3_CELL_PREFIX}${driverId}`, redis_1.DRIVER_H3_INDEX_PREFIX, driverId, cell);
        await pipeline.exec();
        // 4. Trajectory Buffering - ONLY if driver is on a trip
        // We use a separate async task to not block the main location update
        this.bufferTrajectory(driverId, loc).catch(err => {
            console.error(`[GEO] ❌ Trajectory buffering failed for driver ${driverId}:`, err.message);
        });
        // 5. Return geohash precision 6 (~1.2km x 0.6km) for socket room management
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
        // Route-data validation: reject garbage coordinates before they ever
        // reach the trajectory (a bad point would corrupt the polyline, the
        // final snapshot and the admin map). NaN/Infinity or out-of-range
        // lat/lng points are dropped silently.
        const valid = isFinite(loc.lat) && isFinite(loc.lng) &&
            loc.lat >= -90 && loc.lat <= 90 &&
            loc.lng >= -180 && loc.lng <= 180;
        if (!valid)
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
     * Finds nearby online drivers within a radius using the H3 hexagonal index.
     *
     * Instead of scanning the global GEO set (O(all online drivers) in the worst
     * case), it computes the rider's H3 cell, expands to a small disk of cells
     * that fully covers the radius, and unions only those cell sets — the query
     * cost scales with the number of cells in the ring, not the total fleet.
     * Filters out drivers whose heartbeats have expired using pipelined MGET.
     */
    static async findNearbyDrivers(loc, radiusKm) {
        console.log(`[GEO] Searching nearby drivers. Pickup: lat=${loc.lat}, lng=${loc.lng}, radius=${radiusKm}km`);
        const searchRadius = Math.max(radiusKm, 0.1);
        try {
            // 1. Hexagonal candidate discovery — union the cell sets in the ring.
            const centerCell = (0, h3_js_1.latLngToCell)(loc.lat, loc.lng, H3_MATCHING_RESOLUTION);
            const rings = radiusToGridDiskRings(searchRadius);
            const cells = (0, h3_js_1.gridDisk)(centerCell, rings);
            const cellKeys = cells.map(c => `${redis_1.DRIVER_H3_INDEX_PREFIX}${c}`);
            let candidates = await redis_1.redis.sunion(...cellKeys);
            // Fallback: if the H3 index is empty (e.g. cold start / rollout before
            // the index is backfilled) fall back to the classic GEO scan so a live
            // rider request is never starved.
            if (!candidates || candidates.length === 0) {
                return this._georadiusFallback(loc, searchRadius);
            }
            candidates = [...new Set(candidates)];
            // 2. Exact straight-line distance to the pickup for each candidate.
            // Fetch each candidate's position from the GEO set (pipeline) and
            // compute haversine distance. Candidates still present in the cell set
            // but gone from the GEO set (stale index entry) return null and are
            // skipped.
            const distPipe = redis_1.redis.pipeline();
            for (const id of candidates) {
                distPipe.geopos(redis_1.DRIVER_LOCATIONS_KEY, id);
            }
            const posResults = (await distPipe.exec()) || [];
            const inRadius = [];
            candidates.forEach((id, i) => {
                const res = posResults[i];
                const pos = res && !res[0] ? res[1] : null;
                if (!pos || !pos[0])
                    return;
                const [lng, lat] = [Number(pos[0][0]), Number(pos[0][1])];
                const distance = haversineKm(loc.lat, loc.lng, lat, lng);
                if (distance <= searchRadius) {
                    inRadius.push({ id, distance });
                }
            });
            if (inRadius.length === 0)
                return [];
            // 3. Heartbeat freshness filter (same as before).
            const ids = inRadius.map((d) => d.id);
            const heartbeatKeys = ids.map((id) => `${redis_1.DRIVER_HEARTBEAT_PREFIX}${id}`);
            const heartbeats = await redis_1.redis.mget(...heartbeatKeys);
            const nearbyDrivers = [];
            const staleIds = [];
            inRadius.forEach((d, i) => {
                if (heartbeats[i]) {
                    nearbyDrivers.push(d);
                }
                else {
                    staleIds.push(d.id);
                }
            });
            if (staleIds.length > 0) {
                console.log(`[GEO] Skipping ${staleIds.length} stale driver(s) (heartbeat expired): ${staleIds.join(', ')}`);
                // Don't remove from Redis here — the driver may reconnect soon.
                // Stale locations will be cleaned up by the cron worker instead.
            }
            return nearbyDrivers.sort((a, b) => a.distance - b.distance);
        }
        catch (error) {
            console.error(`[GEO] Error in hexagonal search:`, error);
            return [];
        }
    }
    /**
     * Classic GEORADIUS scan, kept as a fallback when the H3 index has no data.
     */
    static async _georadiusFallback(loc, radiusKm) {
        try {
            const results = await redis_1.redis.georadius(redis_1.DRIVER_LOCATIONS_KEY, loc.lng, loc.lat, radiusKm, 'km', 'WITHDIST', 'ASC');
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
                console.log(`[GEO] Skipping ${staleIds.length} stale driver(s) (heartbeat expired): ${staleIds.join(', ')}`);
            }
            return nearbyDrivers;
        }
        catch (error) {
            console.error(`[GEO] Error in georadius fallback:`, error);
            return [];
        }
    }
    /**
     * Removes a driver from online tracking (GEO set, heartbeat, H3 cell index)
     */
    static async removeDriverLocation(driverId) {
        const cellKey = `${redis_1.DRIVER_H3_CELL_PREFIX}${driverId}`;
        const cell = await redis_1.redis.get(cellKey);
        const pipeline = redis_1.redis.pipeline();
        pipeline.zrem(redis_1.DRIVER_LOCATIONS_KEY, driverId);
        pipeline.del(`${redis_1.DRIVER_HEARTBEAT_PREFIX}${driverId}`);
        if (cell) {
            pipeline.srem(`${redis_1.DRIVER_H3_INDEX_PREFIX}${cell}`, driverId);
        }
        pipeline.del(cellKey);
        await pipeline.exec();
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