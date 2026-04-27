// backend/src/middleware/rateLimit.middleware.ts
import { Request, Response, NextFunction } from 'express';
import { redis } from '../config/redis';

const RATE_LIMIT_WINDOW = 60; // 1 minute window
const MAX_REQUESTS = 100;    // Max 100 requests per window

/**
 * Basic rate limiting middleware using Redis.
 * Limits requests based on client IP.
 */
export const rateLimitMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const key = `rate-limit:${ip}`;

  try {
    const requests = await redis.incr(key);
    
    if (requests === 1) {
      // Set expiration for the first request in the window
      await redis.expire(key, RATE_LIMIT_WINDOW);
    }

    if (requests > MAX_REQUESTS) {
      return res.status(429).json({
        error: 'Too many requests',
        message: 'Rate limit exceeded. Please try again after a minute.'
      });
    }

    next();
  } catch (err) {
    console.error('Rate limit error:', err);
    // In case of Redis failure, we allow the request but log the error
    next();
  }
};
