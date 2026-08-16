"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.matchingService = void 0;
const dispatch_engine_service_1 = require("./dispatch-engine.service");
const ride_repository_1 = require("../modules/ride/ride.repository");
const types_1 = require("../types");
const metrics_1 = require("../observability/metrics");
const MAX_MATCH_RETRIES = 6;
const RETRY_INTERVAL_MS = 30000;
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
exports.matchingService = {
    /**
     * Dispatches a REQUESTED ride to the best eligible drivers, in-process.
     * Mirrors the semantics of the queue handler (matchRide.ts): status guard,
     * ride lock, staged radius search, sequential one-at-a-time offers, and
     * cancellation when no driver accepts after the retry budget.
     */
    async findAndDispatch(io, tripId, pickupLat, pickupLng, riderId, favoritePriority = false) {
        const currentTrip = await ride_repository_1.RideRepository.findById(tripId);
        if (!currentTrip || currentTrip.status !== types_1.TripStatus.REQUESTED) {
            console.log(`[MATCH] Skipping trip ${tripId} — status=${currentTrip?.status}`);
            metrics_1.matchJobsTotal.inc({ outcome: 'skipped' });
            return;
        }
        for (let retry = 0; retry <= MAX_MATCH_RETRIES; retry++) {
            if (retry > 0)
                await sleep(RETRY_INTERVAL_MS);
            // Re-acquire per attempt: the lock TTL (120s) can expire while a
            // previous attempt was still working offers, so a fresh attempt must
            // re-arm it or a second matcher could start dispatching the same ride.
            const lockAcquired = await dispatch_engine_service_1.DispatchEngine.acquireRideLock(tripId);
            if (!lockAcquired) {
                console.log(`[MATCH] Ride ${tripId} already being matched by another worker`);
                metrics_1.matchJobsTotal.inc({ outcome: 'locked' });
                return;
            }
            try {
                const result = await dispatch_engine_service_1.DispatchEngine.executeMatching(io, tripId, pickupLat, pickupLng, riderId, favoritePriority);
                if (result !== 'failed') {
                    // 'assigned' | 'cancelled'
                    metrics_1.matchJobsTotal.inc({ outcome: result });
                    return;
                }
                console.log(`[MATCH] No drivers accepted, retry ${retry + 1}/${MAX_MATCH_RETRIES} for trip ${tripId}`);
            }
            finally {
                await dispatch_engine_service_1.DispatchEngine.releaseRideLock(tripId);
            }
        }
        const trip = await ride_repository_1.RideRepository.findById(tripId);
        if (trip && trip.status === types_1.TripStatus.REQUESTED) {
            await ride_repository_1.RideRepository.updateStatus(tripId, types_1.TripStatus.CANCELLED);
            io.to(`rider:${trip.rider_id}`).emit('tripUpdate', {
                ...trip,
                status: types_1.TripStatus.CANCELLED,
                cancelReason: 'No drivers available after extended search',
            });
            io.to('monitoring:all_rides').emit('tripUpdate', {
                ...trip,
                status: types_1.TripStatus.CANCELLED,
            });
            console.log(`[MATCH] No drivers after ${MAX_MATCH_RETRIES} retries, cancelling ${tripId}`);
            metrics_1.matchJobsTotal.inc({ outcome: 'no_drivers' });
        }
    },
};
//# sourceMappingURL=matching.service.js.map