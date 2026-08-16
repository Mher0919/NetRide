// backend/src/services/cleanup.service.ts
//
// @deprecated — Periodic maintenance is now handled by the BullMQ cron worker
// (cleanup:stale-rides queue). This file is kept for backward compatibility
// and as a thin wrapper that enqueues the job.
import { prisma } from './prisma.service';
import { TripStatus } from '../types';
import { getIo } from '../gateway/io-handle';
import { RideRepository } from '../modules/ride/ride.repository';
import { redis, DRIVER_LOCATIONS_KEY, DRIVER_HEARTBEAT_PREFIX } from '../config/redis';
import { cleanupQueue } from '../queue/queue';

export const CleanupService = {
  async performMaintenance() {
    // The staleness sweep MUST run inline every cycle — environments without
    // a running BullMQ worker (LEGACY_SYNC_MATCHING + no cron worker) would
    // otherwise accumulate never-cancelled REQUESTED rides forever. The
    // best-effort queue enqueue remains so scaled deployments still process
    // it exactly once per worker too; every step is idempotent.
    try {
      await cleanupQueue.add('cleanupStaleRides', {}, {
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: { age: 3600 },
      });
    } catch {
      // Redis/BullMQ unavailable — inline run below still covers us.
    }

    // Authoritative stale-ride sweep (REQUESTED timeouts + never-started +
    // overdue active rides). Runs inline so every deployment resolves
    // ghost rides even when the BullMQ worker is not present; the queue
    // enqueue above covers the distributed case.
    await this.sweepStaleRides();
    await this.cleanupGhostDrivers();
    // Keep heatmap retention alive.
    const { sweepExpiredActivity } = require('./demand.service') as typeof import('./demand.service');
    sweepExpiredActivity().catch(() => undefined);
  },

  async sweepStaleRides(): Promise<void> {
    const { sweepStaleActiveRides } = require('../queue/jobs/cleanupStaleRides') as typeof import('../queue/jobs/cleanupStaleRides');
    await sweepStaleActiveRides(getIo()).catch((err: any) => {
      console.error('[CLEANUP] Stale ride sweep failed:', err.message);
    });
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
      getIo().to(`rider:${ride.rider_id}`).emit('tripUpdate', updatedTrip);
      getIo().to('monitoring:all_rides').emit('tripUpdate', updatedTrip);
      await redis.del(`dispatch:lock:${ride.id}`);
      // Release any dispatched driver offer so no stale offer can be accepted.
      const { DriverOfferService } = require('./driver-offer.service') as typeof import('./driver-offer.service');
      await DriverOfferService.cancelRideOffers(ride.id).catch(() => undefined);
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
