import Redis from 'ioredis';
import { env } from './env';

const redisUrl = env.REDIS_URL.replace('localhost', '127.0.0.1');

const redisOptions = {
  maxRetriesPerRequest: null,
  connectTimeout: 5000,
  // NOTE: these two clients MUST keep the offline queue enabled. The
  // Socket.IO Redis adapter calls `subClient.psubscribe()` synchronously
  // the moment `io.adapter()` wires it up — before the lazy connection has
  // opened. With the queue disabled that first command is rejected, the
  // adapter is left half-initialized, and every room broadcast
  // (newTripRequest, tripUpdate, driverLocationUpdate) is silently lost.
  // Queued commands are flushed as soon as the stream opens; this is the
  // standard configuration for @socket.io/redis-adapter.
  enableOfflineQueue: true,
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

// Kick the lazy connections open right away (module-load time) so the
// Socket.IO adapter's subscribe commands flush immediately instead of
// waiting for the first broadcast. Failure is non-fatal: app.ts falls back
// to single-instance mode and the clients retry per the backoff above.
pubClient.connect().catch(() => {});
subClient.connect().catch(() => {});

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
