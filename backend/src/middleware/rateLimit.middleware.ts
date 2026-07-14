import { Request, Response, NextFunction } from 'express';
import { redis } from '../config/redis';
import { env } from '../config/env';
import { RATE_LIMITS, DEFAULT_USER_LIMIT, DEFAULT_IP_LIMIT, matchRoute, RateLimitRule } from './rateLimitConfig';
import { rateLimitedTotal } from '../observability/metrics';
import { logger } from '../observability/logger';

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

async function consume(key: string, rule: RateLimitRule): Promise<{ allowed: boolean; remaining: number; retryAfterMs: number }> {
  const now = Date.now();
  const member = `${now}:${Math.random().toString(36).slice(2, 10)}`;
  const result = await redis.eval(SLIDING_WINDOW_LUA, 1, key, String(rule.max), String(rule.windowMs), String(now), member);
  const [allowed, count, retryMs] = result as [number, number, number];
  return {
    allowed: allowed === 1,
    remaining: Math.max(0, rule.max - count),
    retryAfterMs: retryMs,
  };
}

const legacyIpLimiter = async (req: Request, res: Response, next: NextFunction) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const key = `rate-limit:${ip}`;
  try {
    const requests = await redis.incr(key);
    if (requests === 1) await redis.expire(key, 60);
    if (requests > 100) {
      rateLimitedTotal.inc({ bucket: 'ip' });
      return res.status(429).json({ error: 'Too many requests', message: 'Rate limit exceeded. Please try again after a minute.' });
    }
    next();
  } catch (err) {
    logger.error({ err }, 'rate_limit_legacy_error');
    next();
  }
};

export const rateLimitMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  if (env.LOAD_TEST) return next();
  if (env.LEGACY_RATE_LIMIT) return legacyIpLimiter(req, res, next);

  const routeKey = matchRoute(req.path, req.method);
  const config = routeKey ? RATE_LIMITS[routeKey] : null;

  const userId = (req as any).user?.id;
  const ip = req.ip || req.socket.remoteAddress || 'unknown';

  let userResult: { allowed: boolean; remaining: number; retryAfterMs: number } | null = null;
  let ipResult: { allowed: boolean; remaining: number; retryAfterMs: number } | null = null;

  const userRule = config?.user || (userId ? DEFAULT_USER_LIMIT : null);
  const ipRule = config?.ip || DEFAULT_IP_LIMIT;

  // Keys include the route so each endpoint has its own budget.
  const ns = routeKey ?? 'default';
  if (userRule && userId) {
    userResult = await consume(`ratelimit:user:${ns}:${userId}`, userRule);
  }

  if (ipRule && !(userId && userResult?.allowed)) {
    ipResult = await consume(`ratelimit:ip:${ns}:${ip}`, ipRule);
  }

  const result = userResult && userId ? userResult : ipResult!;

  if (!result.allowed) {
    rateLimitedTotal.inc({ bucket: userId ? 'user' : 'ip' });
    res.setHeader('Retry-After', Math.ceil(result.retryAfterMs / 1000));
    res.setHeader('X-RateLimit-Remaining', '0');
    return res.status(429).json({
      error: 'Too many requests',
      message: 'Rate limit exceeded. Please try again later.',
    });
  }

  res.setHeader('X-RateLimit-Remaining', String(result.remaining));
  next();
};
