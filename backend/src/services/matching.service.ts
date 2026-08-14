// backend/src/services/matching.service.ts
//
// IN-PROCESS RIDE MATCHING (LEGACY_SYNC_MATCHING = true)
// ---------------------------------------------------------------------------
// Environments that run ONLY the API process (no BullMQ match-worker) dispatch
// rides synchronously inside the API process. This module re-establishes that
// architecture after it was removed: matching jobs now always go to the
// BullMQ queue, and without a worker running they sat in `match-ride` forever
// — riders requested, drivers never received `newTripRequest`.
//
// The implementation REUSES the modern dispatch pipeline (DispatchEngine +
// DriverOfferService) so offer payloads, accept/decline contracts, driver
// earnings, and the accept-race semantics are identical to worker dispatch —
// only the execution context differs (in-process vs. queue worker).
//
// Production (start.sh) runs the match-worker as a separate process and sets
// LEGACY_SYNC_MATCHING=false, so this module is inert there.

import { Server } from 'socket.io';
import { DispatchEngine } from './dispatch-engine.service';
import { RideRepository } from '../modules/ride/ride.repository';
import { TripStatus } from '../types';
import { matchJobsTotal } from '../observability/metrics';

const MAX_MATCH_RETRIES = 6;
const RETRY_INTERVAL_MS = 30000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const matchingService = {
  /**
   * Dispatches a REQUESTED ride to the best eligible drivers, in-process.
   * Mirrors the semantics of the queue handler (matchRide.ts): status guard,
   * ride lock, staged radius search, sequential one-at-a-time offers, and
   * cancellation when no driver accepts after the retry budget.
   */
  async findAndDispatch(
    io: Server,
    tripId: string,
    pickupLat: number,
    pickupLng: number,
    riderId?: string,
    favoritePriority: boolean = false,
  ): Promise<void> {
    const currentTrip = await RideRepository.findById(tripId);
    if (!currentTrip || currentTrip.status !== TripStatus.REQUESTED) {
      console.log(`[MATCH] Skipping trip ${tripId} — status=${currentTrip?.status}`);
      matchJobsTotal.inc({ outcome: 'skipped' });
      return;
    }

    for (let retry = 0; retry <= MAX_MATCH_RETRIES; retry++) {
      if (retry > 0) await sleep(RETRY_INTERVAL_MS);

      // Re-acquire per attempt: the lock TTL (120s) can expire while a
      // previous attempt was still working offers, so a fresh attempt must
      // re-arm it or a second matcher could start dispatching the same ride.
      const lockAcquired = await DispatchEngine.acquireRideLock(tripId);
      if (!lockAcquired) {
        console.log(`[MATCH] Ride ${tripId} already being matched by another worker`);
        matchJobsTotal.inc({ outcome: 'locked' });
        return;
      }

      try {
        const result = await DispatchEngine.executeMatching(
          io,
          tripId,
          pickupLat,
          pickupLng,
          riderId,
          favoritePriority,
        );
        if (result !== 'failed') {
          // 'assigned' | 'cancelled'
          matchJobsTotal.inc({ outcome: result });
          return;
        }
        console.log(`[MATCH] No drivers accepted, retry ${retry + 1}/${MAX_MATCH_RETRIES} for trip ${tripId}`);
      } finally {
        await DispatchEngine.releaseRideLock(tripId);
      }
    }

    const trip = await RideRepository.findById(tripId);
    if (trip && trip.status === TripStatus.REQUESTED) {
      await RideRepository.updateStatus(tripId, TripStatus.CANCELLED);
      io.to(`rider:${trip.rider_id}`).emit('tripUpdate', {
        ...trip,
        status: TripStatus.CANCELLED,
        cancelReason: 'No drivers available after extended search',
      });
      io.to('monitoring:all_rides').emit('tripUpdate', {
        ...trip,
        status: TripStatus.CANCELLED,
      });
      console.log(`[MATCH] No drivers after ${MAX_MATCH_RETRIES} retries, cancelling ${tripId}`);
      matchJobsTotal.inc({ outcome: 'no_drivers' });
    }
  },
};
