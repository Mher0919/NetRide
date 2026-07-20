// backend/src/modules/ride/ride.service.ts
console.log('[SVC_INIT] ride.service.ts loaded at', new Date().toISOString());
import { RideRepository } from './ride.repository';
console.log('[SVC_INIT] FULL findCurrentByDriverId toString:\n' + (RideRepository?.findCurrentByDriverId?.toString() || 'undefined'));
import { LocationsService } from '../location/locations.service';
import { GeospatialService } from '../geospatial/geospatial.service';
import { Trip, Location, UserRole, VehicleClass, TripStatus } from '../../types';
import { env } from '../../config/env';
import { io } from '../../app';
import { pool } from '../../config/database';
import { redis } from '../../config/redis';
import { fareService } from '../../services/fare.service';
import { NavigationService } from '../../services/navigation.service';
import { SpeedingDetector } from '../../services/speeding_detector';
import { DriverService } from '../driver/driver.service';
import { areBothTestUsers } from '../../utils/testUser';
import { matchQueue } from '../../queue/queue';
import { matchJobsTotal, dispatchAcceptOutcomeTotal } from '../../observability/metrics';

export class RideService {
  static async rateRide(data: {
    ride_id: string;
    rater_id: string;
    rating: number;
    review_text?: string;
  }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Check Ride
      const rideRes = await client.query('SELECT * FROM rides WHERE id = $1', [data.ride_id]);
      const ride = rideRes.rows[0];

      if (!ride) throw new Error('Ride not found');
      if (ride.status !== 'COMPLETED') throw new Error('Ride is not completed');

      // Determine roles
      let target_id: string;
      let target_role: string;

      if (ride.rider_id === data.rater_id) {
        // Rider is rating Driver
        if (!ride.driver_id) throw new Error('No driver assigned to this ride');
        target_id = ride.driver_id;
        target_role = 'DRIVER';
      } else if (ride.driver_id === data.rater_id) {
        // Driver is rating Rider
        target_id = ride.rider_id;
        target_role = 'RIDER';
      } else {
        throw new Error('Unauthorized');
      }

      // 2. Check if already rated by this person for this ride
      const existingRating = await client.query(
        'SELECT id FROM ratings WHERE ride_id = $1 AND rater_id = $2',
        [data.ride_id, data.rater_id]
      );
      if (existingRating.rows.length > 0) throw new Error('You have already rated this ride');

      // 3. Create Rating
      // Flag for admin review when a low rating (<3) is left with a note.
      const flagged = data.rating < 3 && !!data.review_text && String(data.review_text).trim().length > 0;
      const ratingRes = await client.query(
        `INSERT INTO ratings (ride_id, rater_id, target_id, target_role, rating, review_text, flagged_for_review)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [data.ride_id, data.rater_id, target_id, target_role, data.rating, data.review_text, flagged]
      );

      // 4. Update Target Rating (Moving Average of last 100)
      const lastRatings = await client.query(
        `SELECT rating FROM ratings WHERE target_id = $1 ORDER BY created_at DESC LIMIT 100`,
        [target_id]
      );

      const totalRatingsCount = parseInt((await client.query(
        'SELECT COUNT(*) FROM ratings WHERE target_id = $1',
        [target_id]
      )).rows[0].count);

      let newRating = 5.0;
      if (totalRatingsCount >= 100) {
        const sum = lastRatings.rows.reduce((acc: number, curr: any) => acc + curr.rating, 0);
        newRating = parseFloat((sum / lastRatings.rows.length).toFixed(1));
      }

      // Update User table rating for everyone
      await client.query(
        'UPDATE users SET rating = $1, rating_count = $2 WHERE id = $3',
        [newRating, totalRatingsCount, target_id]
      );

      // If target is a driver, also update drivers table for redundancy/legacy compatibility
      if (target_role === 'DRIVER') {
        await client.query(
          'UPDATE drivers SET rating = $1, total_rides = total_rides + 1 WHERE user_id = $2',
          [newRating, target_id]
        );
      }

      await client.query('COMMIT');
      return ratingRes.rows[0];
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  static async requestRide(
    riderId: string, 
    pickup: Location & { address: string }, 
    destination: Location & { address: string },
    requestedClass: VehicleClass = VehicleClass.CORE,
    scheduledAt?: Date,
    isScheduled: boolean = false
  ): Promise<Trip> {
    console.log(`[RIDE] New request from rider ${riderId} for class ${requestedClass}${isScheduled ? ' [SCHEDULED]' : ''}. Pickup: ${pickup.lat}, ${pickup.lng}`);
    
    // Snapshot rider rating
    const riderRes = await pool.query('SELECT rating FROM users WHERE id = $1', [riderId]);
    const snapshotRating = riderRes.rows[0]?.rating || 5.0;

    // Get Route
    const route = await GeospatialService.getRoute(
      [pickup.lat, pickup.lng],
      [destination.lat, destination.lng]
    ).catch(() => null);

    const distanceKm = route ? (route.distance / 1000) : 10.0;
    const etaSeconds = route ? route.eta : 600;

    // Calculate maximum fare and saving likelihood
    const estimate = await fareService.calculateRiderPriceEstimate(
      pickup.lat,
      pickup.lng,
      requestedClass,
      distanceKm
    );

    // Use a transactional insert for safety
    const res = await pool.query(
      `INSERT INTO rides (
        rider_id, status, pickup_lat, pickup_lng, pickup_address,
        destination_lat, destination_lng, destination_address,
        requested_class, snapshot_rider_rating, scheduled_at, is_scheduled,
        distance_meters, duration_seconds, initial_max_fare, saving_likelihood
      )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING *`,
      [
        riderId,
        TripStatus.REQUESTED,
        pickup.lat,
        pickup.lng,
        pickup.address,
        destination.lat,
        destination.lng,
        destination.address,
        requestedClass || 'CORE',
        snapshotRating,
        scheduledAt || null,
        isScheduled,
        route ? Math.round(route.distance) : null,
        etaSeconds,
        estimate.maxFare,
        estimate.savingLikelihood
      ]
    );

    const trip = await RideRepository.findById(res.rows[0].id);
    if (!trip) throw new Error('Failed to create trip record');

    if (route) {
      (trip as any).route_geometry = route.geometry;
    }

    // Trigger Matching ONLY if it's NOT a future scheduled ride 
    // or if scheduledAt is within the next 15 minutes.
    const isNow = !isScheduled || (scheduledAt && (scheduledAt.getTime() - Date.now() < 15 * 60 * 1000));

    if (isNow) {
      if (env.LEGACY_SYNC_MATCHING) {
        import('../../services/matching.service').then(({ matchingService }) => {
          matchingService.findAndDispatch(io, trip.id, pickup.lat, pickup.lng, requestedClass, riderId);
        });
      } else {
        matchQueue.add('matchRide', {
          tripId: trip.id,
          pickupLat: pickup.lat,
          pickupLng: pickup.lng,
          requestedClass,
          riderId,
        }).catch((err) => console.error('[RIDE] Failed to enqueue match job:', err.message));
        matchJobsTotal.inc({ outcome: 'enqueued' });
      }
    }

    // Update Redis Demand
    redis.incr(`demand:count:${requestedClass}`).then(() => {
      redis.expire(`demand:count:${requestedClass}`, 600);
    });

    return trip;
  }

  static async acceptTrip(tripId: string, driverId: string): Promise<Trip> {
    const trip = await RideRepository.findById(tripId);
    if (!trip) throw new Error('Trip not found');
    if (trip.status !== 'REQUESTED') throw new Error('Trip already taken or cancelled');

    // Security: Ensure driver doesn't have another active trip. A stale
    // Redis key from a prior run (e.g. previous smoke test that crashed
    // before pickup) would otherwise block this driver permanently.
    const activeTripId = await redis.get(`driver:${driverId}:active_trip`);
    if (activeTripId) {
      // If the cached trip is already terminal (COMPLETED/CANCELLED) in
      // Postgres, the key is stale — drop it and continue. Otherwise the
      // driver genuinely has an active trip in progress and we must refuse.
      const activeTrip = await RideRepository.findById(activeTripId);
      if (!activeTrip || activeTrip.status === 'COMPLETED' || activeTrip.status === 'CANCELLED') {
        console.log(`[RIDE] 🧹 Clearing stale active_trip key for driver ${driverId} (was ${activeTripId}, status=${activeTrip?.status})`);
        await redis.del(`driver:${driverId}:active_trip`);
      } else {
        throw new Error('You already have an active trip. Complete it before accepting another.');
      }
    }

    // Fetch driver's chosen price_per_mile
    const driverPricing = await pool.query('SELECT price_per_mile FROM drivers WHERE user_id = $1', [driverId]);
    const driverPricePerMile = parseFloat(driverPricing.rows[0]?.price_per_mile || '2.00');

    // Distance in miles
    const distanceMiles = (trip.distance_km || 0) * 0.621371;
    const calculatedFare = Math.round(driverPricePerMile * distanceMiles * 100) / 100;
    
    // Final fare is the minimum of initial max fare and calculated driver fare
    const maxFare = parseFloat((trip as any).initial_max_fare || '999');
    const finalFare = Math.min(maxFare, Math.max(5.00, calculatedFare));

    // Capture Compliance Snapshot
    const driverProfile = await pool.query(
      `SELECT d.*, dv.inspection_photo_url, dv.inspection_expiry_date, dv.inspection_status, dv.license_plate_number
       FROM drivers d
       LEFT JOIN driver_vehicles dv ON d.user_id = dv.driver_id
       WHERE d.user_id = $1`,
      [driverId]
    );
    const d = driverProfile.rows[0];
    const complianceSnapshot = {
      license_number: d?.license_number,
      license_expiry: d?.license_expiry_date,
      license_photo: d?.license_photo_url,
      insurance_photo: d?.insurance_photo_url,
      registration_photo: d?.registration_photo_url,
      inspection_photo: d?.inspection_photo_url,
      inspection_expiry: d?.inspection_expiry_date,
      inspection_status: d?.inspection_status,
      vehicle_plate: d?.license_plate_number,
      captured_at: new Date().toISOString()
    };

    const updatedTrip = await RideRepository.updateStatus(tripId, 'ACCEPTED' as any, {
      driver_id: driverId,
      accepted_at: new Date(),
      compliance_snapshot: JSON.stringify(complianceSnapshot),
      fare_amount: finalFare
    });

    // Cache active trip for trajectory buffering
    await redis.set(`driver:${driverId}:active_trip`, tripId, 'EX', 14400); // 4h safety TTL

    // Step 4: Parallel fan-out — record winner and cancel other offers
    await redis.set(`dispatch:winners:${tripId}`, driverId, 'EX', 300);
    const dispatchedJson = await redis.get(`match:queue:dispatched:${tripId}`);
    if (dispatchedJson) {
      const dispatchedDrivers: string[] = JSON.parse(dispatchedJson);
      for (const did of dispatchedDrivers) {
        if (did !== driverId) {
          io.to(`driver:${did}`).emit('tripUpdate', {
            ...trip,
            status: TripStatus.CANCELLED,
            cancelReason: 'Another driver accepted this trip',
          });
          dispatchAcceptOutcomeTotal.inc({ outcome: 'cancelled' });
        }
      }
      await redis.del(`match:queue:dispatched:${tripId}`);
    }
    await redis.del(`dispatch:lock:${tripId}`);

    const driverLoc = await LocationsService.getDriverLocation(driverId);
    (updatedTrip as any).driver_location = driverLoc;

    // Navigation cache + route_metadata for the pickup leg. We resolve
    // the route via the routing service, cache it for the speeding detector + driver
    // app, persist a snapshot on the ride, and emit the start event.
    if (driverLoc) {
      try {
        const pickupRoute = await NavigationService.cacheRouteLeg(
          tripId,
          'pickup',
          [driverLoc.lat, driverLoc.lng],
          [trip.pickup.lat, trip.pickup.lng]
        );
        await pool.query(
          `UPDATE rides SET route_metadata = route_metadata || $1::jsonb WHERE id = $2`,
          [JSON.stringify({ pickup: pickupRoute }), tripId]
        );
        NavigationService.emitStarted(
          io, tripId, driverId, trip.rider_id, 'pickup', pickupRoute
        );
      } catch (err: any) {
        console.error(`[RIDE] ⚠️ pickup route cache failed: ${err.message}`);
      }
    }

    io.to(`rider:${trip.rider_id}`).emit('tripUpdate', updatedTrip);
    io.to(`driver:${driverId}`).emit('tripUpdate', updatedTrip);
    dispatchAcceptOutcomeTotal.inc({ outcome: 'accepted' });

    // Broadcast to Admin Monitoring
    io.to('monitoring:all_rides').emit('tripUpdate', updatedTrip);

    return updatedTrip;
  }

  static async updateTripStatus(tripId: string, status: any, userId: string): Promise<Trip> {
    const trip = await RideRepository.findById(tripId);
    if (!trip) throw new Error('Trip not found');

    console.log(`[RIDE] updateTripStatus: tripId=${tripId} status=${status} userId=${userId} trip.driver_id=${trip.driver_id} match=${trip.driver_id === userId}`);

    // Security: Only the assigned driver can update progress
    if (trip.driver_id !== userId) {
      throw new Error('Unauthorized: You are not the assigned driver for this trip');
    }

    const extra: any = {};
    if (status === 'IN_PROGRESS') extra.started_at = new Date();

    if (status === 'COMPLETED') {
      extra.completed_at = new Date();

      // Retrieve and persist trajectory
      const trajectory = await LocationsService.getTrajectory(tripId);
      extra.trajectory = JSON.stringify(trajectory);

      // Clear active trip cache
      await redis.del(`driver:${userId}:active_trip`);
      await LocationsService.clearTrajectory(tripId);
      await NavigationService.clearTrip(tripId);

      // TODO: Calculate distance/fare based on trajectory if needed
    }

    const updatedTrip = await RideRepository.updateStatus(tripId, status, extra);

    if (updatedTrip.driver_id) {
      const driverLoc = await LocationsService.getDriverLocation(updatedTrip.driver_id);
      (updatedTrip as any).driver_location = driverLoc;
    }

    // Navigation lifecycle: when the driver flips ACCEPTED → IN_PROGRESS
    // we cache the destination leg and emit legAdvanced so the rider
    // sees "now heading to destination" and the driver swaps route.
    if (status === 'IN_PROGRESS' && updatedTrip.driver_id) {
      try {
        const driverLoc = await LocationsService.getDriverLocation(userId);
        if (driverLoc) {
          const destRoute = await NavigationService.cacheRouteLeg(
            tripId,
            'destination',
            [driverLoc.lat, driverLoc.lng],
            [updatedTrip.destination.lat, updatedTrip.destination.lng]
          );
          await pool.query(
            `UPDATE rides SET route_metadata = route_metadata || $1::jsonb WHERE id = $2`,
            [JSON.stringify({ destination: destRoute }), tripId]
          );
          NavigationService.emitLegAdvanced(
            io, tripId, updatedTrip.driver_id, updatedTrip.rider_id, destRoute
          );
        }
      } catch (err: any) {
        console.error(`[RIDE] ⚠️ destination route cache failed: ${err.message}`);
      }
    }

    // Trip end: finalize the safety pipeline and notify navigation.
    if (status === 'COMPLETED' && updatedTrip.driver_id) {
      await SpeedingDetector.finalizeTrip(updatedTrip.driver_id, tripId);
      NavigationService.emitEnded(
        io, tripId, updatedTrip.driver_id, updatedTrip.rider_id
      );

      // Wallet credit: every completed ride deposits fare + tip into the
      // driver's wallet. Wrapped in try/catch so a wallet bug cannot block
      // the trip end / socket emit. Idempotent via partial UNIQUE INDEX on
      // payouts(ride_id) WHERE method='RIDE_CREDIT'.
      try {
        const fareCents = Math.round(
          parseFloat((updatedTrip as any).fare_amount ?? '0') * 100
        );
        const tipCents = Math.round(
          parseFloat((updatedTrip as any).tip_amount ?? '0') * 100
        );
        const totalCents = fareCents + tipCents;

        // Test-mode bypass: when both the rider and the driver are test
        // accounts, we still credit the driver wallet (so the test driver
        // grows their balance and the wallet math stays exercised) but
        // we skip anything rider-side that would require a real payment
        // method. The end result is the same as a normal completed ride,
        // just without a payment hold.
        const isTestTrip = await areBothTestUsers(
          updatedTrip.rider_id,
          updatedTrip.driver_id,
        );
        if (isTestTrip) {
          console.log(
            `[RIDE] 🧪 Test-mode: bypassed rider payment, auto-credited driver wallet (trip=${tripId}, $${(totalCents / 100).toFixed(2)})`,
          );
        }

        if (totalCents > 0) {
          await DriverService.creditOnRideComplete(
            updatedTrip.driver_id,
            totalCents,
            tripId
          );
        }
      } catch (err: any) {
        console.warn(
          `[RIDE] ⚠️ Wallet credit failed (non-blocking) for trip ${tripId}: ${err.message}`
        );
      }
    }

    io.to(`rider:${updatedTrip.rider_id}`).emit('tripUpdate', updatedTrip);
    if (updatedTrip.driver_id) {
      io.to(`driver:${updatedTrip.driver_id}`).emit('tripUpdate', updatedTrip);
    }

    // Broadcast to Admin Monitoring
    io.to('monitoring:all_rides').emit('tripUpdate', updatedTrip);

    return updatedTrip;
  }

  static async cancelTrip(tripId: string, userId: string): Promise<Trip> {
    const trip = await RideRepository.findById(tripId);
    if (!trip) throw new Error('Trip not found');

    // Security: Only the rider or the assigned driver can cancel
    if (trip.rider_id !== userId && trip.driver_id !== userId) {
      throw new Error('Unauthorized to cancel this trip');
    }

    const extra: any = { cancelled_at: new Date() };

    // If driver was assigned, cleanup trajectory
    if (trip.driver_id) {
      const trajectory = await LocationsService.getTrajectory(tripId);
      if (trajectory.length > 0) {
        extra.trajectory = JSON.stringify(trajectory);
      }
      await redis.del(`driver:${trip.driver_id}:active_trip`);
      await LocationsService.clearTrajectory(tripId);
      await NavigationService.clearTrip(tripId);
    }

    const updatedTrip = await RideRepository.updateStatus(tripId, 'CANCELLED' as any, extra);

    // Safety + navigation teardown on cancel. finalizeTrip is a no-op
    // if the trip had no violations, so it's safe to call on every
    // cancel path (driver cancels, rider cancels mid-ride, etc).
    if (trip.driver_id) {
      await SpeedingDetector.finalizeTrip(trip.driver_id, tripId);
      NavigationService.emitEnded(
        io, tripId, trip.driver_id, trip.rider_id
      );
    }

    io.to(`rider:${trip.rider_id}`).emit('tripUpdate', updatedTrip);
    if (trip.driver_id) {
      io.to(`driver:${trip.driver_id}`).emit('tripUpdate', updatedTrip);
    }

    // Broadcast to Admin Monitoring
    io.to('monitoring:all_rides').emit('tripUpdate', updatedTrip);

    return updatedTrip;
  }

  static async getHistory(userId: string, role: string): Promise<Trip[]> {
    if (role === 'driver') {
      return RideRepository.findByDriverId(userId);
    }
    return RideRepository.findByRiderId(userId);
  }

  static async getCurrentRide(userId: string, role: string): Promise<Trip | null> {
    console.log(`[RIDE] getCurrentRide userId=${userId} role=${role} RideRepository=${typeof RideRepository} fcdByDriverId=${typeof RideRepository.findCurrentByDriverId}`);
    let r;
    if (role === UserRole.DRIVER || role === 'driver' || role === 'DRIVER') {
      console.log('[RIDE] about to call RideRepository.findCurrentByDriverId');
      r = await RideRepository.findCurrentByDriverId(userId);
      console.log('[RIDE] returned from findCurrentByDriverId, r=', r?.id);
    } else {
      r = await RideRepository.findCurrentByRiderId(userId);
    }
    console.log(`[RIDE] getCurrentRide result=${r?.id} status=${r?.status} driver_id=${r?.driver_id}`);
    return r;
  }

  static async deleteHistory(rideId: string, userId: string): Promise<boolean> {
    return RideRepository.delete(rideId, userId);
  }
}
