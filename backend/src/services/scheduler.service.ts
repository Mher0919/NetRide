import { prisma } from './prisma.service';
import { io } from '../app';
import { env } from '../config/env';

export const SchedulerService = {
  async checkScheduledRides() {
    const dispatchThreshold = new Date(Date.now() + 15 * 60 * 1000);
    const pastThreshold = new Date(Date.now() - 30 * 60 * 1000);

    try {
      const pendingRides = await prisma.ride.findMany({
        where: {
          is_scheduled: true,
          status: 'REQUESTED',
          scheduled_at: {
            lte: dispatchThreshold,
            gte: pastThreshold,
          },
          driver_id: null,
        },
      });

      if (pendingRides.length === 0) return;

      console.log(`[SCHEDULER] Found ${pendingRides.length} scheduled rides for dispatch.`);

      if (env.LEGACY_SYNC_MATCHING) {
        const { matchingService } = await import('./matching.service');
        for (const ride of pendingRides) {
          matchingService.findAndDispatch(
            io, ride.id, ride.pickup_lat ?? 0, ride.pickup_lng ?? 0, ride.rider_id ?? undefined,
          ).catch((err: any) => console.error(`[SCHEDULER] In-process dispatch failed for ${ride.id}: ${err.message}`));
          console.log(`[SCHEDULER] Dispatched scheduled ride ${ride.id} for user ${ride.rider_id}`);
        }
      } else {
        const { matchQueue } = await import('../queue/queue');

        for (const ride of pendingRides) {
          await matchQueue.add('matchRide', {
            tripId: ride.id,
            pickupLat: ride.pickup_lat,
            pickupLng: ride.pickup_lng,
            riderId: ride.rider_id,
          });

          console.log(`[SCHEDULER] Enqueued scheduled ride ${ride.id} for user ${ride.rider_id}`);
        }
      }
    } catch (err: any) {
      console.error(`[SCHEDULER] Error in scheduled ride check: ${err.message}`);
    }
  },
};
