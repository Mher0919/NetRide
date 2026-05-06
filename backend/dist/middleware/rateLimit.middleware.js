"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.rateLimitMiddleware = void 0;
const redis_1 = require("../config/redis");
const RATE_LIMIT_WINDOW = 60; // 1 minute window
const MAX_REQUESTS = 100; // Max 100 requests per window
/**
 * Basic rate limiting middleware using Redis.
 * Limits requests based on client IP.
 */
const rateLimitMiddleware = async (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const key = `rate-limit:${ip}`;
    try {
        const requests = await redis_1.redis.incr(key);
        if (requests === 1) {
            // Set expiration for the first request in the window
            await redis_1.redis.expire(key, RATE_LIMIT_WINDOW);
        }
        if (requests > MAX_REQUESTS) {
            return res.status(429).json({
                error: 'Too many requests',
                message: 'Rate limit exceeded. Please try again after a minute.'
            });
        }
        next();
    }
    catch (err) {
        console.error('Rate limit error:', err);
        // In case of Redis failure, we allow the request but log the error
        next();
    }
};
exports.rateLimitMiddleware = rateLimitMiddleware;
//# sourceMappingURL=rateLimit.middleware.js.map