import { Server } from 'socket.io';
import { DispatchService } from '../../services/dispatch.service';
import { env } from '../../config/env';
import { redis } from '../../config/redis';
import { RideRepository } from '../../modules/ride/ride.repository';
import { TripStatus, VehicleClass } from '../../types';
import { matchJobsTotal, matchJobDurationSeconds, dispatchFanoutSize } from '../../observability/metrics';
import { dispatchQueue, matchQueue } from '../queue';

const MAX_MATCH_RETRIES = 6;
const RETRY_INTERVAL_MS = 30_000; // 30 seconds between retries

interface MatchRideJobData {
  tripId: string;
  pickupLat: number;
  pickupLng: number;
  requestedClass: VehicleClass;
  riderId?: string;
  retryCount?: number;
}

export async function handleMatchRide(io: Server) {
  return async (job: any) => {
    const startTime = Date.now();
    const data: MatchRideJobData = job.data;
    const retryCount = data.retryCount ?? 0;

    try {
      console.log(`[MATCH] 🔍 Processing match job ${job.id} for trip ${data.tripId} (attempt ${retryCount + 1}) at (${data.pickupLat}, ${data.pickupLng})`);

      // Bail if the trip was already accepted/cancelled
      const currentTrip = await RideRepository.findById(data.tripId);
      if (!currentTrip || currentTrip.status !== 'REQUESTED') {
        console.log(`[MATCH] ⏭️ Skipping trip ${data.tripId} — status=${currentTrip?.status}`);
        matchJobsTotal.inc({ outcome: 'skipped' });
        return;
      }

      const drivers = await DispatchService.getWeightedDrivers(
        { lat: data.pickupLat, lng: data.pickupLng },
        data.requestedClass,
        env.DRIVER_MATCH_RADIUS_KM || 10,
        data.riderId
      );

      console.log(`[MATCH] Found ${drivers.length} driver(s) for trip ${data.tripId} in ${Date.now() - startTime}ms`);

      if (drivers.length === 0) {
        if (retryCount < MAX_MATCH_RETRIES) {
          console.log(`[MATCH] ⏳ No drivers online, retry ${retryCount + 1}/${MAX_MATCH_RETRIES} in ${RETRY_INTERVAL_MS / 1000}s for trip ${data.tripId}`);
          await matchQueue.add(
            'matchRide',
            { ...data, retryCount: retryCount + 1 },
            { delay: RETRY_INTERVAL_MS }
          );
          matchJobsTotal.inc({ outcome: 'retry_no_drivers' });
        } else {
          // Exhausted retries — cancel the ride
          const trip = await RideRepository.findById(data.tripId);
          if (trip && trip.status === 'REQUESTED') {
            await RideRepository.updateStatus(data.tripId, TripStatus.CANCELLED);
            io.to(`rider:${trip.rider_id}`).emit('tripUpdate', {
              ...trip,
              status: TripStatus.CANCELLED,
              cancelReason: 'No drivers available after extended search',
            });
            io.to('monitoring:all_rides').emit('tripUpdate', { ...trip, status: TripStatus.CANCELLED });
          }
          console.log(`[MATCH] ❌ No drivers found after ${MAX_MATCH_RETRIES} retries, cancelling trip ${data.tripId}`);
          matchJobsTotal.inc({ outcome: 'no_drivers' });
        }
        return;
      }

      const fanoutSize = Math.min(drivers.length, env.DISPATCH_FANOUT_SIZE);
      const topDrivers = drivers.slice(0, fanoutSize);
      dispatchFanoutSize.observe(fanoutSize);

      await dispatchQueue.add('dispatchOffers', {
        tripId: data.tripId,
        drivers: topDrivers,
        pickupLat: data.pickupLat,
        pickupLng: data.pickupLng,
      });

      await redis.setex(
        `match:queue:dispatched:${data.tripId}`,
        300,
        JSON.stringify({ drivers: topDrivers.map(d => d.id), retryCount })
      );

      matchJobsTotal.inc({ outcome: 'enqueued' });
    } catch (err: any) {
      console.error(`[MATCH] ❌ Match job failed for trip ${data.tripId}:`, err.message);
      matchJobsTotal.inc({ outcome: 'failed' });
      throw err;
    } finally {
      matchJobDurationSeconds.observe(Date.now() - startTime);
    }
  };
}
