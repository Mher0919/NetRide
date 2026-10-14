import { Server } from 'socket.io';
import { prisma } from '../../services/prisma.service';
import { TripStatus } from '../../types';
import { redis, DRIVER_LOCATIONS_KEY, DRIVER_HEARTBEAT_PREFIX } from '../../config/redis';
import { LocationsService } from '../../modules/location/locations.service';
import { sweepExpiredActivity } from '../../services/demand.service';
import { env } from '../../config/env';
import { lifecycleEventsTotal } from '../../observability/metrics';

/**
 * Candidate predicates for the stale-ride watchdog. Exported as pure
 * functions so the exact scope of each sweep (in particular the scheduled
 * ride exclusion) is unit-tested — a previous version cancelled future
 * scheduled rides because the REQUESTED sweep had no `is_scheduled` guard.
 *
 * The predicates only select candidates. The cancel itself re-verifies the
 * same age/state conditions atomically inside the UPDATE (see
 * `RideService.cancelTripSystem({ guard })`) so a ride that starts or
 * completes between the query and the write is never clobbered.
 */
export function buildStaleRequestedWhere(cutoff: Date) {
  return {
    status: 'REQUESTED' as const,
    created_at: { lt: cutoff },
    OR: [
      { is_scheduled: false },
      { is_scheduled: null },
      // A scheduled ride is only stale once its pickup time has passed the
      // same cutoff (its activation/dispatch window has long elapsed).
      { scheduled_at: { lt: cutoff } },
    ],
  };
}

export function buildNeverStartedWhere(cutoff: Date) {
  return {
    status: { in: [TripStatus.ACCEPTED, TripStatus.DRIVER_ARRIVING] },
    started_at: null,
    accepted_at: { lt: cutoff },
  };
}

export function buildOverdueWhere(cutoff: Date) {
  return {
    status: { in: [TripStatus.DRIVER_ARRIVING, TripStatus.IN_PROGRESS] },
    // Anchor only on the actual journey start. A long pre-pickup wait is
    // handled by `buildNeverStartedWhere`; anchoring class 3 on
    // `accepted_at` could cancel a legitimate in-progress trip.
    started_at: { lt: cutoff },
  };
}

/**
 * Resolve rides that are stuck in a non-terminal state without any hope of
 * proceeding — the production-grade watchdog every rideshare app needs.
 * Without this, a driver who kills the app mid-trip (or never picks up the
 * rider) leaves the ride "active" in the DB forever, and every subsequent
 * app launch re-attaches to it via getCurrentTrip.
 *
 * Three classes are swept:
 *   1. REQUESTED rides older than 10 minutes (no driver ever accepted) —
 *      excluding future scheduled rides.
 *   2. ACCEPTED / DRIVER_ARRIVING rides where the driver never started the
 *      ride within RIDE_ACCEPT_STALL_S of acceptance.
 *   3. IN_PROGRESS / DRIVER_ARRIVING rides whose actual journey started
 *      more than RIDE_MAX_DURATION_S ago.
 *
 * All sweeps are idempotent, re-verify their predicate atomically, and
 * broadcast the authoritative CANCELLED tripUpdate to rider + driver +
 * admin monitoring, so every client settles back to idle at the same
 * instant.
 */
