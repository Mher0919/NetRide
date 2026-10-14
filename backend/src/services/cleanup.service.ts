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
import { LocationsService } from '../modules/location/locations.service';
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
      where: {
        status: 'REQUESTED',
        created_at: { lt: fiveMinutesAgo },
        // Scheduled rides legitimately wait as REQUESTED until their pickup
        // window; the watchdog must never cancel them as "stale".
        OR: [
          { is_scheduled: false },
          { is_scheduled: null },
          { scheduled_at: { lt: fiveMinutesAgo } },
        ],
      },
      select: { id: true, rider_id: true },
    });
    if (staleRides.length === 0) return;
    const { RideService } = require('../modules/ride/ride.service') as typeof import('../modules/ride/ride.service');
    for (const ride of staleRides) {
      // Guarded atomic cancel re-verifies age + status inside the UPDATE so
      // a ride accepted between the query and the write is left untouched.
      await RideService.cancelTripSystem(ride.id, {
        reasonText: 'Request timed out (no driver accepted or rider disconnected)',
        guard: {
          statuses: [TripStatus.REQUESTED],
          beforeColumn: 'created_at',
          before: fiveMinutesAgo,
          requireNotScheduledBefore: fiveMinutesAgo,
        },
      }).catch(() => undefined);
    }
  },

  async cleanupGhostDrivers() {
    const driverIds = await redis.zrange(DRIVER_LOCATIONS_KEY, 0, -1);
    let ghostCount = 0;
    for (const id of driverIds) {
      // Never remove a driver who still holds a live availability lease or
      // is mid-trip: a >90s GPS gap is an interruption, not proof they are
      // gone, and their last-known fix may be all the proximity gate has.
      const heartbeat = await redis.get(`${DRIVER_HEARTBEAT_PREFIX}${id}`);
      if (heartbeat) continue;
      const lease = await redis.get(`driver:online:${id}`);
      if (lease) continue;
      const activeTrip = await redis.get(`driver:${id}:active_trip`);
      if (activeTrip) continue;
      await LocationsService.removeDriverLocation(id);
      ghostCount++;
    }
    if (ghostCount > 0) {
      console.log(`[CLEANUP] 👻 Removed ${ghostCount} ghost drivers from discovery.`);
    }
  }
};
