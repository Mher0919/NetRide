import Redis from 'ioredis';
import { env } from './env';

const redisUrl = env.REDIS_URL.replace('localhost', '127.0.0.1');

const redisOptions = {
  maxRetriesPerRequest: null,
  connectTimeout: 5000,
};

export const pubClient = new Redis(redisUrl, redisOptions);
export const subClient = new Redis(redisUrl, redisOptions);

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