export async function sweepStaleActiveRides(io: Server | null): Promise<number> {
  const resolved: string[] = [];

  // ---- 1. REQUESTED: no driver accepted within 10 minutes ----------------
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
  const staleRides = await prisma.ride.findMany({
    where: buildStaleRequestedWhere(tenMinutesAgo),
    select: { id: true },
    take: env.RIDE_STALL_SWEEP_BATCH,
  });

  // RideService is imported lazily: applying it statically would drag the
  // whole app.ts graph (incl. the HTTP listener) into the cron worker
  // process at startup, which previously caused EADDRINUSE crashes.
  const { RideService } = await import('../../modules/ride/ride.service');

  for (const ride of staleRides) {
    try {
      const result = await RideService.cancelTripSystem(ride.id, {
        reasonText: 'Request timed out (no driver accepted after extended search)',
        guard: {
          statuses: [TripStatus.REQUESTED],
          beforeColumn: 'created_at',
          before: tenMinutesAgo,
          requireNotScheduledBefore: tenMinutesAgo,
        },
      });
      if (result?.status === TripStatus.CANCELLED) {
        resolved.push(ride.id);
        lifecycleEventsTotal.inc({ event: 'stale_ride_cancelled' });
      }
    } catch (err: any) {
      console.error(`[CLEANUP] ⚠️ Failed to cancel stale REQUESTED ride ${ride.id}: ${err.message}`);
    }
  }

  // ---- 2. Accepted rides never started: RIDE_ACCEPT_STALL_S --------------
  const acceptStallCutoff = new Date(Date.now() - env.RIDE_ACCEPT_STALL_S * 1000);
  const neverStarted = await prisma.ride.findMany({
    where: buildNeverStartedWhere(acceptStallCutoff),
    select: { id: true },
    take: env.RIDE_STALL_SWEEP_BATCH,
  });

  for (const ride of neverStarted) {
    try {
      const result = await RideService.cancelTripSystem(ride.id, {
        reasonText: `Driver did not start the ride within ${Math.round(env.RIDE_ACCEPT_STALL_S / 60)} minutes of acceptance (abandoned pickup).`,
        guard: {
          statuses: [TripStatus.ACCEPTED, TripStatus.DRIVER_ARRIVING],
          beforeColumn: 'accepted_at',
          before: acceptStallCutoff,
          requireStartedAtNull: true,
        },
      });
      if (result?.status === TripStatus.CANCELLED) {
        resolved.push(ride.id);
        lifecycleEventsTotal.inc({ event: 'stale_ride_cancelled' });
      }
    } catch (err: any) {
      console.error(`[CLEANUP] ⚠️ Failed to resolve never-started ride ${ride.id}: ${err.message}`);
    }
  }

  // ---- 3. Active rides over the maximum journey duration -----------------
  const maxDurationCutoff = new Date(Date.now() - env.RIDE_MAX_DURATION_S * 1000);
  const overdue = await prisma.ride.findMany({
    where: buildOverdueWhere(maxDurationCutoff),
    select: { id: true },
    take: env.RIDE_STALL_SWEEP_BATCH,
  });

  for (const ride of overdue) {
    try {
      const result = await RideService.cancelTripSystem(ride.id, {
        reasonText: `Ride exceeded the maximum duration of ${Math.round(env.RIDE_MAX_DURATION_S / 3600)}h without completion — resolved by the system.`,
        guard: {
          statuses: [TripStatus.DRIVER_ARRIVING, TripStatus.IN_PROGRESS],
          beforeColumn: 'started_at',
          before: maxDurationCutoff,
        },
      });
      if (result?.status === TripStatus.CANCELLED) {
        resolved.push(ride.id);
        lifecycleEventsTotal.inc({ event: 'stale_ride_cancelled' });
      }
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
        if (heartbeat) continue;
        // A live availability lease or an accepted trip means "interrupted,
        // not gone" — keep the last-known fix rather than erasing it.
        const lease = await redis.get(`driver:online:${id}`);
        if (lease) continue;
        const activeTrip = await redis.get(`driver:${id}:active_trip`);
        if (activeTrip) continue;
        await LocationsService.removeDriverLocation(id);
        ghostCount++;
        lifecycleEventsTotal.inc({ event: 'ghost_driver_removed' });
      }

      if (resolvedCount > 0 || ghostCount > 0) {
        console.log(`[CLEANUP] Resolved ${resolvedCount} stale rides, removed ${ghostCount} ghost drivers`);
      }
    } catch (err: any) {
      console.error('[CLEANUP] Maintenance failed:', err.message);
    }
  };
}
