import { Server } from 'socket.io';
import { prisma } from '../../services/prisma.service';
import { TripStatus } from '../../types';
import { RideRepository } from '../../modules/ride/ride.repository';
import { redis, DRIVER_LOCATIONS_KEY, DRIVER_HEARTBEAT_PREFIX } from '../../config/redis';

export async function handleCleanupStaleRides(io: Server) {
  return async (job: any) => {
    try {
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
      const staleRides = await prisma.ride.findMany({
        where: {
          status: 'REQUESTED',
          created_at: { lt: tenMinutesAgo },
        },
        select: { id: true, rider_id: true, created_at: true },
      });

      for (const ride of staleRides) {
        const updatedTrip = await RideRepository.updateStatus(ride.id, TripStatus.CANCELLED, {
          cancelled_at: new Date(),
          cancel_reason: 'Request timed out (no driver accepted after extended search)',
        });
        io.to(`rider:${ride.rider_id}`).emit('tripUpdate', updatedTrip);
        io.to('monitoring:all_rides').emit('tripUpdate', updatedTrip);
        await redis.del(`dispatch:lock:${ride.id}`);
        await redis.del(`match:queue:dispatched:${ride.id}`);
      }

      const driverIds = await redis.zrange(DRIVER_LOCATIONS_KEY, 0, -1);
      let ghostCount = 0;
      for (const id of driverIds) {
        const heartbeat = await redis.get(`${DRIVER_HEARTBEAT_PREFIX}${id}`);
        if (!heartbeat) {
          await redis.zrem(DRIVER_LOCATIONS_KEY, id);
          ghostCount++;
        }
      }

      if (staleRides.length > 0 || ghostCount > 0) {
        console.log(`[CLEANUP] Cancelled ${staleRides.length} stale rides, removed ${ghostCount} ghost drivers`);
      }
    } catch (err: any) {
      console.error('[CLEANUP] Maintenance failed:', err.message);
    }
  };
}
