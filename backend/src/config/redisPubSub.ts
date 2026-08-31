import Redis from 'ioredis';
import { env } from './env';

const redisUrl = env.REDIS_URL.replace('localhost', '127.0.0.1');

const redisOptions = {
  maxRetriesPerRequest: null,
  connectTimeout: 5000,
  // Reject commands immediately while disconnected (see redis.ts — these
  // clients are best-effort pub/sub fan-out and must fail fast, not queue).
  enableOfflineQueue: false,
  // Don't open a socket until the first command — avoids a connection
  // attempt at import time and prevents the process from crashing when
  // Redis is briefly unavailable during boot.
  lazyConnect: true,
  // Bound the reconnect backoff so a downed Redis can never pin the event
  // loop forever. After ~10s of failures we stop retrying; the clients stay
  // idle and the app stays up.
  retryStrategy: (times: number) => (times > 10 ? null : Math.min(times * 200, 2000)),
};

export const pubClient = new Redis(redisUrl, redisOptions);
export const subClient = new Redis(redisUrl, redisOptions);

// Swallow connection-level errors so a transient Redis outage never crashes
// the process. Both clients are best-effort (used only for cache
// invalidation fan-out) and degrade silently.
pubClient.on('error', (err) => {
  console.error('[REDIS_PUB] Connection error:', err.message);
});

subClient.on('error', (err) => {
  console.error('[REDIS_SUB] Connection error:', err.message);
});

pubClient.on('connect', () => {
  console.log('[REDIS_PUB] Connected');
});

subClient.on('connect', () => {
  console.log('[REDIS_SUB] Connected');
});
