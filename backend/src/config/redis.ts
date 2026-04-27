// backend/src/config/redis.ts
import Redis from 'ioredis';
import { env } from './env';

// If REDIS_URL contains 'localhost', replace with '127.0.0.1' for Windows reliability
const redisUrl = env.REDIS_URL.replace('localhost', '127.0.0.1');

export const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
  connectTimeout: 5000, // 5 seconds
});

redis.on('error', (err) => {
  console.error('[REDIS] Connection error:', err.message);
});

redis.on('connect', () => {
  console.log('[REDIS] Successfully connected to Redis at', redisUrl);
});

export const DRIVER_LOCATIONS_KEY = 'driver_locations';
