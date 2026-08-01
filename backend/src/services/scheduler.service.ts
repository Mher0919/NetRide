// backend/src/services/scheduler.service.ts
import { prisma } from './prisma.service';
import { matchingService } from './matching.service';
import { io } from '../app';

export const SchedulerService = {
  /**
   * Periodically checks for scheduled rides that need to be dispatched.
   * Rides are dispatched 15 minutes before their scheduled time.
   */
  async checkScheduledRides() {
    const dispatchThreshold = new Date(Date.now() + 15 * 60 * 1000);
    const pastThreshold = new Date(Date.now() - 30 * 60 * 1000); // safety catch for missed ones

    try {
      const pendingRides = await prisma.ride.findMany({
        where: {
          is_scheduled: true,
          status: 'REQUESTED',
          scheduled_at: {
            lte: dispatchThreshold,
            gte: pastThreshold
          },
          driver_id: null // only ones not yet offered
        }
      });

      if (pendingRides.length === 0) return;

      console.log(`[SCHEDULER] ⏰ Found ${pendingRides.length} scheduled rides for dispatch.`);

      for (const ride of pendingRides) {
        // Trigger the standard dispatch flow
        matchingService.findAndDispatch(
          io, 
          ride.id, 
          ride.pickup_lat!, 
          ride.pickup_lng!,
          ride.rider_id!
        );
        
        // Log to console for observability
        console.log(`[SCHEDULER] 🚀 Dispatched scheduled ride ${ride.id} for user ${ride.rider_id}`);
      }
    } catch (err: any) {
      console.error(`[SCHEDULER] ❌ Error in scheduled ride check: ${err.message}`);
    }
  }
};
