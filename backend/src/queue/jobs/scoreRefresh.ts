import { redis, DRIVER_LOCATIONS_KEY } from '../../config/redis';
import { prisma } from '../../services/prisma.service';
import { env } from '../../config/env';

export async function handleScoreRefresh() {
  return async (job: any) => {
    try {
      const driverIds = await redis.zrange(DRIVER_LOCATIONS_KEY, 0, -1);
      if (driverIds.length === 0) return;

      const drivers = await prisma.driver.findMany({
        where: { user_id: { in: driverIds } },
        include: {
          user: { select: { rating: true, rating_count: true } },
        },
      });

      const pipeline = redis.pipeline();
      for (const driver of drivers) {
        const key = `score:driver:${driver.user_id}`;
        pipeline.hset(key, {
          rating: String(driver.user?.rating || 5.0),
          rating_count: String(driver.user?.rating_count || 0),
          acceptance_count: String(driver.acceptance_count || 0),
          cancellation_count: String(driver.cancellation_count || 0),
          total_rides: String(driver.total_rides || 0),
          is_dangerous: driver.is_dangerous ? '1' : '0',
          is_flagged: driver.is_flagged ? '1' : '0',
          last_cancellation_at: driver.last_cancellation_at?.toISOString() || '',
          cached_at: new Date().toISOString(),
        });
        pipeline.expire(key, env.DRIVER_SCORE_CACHE_TTL_S);
      }
      await pipeline.exec();
      console.log(`[SCORE] Refreshed scores for ${drivers.length} online drivers`);
    } catch (err: any) {
      console.error('[SCORE] Refresh failed:', err.message);
    }
  };
}
