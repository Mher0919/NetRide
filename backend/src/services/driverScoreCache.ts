import { redis } from '../config/redis';
import { prisma } from './prisma.service';
import { env } from '../config/env';

export interface ScoreFactors {
  rating: number;
  rating_count: number;
  acceptance_count: number;
  cancellation_count: number;
  total_rides: number;
  is_dangerous: boolean;
  is_flagged: boolean;
  last_cancellation_at: string | null;
  price_per_mile: number;
  active_class: string;
  cached_at: string;
}

function key(driverId: string): string {
  return `score:driver:${driverId}`;
}

export async function getScoreFactors(driverId: string): Promise<ScoreFactors | null> {
  const data = await redis.hgetall(key(driverId));
  if (!data || !data.cached_at) return null;
  return {
    rating: parseFloat(data.rating || '5.0'),
    rating_count: parseInt(data.rating_count || '0', 10),
    acceptance_count: parseInt(data.acceptance_count || '0', 10),
    cancellation_count: parseInt(data.cancellation_count || '0', 10),
    total_rides: parseInt(data.total_rides || '0', 10),
    is_dangerous: data.is_dangerous === '1',
    is_flagged: data.is_flagged === '1',
    last_cancellation_at: data.last_cancellation_at || null,
    price_per_mile: parseFloat(data.price_per_mile || '2.00'),
    active_class: data.active_class || 'CORE',
    cached_at: data.cached_at,
  };
}

export async function setScoreFactors(driverId: string, factors: Omit<ScoreFactors, 'cached_at'>): Promise<void> {
  const pipe = redis.pipeline();
  pipe.hset(key(driverId), {
    rating: String(factors.rating),
    rating_count: String(factors.rating_count),
    acceptance_count: String(factors.acceptance_count),
    cancellation_count: String(factors.cancellation_count),
    total_rides: String(factors.total_rides),
    is_dangerous: factors.is_dangerous ? '1' : '0',
    is_flagged: factors.is_flagged ? '1' : '0',
    last_cancellation_at: factors.last_cancellation_at || '',
    price_per_mile: String(factors.price_per_mile),
    active_class: factors.active_class,
    cached_at: new Date().toISOString(),
  });
  pipe.expire(key(driverId), env.DRIVER_SCORE_CACHE_TTL_S);
  await pipe.exec();
}

export async function invalidate(driverId: string): Promise<void> {
  await redis.del(key(driverId));
}

export async function mgetScoreFactors(driverIds: string[]): Promise<Map<string, ScoreFactors | null>> {
  const result = new Map<string, ScoreFactors | null>();
  if (driverIds.length === 0) return result;

  const pipe = redis.pipeline();
  for (const id of driverIds) {
    pipe.hgetall(key(id));
  }
  const responses = await pipe.exec();
  if (!responses) return result;

  for (let i = 0; i < driverIds.length; i++) {
    const data = responses[i]?.[1] as Record<string, string> | null;
    if (data && data.cached_at) {
      result.set(driverIds[i], {
        rating: parseFloat(data.rating || '5.0'),
        rating_count: parseInt(data.rating_count || '0', 10),
        acceptance_count: parseInt(data.acceptance_count || '0', 10),
        cancellation_count: parseInt(data.cancellation_count || '0', 10),
        total_rides: parseInt(data.total_rides || '0', 10),
        is_dangerous: data.is_dangerous === '1',
        is_flagged: data.is_flagged === '1',
        last_cancellation_at: data.last_cancellation_at || null,
        price_per_mile: parseFloat(data.price_per_mile || '2.00'),
        active_class: data.active_class || 'CORE',
        cached_at: data.cached_at,
      });
    } else {
      result.set(driverIds[i], null);
    }
  }
  return result;
}

export async function refreshFromDb(driverId: string): Promise<ScoreFactors> {
  const driver = await prisma.driver.findUnique({
    where: { user_id: driverId },
    include: { user: { select: { rating: true, rating_count: true } } },
  });

  const factors = {
    rating: Number(driver?.user?.rating || 5.0),
    rating_count: driver?.user?.rating_count || 0,
    acceptance_count: driver?.acceptance_count || 0,
    cancellation_count: driver?.cancellation_count || 0,
    total_rides: driver?.total_rides || 0,
    is_dangerous: driver?.is_dangerous || false,
    is_flagged: driver?.is_flagged || false,
    last_cancellation_at: driver?.last_cancellation_at?.toISOString() || null,
    price_per_mile: Number(driver?.price_per_mile || 2.00),
    active_class: driver?.active_class || 'CORE',
  };

  await setScoreFactors(driverId, factors);
  return { ...factors, cached_at: new Date().toISOString() };
}
