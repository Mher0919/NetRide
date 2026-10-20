"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DRIVER_H3_INDEX_PREFIX = exports.DRIVER_H3_CELL_PREFIX = exports.DRIVER_ACTIVE_TRIP_TTL_S = exports.DRIVER_ONLINE_PREFIX = exports.DRIVER_LOCATION_RECORD_PREFIX = exports.DRIVER_HEARTBEAT_PREFIX = exports.DRIVER_LOCATIONS_KEY = exports.redis = void 0;
// backend/src/config/redis.ts
const ioredis_1 = __importDefault(require("ioredis"));
const env_1 = require("./env");
// If REDIS_URL contains 'localhost', replace with '127.0.0.1' for Windows reliability
const redisUrl = env_1.env.REDIS_URL.replace('localhost', '127.0.0.1');
exports.redis = new ioredis_1.default(redisUrl, {
    maxRetriesPerRequest: null,
    connectTimeout: 5000, // 5 seconds
    // Reject commands immediately while disconnected instead of queueing
    // them. Callers (rate limiter, caches) are written to fail open, so a
    // queued command would hang the request forever — an offline-queueing
    // client turns a Redis outage into a full app outage.
    enableOfflineQueue: false,
    // Don't open a socket until the first command — avoids a connection
    // attempt (and its error spam) at import time, and keeps the process
    // from crashing if Redis is briefly unavailable during boot.
    lazyConnect: true,
    // Bound the reconnect backoff so a downed Redis can never pin the event
    // loop forever (which would block graceful shutdown / test exits). After
    // ~10s of failures we stop retrying; commands reject fast (fail-open),
    // the app stays up, and the routing cache degrades to cache-miss
    // automatically until Redis returns.
    retryStrategy: (times) => (times > 10 ? null : Math.min(times * 200, 2000)),
});
exports.redis.on('error', (err) => {
    console.error('[REDIS] Connection error:', err.message);
});
exports.redis.on('connect', () => {
    console.log('[REDIS] Successfully connected to Redis at', redisUrl);
});
exports.DRIVER_LOCATIONS_KEY = 'driver_locations';
exports.DRIVER_HEARTBEAT_PREFIX = 'driver:heartbeat:';
// Timestamped last-known location record (JSON): lat/lng/accuracy/source/
// serverAt. Used to decide whether a position is fresh enough to gate
// trip actions or dispatch on. Expires so it can never be served as live
// indefinitely.
exports.DRIVER_LOCATION_RECORD_PREFIX = 'driver:loc:';
// Server-side availability lease set by `goOnline` and renewed by accepted
// location updates. Distinct from the location heartbeat: a driver can be
// lease-online but location-stale (explicit `stale_location` eligibility
// state) without being treated as absent.
exports.DRIVER_ONLINE_PREFIX = 'driver:online:';
// How long the "driver is on a trip" lock lives. RENEWED on every accepted
// location fix while the key exists, so a legitimately long trip never
// expires it; it only acts as a safety TTL for a driver whose app vanished.
exports.DRIVER_ACTIVE_TRIP_TTL_S = 4 * 60 * 60;
// H3 hexagonal cell index for scalable rider↔driver matching. Each online
// driver is a member of the set for their current H3 cell; `findNearbyDrivers`
// queries only the small ring of cells around the pickup (gridDisk) instead of
// scanning the global GEO set. `DRIVER_H3_CELL_PREFIX` maps a driver to their
// current cell so we can remove them from the old cell when they move.
exports.DRIVER_H3_CELL_PREFIX = 'driver:h3:';
exports.DRIVER_H3_INDEX_PREFIX = 'drivers:h3:';
//# sourceMappingURL=redis.js.map