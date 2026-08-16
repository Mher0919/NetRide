import { Server } from 'socket.io';
import { prisma } from '../../services/prisma.service';
import { TripStatus } from '../../types';
import { RideRepository } from '../../modules/ride/ride.repository';
import { RideService } from '../../modules/ride/ride.service';
import { redis, DRIVER_LOCATIONS_KEY, DRIVER_HEARTBEAT_PREFIX } from '../../config/redis';
import { sweepExpiredActivity } from '../../services/demand.service';
import { env } from '../../config/env';

/**
 * Resolve rides that are stuck in a non-terminal state without any hope of
 * proceeding — the production-grade watchdog every rideshare app needs.
 * Without this, a driver who kills the app mid-trip (or never picks up the
 * rider) leaves the ride "active" in the DB forever, and every subsequent
 * app launch re-attaches to it via getCurrentTrip.
 *
 * Three classes are swept:
 *   1. REQUESTED rides older than 10 minutes (no driver ever accepted) —
 *      cancelled as "request timed out".
 *   2. ACCEPTED / DRIVER_ARRIVING rides where the driver never started the
 *      ride within RIDE_ACCEPT_STALL_S of acceptance — cancelled (the driver
 *      abandoned the pickup; the rider is notified immediately via socket).
 *   3. ANY active ride (DRIVER_ARRIVING / IN_PROGRESS) whose started journey
 *      exceeds RIDE_MAX_DURATION_S without a completion — cancelled. A real
 *      trip never runs this long; the app sends a completion packet.
 *
 * All sweeps are idempotent and broadcast the authoritative CANCELLED
 * tripUpdate to rider + driver + admin monitoring, so every client settles
 * back to idle at the same instant.
 */
export async function sweepStaleActiveRides(io: Server | null): Promise<number> {
  const resolved: string[] = [];

  // ---- 1. REQUESTED: no driver accepted within 10 minutes ----------------
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
  const staleRides = await prisma.ride.findMany({
    where: {
      status: 'REQUESTED',
      created_at: { lt: tenMinutesAgo },
    },
    select: { id: true },
    take: env.RIDE_STALL_SWEEP_BATCH,
  });

  for (const ride of staleRides) {
    try {
      const updatedTrip = await RideRepository.updateStatus(ride.id, TripStatus.CANCELLED, {
        cancelled_at: new Date(),
        cancel_reason: 'Request timed out (no driver accepted after extended search)',
      });
      if (io) {
        io.to(`rider:${updatedTrip.rider_id}`).emit('tripUpdate', updatedTrip);
        io.to('monitoring:all_rides').emit('tripUpdate', updatedTrip);
      }
      await redis.del(`dispatch:lock:${ride.id}`);
      await redis.del(`match:queue:dispatched:${ride.id}`);
      const { DriverOfferService } = await import('../../services/driver-offer.service');
      await DriverOfferService.cancelRideOffers(ride.id).catch(() => undefined);
      resolved.push(ride.id);
    } catch (err: any) {
      console.error(`[CLEANUP] ⚠️ Failed to cancel stale REQUESTED ride ${ride.id}: ${err.message}`);
    }
  }

  // ---- 2. Accepted rides never started: RIDE_ACCEPT_STALL_S --------------
  const acceptStallCutoff = new Date(Date.now() - env.RIDE_ACCEPT_STALL_S * 1000);
  const neverStarted = await prisma.ride.findMany({
    where: {
      status: { in: [TripStatus.ACCEPTED, TripStatus.DRIVER_ARRIVING] },
      started_at: null,
      accepted_at: { lt: acceptStallCutoff },
    },
    select: { id: true },
    take: env.RIDE_STALL_SWEEP_BATCH,
  });

  for (const ride of neverStarted) {
    try {
      await RideService.cancelTripSystem(ride.id, {
        reasonText: `Driver did not start the ride within ${Math.round(env.RIDE_ACCEPT_STALL_S / 60)} minutes of acceptance (abandoned pickup).`,
      });
      resolved.push(ride.id);
    } catch (err: any) {
      console.error(`[CLEANUP] ⚠️ Failed to resolve never-started ride ${ride.id}: ${err.message}`);
    }
  }

  // ---- 3. Active rides over the maximum journey duration -----------------
  const maxDurationCutoff = new Date(Date.now() - env.RIDE_MAX_DURATION_S * 1000);
  const overdue = await prisma.ride.findMany({
    where: {
      status: { in: [TripStatus.DRIVER_ARRIVING, TripStatus.IN_PROGRESS] },
      OR: [
        { started_at: { lt: maxDurationCutoff } },
        { accepted_at: { lt: maxDurationCutoff } },
      ],
    },
    select: { id: true },
    take: env.RIDE_STALL_SWEEP_BATCH,
  });

  for (const ride of overdue) {
    try {
      const trip = await RideRepository.findById(ride.id);
      if (!trip) continue;
      const anchor = trip.started_at ?? trip.accepted_at ?? trip.requested_at;
      const ageH = anchor
        ? ((Date.now() - new Date(anchor as any).getTime()) / 3_600_000).toFixed(1)
        : '?';
      await RideService.cancelTripSystem(ride.id, {
        reasonText: `Ride exceeded the maximum duration of ${Math.round(env.RIDE_MAX_DURATION_S / 3600)}h (${ageH}h without completion) — resolved by the system.`,
      });
      resolved.push(ride.id);
    } catch (err: any) {
      console.error(`[CLEANUP] ⚠️ Failed to resolve overdue ride ${ride.id}: ${err.message}`);
    }
  }

  return resolved.length;
}

export async function handleCleanupStaleRides(io?: Server) {
  return async (job: any) => {
    try {
      // Demand heatmap retention: purge rider_activity rows beyond the
      // (window + buffer) horizon every 5 minutes.
      await sweepExpiredActivity();

      const resolvedCount = await sweepStaleActiveRides(io ?? null);

      const driverIds = await redis.zrange(DRIVER_LOCATIONS_KEY, 0, -1);
      let ghostCount = 0;
      for (const id of driverIds) {
        const heartbeat = await redis.get(`${DRIVER_HEARTBEAT_PREFIX}${id}`);
        if (!heartbeat) {
          await redis.zrem(DRIVER_LOCATIONS_KEY, id);
          ghostCount++;
        }
      }

      if (resolvedCount > 0 || ghostCount > 0) {
        console.log(`[CLEANUP] Resolved ${resolvedCount} stale rides, removed ${ghostCount} ghost drivers`);
      }
    } catch (err: any) {
      console.error('[CLEANUP] Maintenance failed:', err.message);
    }
  };
}
