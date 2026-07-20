// backend/src/config/redis.ts
import Redis from 'ioredis';
import { env } from './env';

// If REDIS_URL contains 'localhost', replace with '127.0.0.1' for Windows reliability
const redisUrl = env.REDIS_URL.replace('localhost', '127.0.0.1');

export const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
  connectTimeout: 5000, // 5 seconds
  // Don't open a socket until the first command — avoids a connection
  // attempt (and its error spam) at import time, and keeps the process
  // from crashing if Redis is briefly unavailable during boot.
  lazyConnect: true,
  // Bound the reconnect backoff so a downed Redis can never pin the event
  // loop forever (which would block graceful shutdown / test exits). After
  // ~10s of failures we stop retrying; the app stays up and the routing
  // cache degrades to cache-miss automatically.
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
