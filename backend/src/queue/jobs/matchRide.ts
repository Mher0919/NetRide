import { Server } from 'socket.io';
import { DispatchService } from '../../services/dispatch.service';
import { env } from '../../config/env';
import { redis } from '../../config/redis';
import { RideRepository } from '../../modules/ride/ride.repository';
import { TripStatus, VehicleClass } from '../../types';
import { matchJobsTotal, matchJobDurationSeconds, dispatchFanoutSize } from '../../observability/metrics';
import { dispatchQueue } from '../queue';

interface MatchRideJobData {
  tripId: string;
  pickupLat: number;
  pickupLng: number;
  requestedClass: VehicleClass;
  riderId?: string;
}

export async function handleMatchRide(io: Server) {
  return async (job: any) => {
    const startTime = Date.now();
    const data: MatchRideJobData = job.data;

    try {
      const drivers = await DispatchService.getWeightedDrivers(
        { lat: data.pickupLat, lng: data.pickupLng },
        data.requestedClass,
        env.DRIVER_MATCH_RADIUS_KM || 10,
        data.riderId
      );

      if (drivers.length === 0) {
        const trip = await RideRepository.findById(data.tripId);
        if (trip && !(trip as any).is_scheduled) {
          await RideRepository.updateStatus(data.tripId, TripStatus.CANCELLED);
          io.to(`rider:${trip.rider_id}`).emit('tripUpdate', {
            ...trip,
            status: TripStatus.CANCELLED,
            cancelReason: 'No drivers available in this class',
          });
        }
        matchJobsTotal.inc({ outcome: 'no_drivers' });
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
        JSON.stringify(topDrivers.map(d => d.id))
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
