"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.rateLimitMiddleware = void 0;
const redis_1 = require("../config/redis");
const env_1 = require("../config/env");
const rateLimitConfig_1 = require("./rateLimitConfig");
const metrics_1 = require("../observability/metrics");
const logger_1 = require("../observability/logger");
const SLIDING_WINDOW_LUA = `
local cutoff = tonumber(ARGV[3]) - tonumber(ARGV[2])
redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", cutoff)
local count = redis.call("ZCARD", KEYS[1])
if count >= tonumber(ARGV[1]) then
  local oldest = redis.call("ZRANGE", KEYS[1], 0, 0, "WITHSCORES")
  local retry_ms = tonumber(ARGV[2]) - (tonumber(ARGV[3]) - tonumber(oldest[2]))
  return {0, count, retry_ms}
end
redis.call("ZADD", KEYS[1], ARGV[3], ARGV[4])
redis.call("PEXPIRE", KEYS[1], tonumber(ARGV[2]))
return {1, count + 1, 0}
`;
async function consume(key, rule) {
    const now = Date.now();
    const member = `${now}:${Math.random().toString(36).slice(2, 10)}`;
    const result = await redis_1.redis.eval(SLIDING_WINDOW_LUA, 1, key, String(rule.max), String(rule.windowMs), String(now), member);
    const [allowed, count, retryMs] = result;
    return {
        allowed: allowed === 1,
        remaining: Math.max(0, rule.max - count),
        retryAfterMs: retryMs,
    };
}
const legacyIpLimiter = async (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const key = `rate-limit:${ip}`;
    try {
        const requests = await redis_1.redis.incr(key);
        if (requests === 1)
            await redis_1.redis.expire(key, 60);
        if (requests > 100) {
            metrics_1.rateLimitedTotal.inc({ bucket: 'ip' });
            return res.status(429).json({ error: 'Too many requests', message: 'Rate limit exceeded. Please try again after a minute.' });
        }
        next();
    }
    catch (err) {
        logger_1.logger.error({ err }, 'rate_limit_legacy_error');
        next();
    }
};
const rateLimitMiddleware = async (req, res, next) => {
    if (env_1.env.LOAD_TEST)
        return next();
    if (env_1.env.LEGACY_RATE_LIMIT)
        return legacyIpLimiter(req, res, next);
    const routeKey = (0, rateLimitConfig_1.matchRoute)(req.path, req.method);
    const config = routeKey ? rateLimitConfig_1.RATE_LIMITS[routeKey] : null;
    const userId = req.user?.id;
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    let userResult = null;
    let ipResult = null;
    const userRule = config?.user || (userId ? rateLimitConfig_1.DEFAULT_USER_LIMIT : null);
    const ipRule = config?.ip || rateLimitConfig_1.DEFAULT_IP_LIMIT;
    // Keys include the route so each endpoint has its own budget.
    const ns = routeKey ?? 'default';
    if (userRule && userId) {
        userResult = await consume(`ratelimit:user:${ns}:${userId}`, userRule);
    }
    if (ipRule && !(userId && userResult?.allowed)) {
        ipResult = await consume(`ratelimit:ip:${ns}:${ip}`, ipRule);
    }
    const result = userResult && userId ? userResult : ipResult;
    if (!result.allowed) {
        metrics_1.rateLimitedTotal.inc({ bucket: userId ? 'user' : 'ip' });
        const retrySeconds = Math.ceil(result.retryAfterMs / 1000);
        res.setHeader('Retry-After', retrySeconds);
        res.setHeader('X-RateLimit-Remaining', '0');
        const friendlyMessage = retrySeconds > 60
            ? `Too many requests. Please try again in ${Math.ceil(retrySeconds / 60)} minute(s).`
            : `Too many requests. Please try again in ${retrySeconds} second(s).`;
        return res.status(429).json({
            error: 'Too many requests',
            message: friendlyMessage,
        });
    }
    res.setHeader('X-RateLimit-Remaining', String(result.remaining));
    next();
};
exports.rateLimitMiddleware = rateLimitMiddleware;
//# sourceMappingURL=rateLimit.middleware.js.map