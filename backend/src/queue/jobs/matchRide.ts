import { Server } from 'socket.io';
import { DispatchEngine } from '../../services/dispatch-engine.service';
import { RideRepository } from '../../modules/ride/ride.repository';
import { TripStatus } from '../../types';
import { matchJobsTotal } from '../../observability/metrics';

interface MatchRideJobData {
  tripId: string;
  pickupLat: number;
  pickupLng: number;
  riderId?: string;
  favoritePriority?: boolean;
  retryCount?: number;
  resumeStage?: number;
  resumeCandidateIndex?: number;
  resumeAttemptCount?: number;
}

const MAX_MATCH_RETRIES = 6;
const RETRY_INTERVAL_MS = 30000;

export async function handleMatchRide(io: Server) {
  return async (job: any) => {
    const startTime = Date.now();
    const data: MatchRideJobData = job.data;
    const retryCount = data.retryCount ?? 0;

    try {
      const currentTrip = await RideRepository.findById(data.tripId);
      if (!currentTrip || currentTrip.status !== TripStatus.REQUESTED) {
        console.log(`[MATCH] Skipping trip ${data.tripId} — status=${currentTrip?.status}`);
        matchJobsTotal.inc({ outcome: 'skipped' });
        return;
      }

      const lockAcquired = await DispatchEngine.acquireRideLock(data.tripId);
      if (!lockAcquired) {
        console.log(`[MATCH] Ride ${data.tripId} already being matched by another worker`);
        matchJobsTotal.inc({ outcome: 'locked' });
        return;
      }

      try {
        const resumeFrom = data.resumeStage !== undefined ? {
          stage: data.resumeStage!,
          candidateIndex: data.resumeCandidateIndex ?? 0,
          attemptCount: data.resumeAttemptCount ?? 0,
        } : undefined;

        const result = await DispatchEngine.executeMatching(
          io,
          data.tripId,
          data.pickupLat,
          data.pickupLng,
          data.riderId,
          data.favoritePriority ?? false,
          resumeFrom,
        );

        if (result === 'failed') {
          if (retryCount < MAX_MATCH_RETRIES) {
            console.log(`[MATCH] No drivers, retry ${retryCount + 1}/${MAX_MATCH_RETRIES} for trip ${data.tripId}`);
            const { matchQueue } = await import('../../queue/queue');
            await matchQueue.add('matchRide', {
              ...data,
              retryCount: retryCount + 1,
            }, { delay: RETRY_INTERVAL_MS });
            matchJobsTotal.inc({ outcome: 'retry_no_drivers' });
          } else {
            const trip = await RideRepository.findById(data.tripId);
            if (trip && trip.status === TripStatus.REQUESTED) {
              await RideRepository.updateStatus(data.tripId, TripStatus.CANCELLED);
              io.to(`rider:${trip.rider_id}`).emit('tripUpdate', {
                ...trip,
                status: TripStatus.CANCELLED,
                cancelReason: 'No drivers available after extended search',
              });
              io.to('monitoring:all_rides').emit('tripUpdate', { ...trip, status: TripStatus.CANCELLED });
            }
            console.log(`[MATCH] No drivers after ${MAX_MATCH_RETRIES} retries, cancelling ${data.tripId}`);
            matchJobsTotal.inc({ outcome: 'no_drivers' });
          }
        } else if (result === 'cancelled') {
          console.log(`[MATCH] Ride ${data.tripId} was cancelled during matching`);
          matchJobsTotal.inc({ outcome: 'cancelled' });
        }
      } finally {
        await DispatchEngine.releaseRideLock(data.tripId);
      }

      matchJobsTotal.inc({ outcome: 'completed' });
    } catch (err: any) {
      console.error(`[MATCH] Match job failed for trip ${data.tripId}:`, err.message);
      matchJobsTotal.inc({ outcome: 'failed' });
      await DispatchEngine.releaseRideLock(data.tripId);
      throw err;
    }
  };
}
