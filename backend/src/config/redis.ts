// backend/src/config/redis.ts
import Redis from 'ioredis';
import { env } from './env';

// If REDIS_URL contains 'localhost', replace with '127.0.0.1' for Windows reliability
const redisUrl = env.REDIS_URL.replace('localhost', '127.0.0.1');

export const redis = new Redis(redisUrl, {
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
  retryStrategy: (times: number) => (times > 10 ? null : Math.min(times * 200, 2000)),
});

redis.on('error', (err) => {
  console.error('[REDIS] Connection error:', err.message);
});

redis.on('connect', () => {
  console.log('[REDIS] Successfully connected to Redis at', redisUrl);
});

export const DRIVER_LOCATIONS_KEY = 'driver_locations';
export const DRIVER_HEARTBEAT_PREFIX = 'driver:heartbeat:';

// H3 hexagonal cell index for scalable rider↔driver matching. Each online
// driver is a member of the set for their current H3 cell; `findNearbyDrivers`
// queries only the small ring of cells around the pickup (gridDisk) instead of
// scanning the global GEO set. `DRIVER_H3_CELL_PREFIX` maps a driver to their
// current cell so we can remove them from the old cell when they move.
export const DRIVER_H3_CELL_PREFIX = 'driver:h3:';
export const DRIVER_H3_INDEX_PREFIX = 'drivers:h3:';
