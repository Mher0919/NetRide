// backend/src/services/cleanup.service.ts
//
// @deprecated — Periodic maintenance is now handled by the BullMQ cron worker
// (cleanup:stale-rides queue). This file is kept for backward compatibility
// and as a thin wrapper that enqueues the job.
import { prisma } from './prisma.service';
import { TripStatus } from '../types';
import { io } from '../app';
import { RideRepository } from '../modules/ride/ride.repository';
import { redis, DRIVER_LOCATIONS_KEY, DRIVER_HEARTBEAT_PREFIX } from '../config/redis';
import { cleanupQueue } from '../queue/queue';

export const CleanupService = {
  async performMaintenance() {
    console.log('[CLEANUP] Enqueuing maintenance job...');
    try {
      await cleanupQueue.add('cleanupStaleRides', {}, {
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: { age: 3600 },
      });
    } catch {
      await this.cancelStaleRideRequests();
      await this.cleanupGhostDrivers();
      // Fallback path when BullMQ is down — keep heatmap retention alive.
      const { sweepExpiredActivity } = require('./demand.service') as typeof import('./demand.service');
      sweepExpiredActivity().catch(() => undefined);
    }
  },

  async cancelStaleRideRequests() {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const staleRides = await prisma.ride.findMany({
      where: { status: 'REQUESTED', created_at: { lt: fiveMinutesAgo } },
      select: { id: true, rider_id: true },
    });
    if (staleRides.length === 0) return;
    for (const ride of staleRides) {
      const updatedTrip = await RideRepository.updateStatus(ride.id, TripStatus.CANCELLED, {
        cancelled_at: new Date(),
        cancel_reason: 'Request timed out (no driver accepted or rider disconnected)',
      });
      io.to(`rider:${ride.rider_id}`).emit('tripUpdate', updatedTrip);
      io.to('monitoring:all_rides').emit('tripUpdate', updatedTrip);
      await redis.del(`dispatch:lock:${ride.id}`);
    }
  },

  async cleanupGhostDrivers() {
    const driverIds = await redis.zrange(DRIVER_LOCATIONS_KEY, 0, -1);
    let ghostCount = 0;
    for (const id of driverIds) {
      const heartbeat = await redis.get(`${DRIVER_HEARTBEAT_PREFIX}${id}`);
      if (!heartbeat) {
        await redis.zrem(DRIVER_LOCATIONS_KEY, id);
        ghostCount++;
      }
    }
    if (ghostCount > 0) {
      console.log(`[CLEANUP] 👻 Removed ${ghostCount} ghost drivers from discovery.`);
    }
  }
};
