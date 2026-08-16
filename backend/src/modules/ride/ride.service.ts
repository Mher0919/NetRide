// backend/src/modules/ride/ride.service.ts
console.log('[SVC_INIT] ride.service.ts loaded at', new Date().toISOString());
import { RideRepository } from './ride.repository';
console.log('[SVC_INIT] FULL findCurrentByDriverId toString:\n' + (RideRepository?.findCurrentByDriverId?.toString() || 'undefined'));
import { LocationsService } from '../location/locations.service';
import { GeospatialService } from '../geospatial/geospatial.service';
import { Trip, Location, UserRole, TripStatus } from '../../types';
import { PartyRole } from '../reporting/report.reasons';
import { env } from '../../config/env';
import { getIo } from '../../gateway/io-handle';
import { pool } from '../../config/database';
import { redis } from '../../config/redis';
import { createPriceSnapshot, computeEstimate, getSnapshotForRide, persistRevenueAllocation, getRevenueAllocationForRide } from '../../services/pricing.service';
import { NavigationService, CachedRoutePayload } from '../../services/navigation.service';
import { RouteStoreService, haversineMeters } from '../../services/route-store.service';
import { SpeedingDetector } from '../../services/speeding_detector';
import { DriverService } from '../driver/driver.service';
import { areBothTestUsers } from '../../utils/testUser';
import { matchQueue } from '../../queue/queue';
import { matchJobsTotal, dispatchAcceptOutcomeTotal } from '../../observability/metrics';
import { traceAsync, getCurrentTraceId } from '../../utils/tracing';
import { RewardEngine } from '../../services/reward-engine.service';
import { WalletService } from '../wallet/wallet.service';
import { FinancialLedgerService, centsValue } from '../../services/financial-ledger.service';
import { SpecialRedemptionService } from '../sponsor/special-redemption.service';
import {
  notifyRideAccepted,
  notifyRideStarted,
  notifyRideCompleted,
  notifyRideCancelled,
  notifyWalletCharged,
} from '../../services/notification.service';
import { cancellationReasonLabel } from '../reporting/report.reasons';

/** Display name of a platform user (used in notification copy). */
async function fetchDisplayName(userId: string): Promise<string> {
  try {
    const res = await pool.query('SELECT full_name FROM users WHERE id = $1', [userId]);
    return res.rows[0]?.full_name || 'Your driver';
  } catch {
    return 'Your driver';
  }
}

// Star penalty (out of 5) applied when a driver cancels AFTER accepting a
// ride but BEFORE picking the rider up. Applies to every driver-initiated
// pre-pickup cancellation regardless of the reason given. The penalty is a
// direct decrement of the driver's rating (both users + drivers mirrors),
// clamped at the 1.0 floor — it is not a rider review and never touches
// the ratings table or the review-based moving average.
const DRIVER_PRE_PICKUP_CANCEL_STAR_PENALTY = 0.3;

function applyDriverPrePickupCancelPenalty(userId: string): void {
  pool
    .query(
      `UPDATE users
          SET rating = GREATEST(1.0, ROUND((rating - $1)::numeric, 2))
        WHERE id = $2`,
      [DRIVER_PRE_PICKUP_CANCEL_STAR_PENALTY, userId],
    )
    .then(() =>
      pool.query(
        `UPDATE drivers
            SET rating = GREATEST(1.0, ROUND((rating - $1)::numeric, 2))
          WHERE user_id = $2`,
        [DRIVER_PRE_PICKUP_CANCEL_STAR_PENALTY, userId],
      ),
    )
    .catch((err: any) =>
      console.error(`[RIDE] ⚠️ Failed to apply driver pre-pickup cancel star penalty: ${err.message}`),
    );
}

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
    scheduledAt?: Date,
    isScheduled: boolean = false,
    idempotencyKey?: string,
    rewards: { promoCode?: string; applyCredits?: boolean; creditUseCents?: number; specialRedemptionId?: string } = {},
    favoritePriority: boolean = false
  ): Promise<Trip> {
    return traceAsync('RideService.requestRide', async () => {
      const traceId = getCurrentTraceId();
      console.log(`[RIDE] New request from rider ${riderId}${isScheduled ? ' [SCHEDULED]' : ''} [trace=${traceId}]. Pickup: ${pickup.lat}, ${pickup.lng}`);

      // Idempotency: if key provided, check for existing ride
      if (idempotencyKey) {
        const existing = await pool.query(
          `SELECT * FROM rides WHERE idempotency_key = $1 AND rider_id = $2`,
          [idempotencyKey, riderId]
        );
        if (existing.rows.length > 0) {
          console.log(`[RIDE] ♻️ Idempotent request - returning existing trip ${existing.rows[0].id}`);
          const existingTrip = await RideRepository.findById(existing.rows[0].id);
          if (!existingTrip) throw new Error('Idempotent ride not found');
          return existingTrip;
        }
      }

      // Snapshot rider rating
      const riderRes = await pool.query('SELECT rating FROM users WHERE id = $1', [riderId]);
      const snapshotRating = riderRes.rows[0]?.rating || 5.0;

      // Get Route
      const routeStart = Date.now();
      const route = await GeospatialService.getRoute(
        [pickup.lat, pickup.lng],
        [destination.lat, destination.lng]
      ).catch(() => null);
      console.log(`[RIDE] Route fetched in ${Date.now() - routeStart}ms (cached=${route != null})`);

      const distanceKm = route ? (route.distance / 1000) : 10.0;
      const etaSeconds = route ? route.eta : 600;

      // Every ride request runs through one transactional path: ride INSERT
      // + price snapshot + promo/credits/wallet all commit atomically. A
      // failed promo/credits application aborts the entire request so the
      // rider can fix the code and re-request. The wallet is the default
      // payment method — it is charged the fare remaining after discounts.
      const client = await pool.connect();
      let tripId: string;
      try {
        await client.query('BEGIN');
        const res = await client.query(
          `INSERT INTO rides (
            rider_id, status, pickup_lat, pickup_lng, pickup_address,
            destination_lat, destination_lng, destination_address,
            requested_class, snapshot_rider_rating, scheduled_at, is_scheduled,
            distance_meters, duration_seconds, idempotency_key
          )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
           RETURNING id`,
          [
            riderId,
            TripStatus.REQUESTED,
            pickup.lat,
            pickup.lng,
            pickup.address,
            destination.lat,
            destination.lng,
            destination.address,
            'CORE',
            snapshotRating,
            scheduledAt || null,
            isScheduled,
            route ? Math.round(route.distance) : null,
            etaSeconds,
            idempotencyKey || null
          ]
        );
        tripId = res.rows[0].id;

        const breakdown = await createPriceSnapshot(tripId, {
          distanceMeters: route ? route.distance : distanceKm * 1000,
          durationSeconds: etaSeconds,
        }, client);

        await RewardEngine.applyToRideRequest(client, {
          riderId,
          rideId: tripId,
          fareCents: Math.round(breakdown.totalFare * 100),
          promoCode: rewards.promoCode,
          applyCredits: rewards.applyCredits,
          creditUseCents: rewards.creditUseCents,
        });

        // Sponsorship/SPECIALS: attach the redemption + snapshot the discount
        // INSIDE this transaction. Throws abort the whole request (invalid/
        // unavailable special → no ride created).
        if (rewards.specialRedemptionId) {
          await SpecialRedemptionService.attachToRideRequest(client, {
            riderId,
            rideId: tripId,
            fareCents: Math.round(breakdown.totalFare * 100),
            specialRedemptionId: rewards.specialRedemptionId,
          });
        }

        await client.query('COMMIT');
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* noop */ }
        throw err;
      } finally {
        client.release();
      }

      const trip = await RideRepository.findById(tripId);
      if (!trip) throw new Error('Failed to create trip record');

      if (route) {
        (trip as any).route_geometry = route.geometry;

        // Persist the rider-generated route as the authoritative
        // destination leg (pickup → destination). The driver reuses it
        // at IN_PROGRESS instead of requesting another Google route.
        RouteStoreService.saveRideRoute({
          rideId: trip.id,
          leg: 'destination',
          origin: [pickup.lat, pickup.lng],
          destination: [destination.lat, destination.lng],
          distanceMeters: route.distance,
          durationSeconds: route.osrm_duration,
          trafficDurationSeconds: null,
          etaSeconds: route.eta,
          geometry: route.geometry,
          steps: route.steps ?? [],
          engine: route.engine,
          cacheHit: route.cache_hit === true,
        }).catch((err) => console.error(`[RIDE] ride_routes persist failed: ${err.message}`));
      }

      // Trigger Matching ONLY if it's NOT a future scheduled ride
      // or if scheduledAt is within the next 15 minutes.
      const isNow = !isScheduled || (scheduledAt && (scheduledAt.getTime() - Date.now() < 15 * 60 * 1000));

      if (isNow) {
        if (env.LEGACY_SYNC_MATCHING) {
          // In-process dispatch (no BullMQ worker in this environment). Uses
          // the same DispatchEngine/offer pipeline as the queue handler.
          import('../../services/matching.service').then(({ matchingService }) => {
            matchingService.findAndDispatch(
              getIo(), trip.id, pickup.lat, pickup.lng, riderId, favoritePriority,
            ).catch((err: any) => console.error('[RIDE] In-process dispatch failed:', err.message));
          });
        } else {
          matchQueue.add('matchRide', {
            tripId: trip.id,
            pickupLat: pickup.lat,
            pickupLng: pickup.lng,
            riderId,
            favoritePriority,
          }).catch((err) => console.error('[RIDE] Failed to enqueue match job:', err.message));
          matchJobsTotal.inc({ outcome: 'enqueued' });
        }
      }

      // Rewards bookkeeping (non-blocking): referral state machine progress.
      RewardEngine.onRideRequested({ id: trip.id, rider_id: riderId, driver_id: null, fare_amount: null, status: 'REQUESTED' })
        .catch((err) => console.error(`[RIDE] ⚠️ onRideRequested failed: ${err.message}`));

      return trip;
    });
  }

  static async acceptTrip(tripId: string, driverId: string): Promise<Trip> {
    const trip = await RideRepository.findById(tripId);
    if (!trip) throw new Error('Trip not found');

    // Idempotent re-accept: the same driver accepting the same trip again
    // (socket retransmit, double-tap) is a success, not an error — the
    // trip is already assigned to this driver.
    if (trip.driver_id === driverId &&
        (trip.status === 'ACCEPTED' || trip.status === 'IN_PROGRESS')) {
      return trip;
    }
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

    // Validate that this driver has an active offer for this ride.
    // This prevents stale acceptances (e.g., driver accepts after timeout)
    // and ensures the driver was actually offered this ride.
    const { DriverOfferService, OfferStatus } = await import('../../services/driver-offer.service');
    const rideOffer = await DriverOfferService.getOfferForRide(tripId);
    if (!rideOffer) {
      throw new Error('No active offer for this ride. The offer may have expired.');
    }
    if (rideOffer.driverId !== driverId) {
      throw new Error('This ride was offered to a different driver.');
    }
    if (rideOffer.status !== OfferStatus.SENT) {
      if (rideOffer.status === OfferStatus.ACCEPTED) {
        // The offer was already atomically accepted for this driver —
        // either a retransmitted accept (trip already assigned, handled
        // above) or a crash between the offer accept and the ride flip.
        // Reconcile by continuing the assignment below instead of failing.
      } else if (rideOffer.status === OfferStatus.EXPIRED) {
        throw new Error('This ride offer has expired.');
      } else {
        throw new Error(`Offer is in state ${rideOffer.status} and cannot be accepted.`);
      }
    }

    // Atomically accept the offer — this prevents race conditions where
    // two workers or two app clients both try to accept the same offer.
    // Skipped when the offer is already ACCEPTED for this driver (the
    // atomic guard above was already won by us).
    if (rideOffer.status === OfferStatus.SENT) {
      const accepted = await DriverOfferService.acceptOffer(rideOffer.offerId);
      if (!accepted) {
        throw new Error('Failed to accept offer. It may have already been accepted or expired.');
      }
    }

    // Resolve the fare from the ride's price snapshot (platform price —
    // identical for every driver). Falls back to a live estimate for
    // legacy rides created before snapshots existed.
    const snapshot = await getSnapshotForRide(tripId);
    const finalFare = snapshot
      ? snapshot.final_fare
      : computeEstimate({
          distanceMeters: (trip.distance_km || 10.0) * 1000,
          durationSeconds: (trip.duration_minutes ? trip.duration_minutes * 60 : 600),
        }).totalFare;

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

    // Atomic ride flip: the status guard means a rider cancellation that
    // commits between the offer check and here wins cleanly — the accept is
    // rejected instead of overwriting the CANCELLED state (race-condition
    // safety). When the guard rejects, the offer we just accepted is
    // superseded so the driver is released for the next request.
    const acceptRes = await pool.query(
      `UPDATE rides
          SET status = $2, driver_id = $3, accepted_at = $4,
              compliance_snapshot = $5, fare_amount = $6
        WHERE id = $1 AND status = $7
        RETURNING id`,
      [tripId, 'ACCEPTED', driverId, new Date(), JSON.stringify(complianceSnapshot), finalFare, TripStatus.REQUESTED],
    );
    if ((acceptRes.rowCount ?? 0) === 0) {
      await DriverOfferService.supersedeOffer(rideOffer.offerId);
      const latest = await RideRepository.findById(tripId);
      if (latest?.status === TripStatus.CANCELLED) {
        throw new Error('This ride was cancelled by the rider.');
      }
      throw new Error('Trip already taken or cancelled');
    }

    const updatedTrip = await RideRepository.findById(tripId);
    if (!updatedTrip) throw new Error('Failed to load accepted trip');

    // Persist the per-ride revenue allocation (the driver — and thus the
    // fleet partner share — is now known). Never blocks the accept path;
    // the wallet credit at completion falls back to a live computation
    // when this write is missing.
    persistRevenueAllocation(tripId, driverId, Math.round(finalFare * 100))
      .catch((err: any) => console.error(`[RIDE] ⚠️ Revenue allocation persist failed: ${err.message}`));

    // Cache active trip for trajectory buffering
    await redis.set(`driver:${driverId}:active_trip`, tripId, 'EX', 14400); // 4h safety TTL

    // Step 4: Parallel fan-out — record winner and cancel other offers
    await redis.set(`dispatch:winners:${tripId}`, driverId, 'EX', 300);
    const dispatchedJson = await redis.get(`match:queue:dispatched:${tripId}`);
    if (dispatchedJson) {
      const dispatchedDrivers: string[] = JSON.parse(dispatchedJson);
      for (const did of dispatchedDrivers) {
        if (did !== driverId) {
          getIo().to(`driver:${did}`).emit('tripUpdate', {
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
    await redis.del(`dispatch:${tripId}`);

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
          getIo(), tripId, driverId, trip.rider_id, 'pickup', pickupRoute
        );
      } catch (err: any) {
        console.error(`[RIDE] ⚠️ pickup route cache failed: ${err.message}`);
      }
    }

    getIo().to(`rider:${trip.rider_id}`).emit('tripUpdate', updatedTrip);
    getIo().to(`driver:${driverId}`).emit('tripUpdate', updatedTrip);
    dispatchAcceptOutcomeTotal.inc({ outcome: 'accepted' });

    // Broadcast to Admin Monitoring
    getIo().to('monitoring:all_rides').emit('tripUpdate', updatedTrip);

    // Real phone notification: driver accepted the ride. Deduplicated by
    // eventId (ride:accepted:{tripId}) — never blocks the accept path.
    fetchDisplayName(driverId)
      .then((driverName) =>
        notifyRideAccepted(trip.rider_id, tripId, driverName, Math.round(finalFare * 100))
      )
      .catch(() => undefined);

    return updatedTrip;
  }

  static async updateTripStatus(
    tripId: string,
    status: any,
    userId: string,
    opts: { bypassDriverGuard?: boolean } = {},
  ): Promise<Trip> {
    const trip = await RideRepository.findById(tripId);
    if (!trip) throw new Error('Trip not found');

    console.log(`[RIDE] updateTripStatus: tripId=${tripId} status=${status} userId=${userId} trip.driver_id=${trip.driver_id} match=${trip.driver_id === userId} bypass=${!!opts.bypassDriverGuard}`);

    // Security: Only the assigned driver (or an authorized operator with
    // `bypassDriverGuard`, e.g. an admin force-completing a stuck ride)
    // can update progress.
    if (trip.driver_id !== userId && !opts.bypassDriverGuard) {
      throw new Error('Unauthorized: You are not the assigned driver for this trip');
    }

    // State machine guard: a terminal ride (COMPLETED/CANCELLED) can never
    // transition again, and only an active in-progress ride may complete.
    if (status === 'COMPLETED' && trip.status !== 'ACCEPTED' && trip.status !== 'DRIVER_ARRIVING' && trip.status !== 'IN_PROGRESS') {
      throw new Error(`Ride cannot be completed from its current state (${trip.status})`);
    }
    if (status === 'IN_PROGRESS' && trip.status !== 'ACCEPTED' && trip.status !== 'DRIVER_ARRIVING') {
      throw new Error(`Ride cannot be started from its current state (${trip.status})`);
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
          // Reuse the rider-generated route (stored at request time) when
          // the driver is at/near pickup and the route is fresh — no
          // Google call. Only fall back to a fresh computation otherwise.
          const storedDest = await RouteStoreService.getRideRoute(tripId, 'destination');
          let destRoute: CachedRoutePayload | null = null;
          if (storedDest && storedDest.geometry.coordinates.length >= 2) {
            const ageMs = Date.now() - new Date(storedDest.createdAt).getTime();
            const pickupDistM = haversineMeters(
              [driverLoc.lat, driverLoc.lng],
              [updatedTrip.pickup.lat, updatedTrip.pickup.lng],
            );
            if (ageMs <= 2 * 60 * 60 * 1000 && pickupDistM <= 500) {
              destRoute = {
                distance: storedDest.distanceMeters,
                osrm_duration: storedDest.durationSeconds,
                duration: storedDest.durationSeconds,
                eta: storedDest.etaSeconds,
                geometry: storedDest.geometry,
                polyline: storedDest.geometry.coordinates,
                steps: storedDest.steps,
                speedLimitsByRoad: {},
                cache_hit: storedDest.cacheHit,
                model_multiplier: 1.0,
                engine: storedDest.engine,
                trafficDurationSeconds: storedDest.trafficDurationSeconds,
                cachedAt: storedDest.createdAt,
              };
            }
          }

          if (!destRoute) {
            destRoute = await NavigationService.cacheRouteLeg(
              tripId,
              'destination',
              [driverLoc.lat, driverLoc.lng],
              [updatedTrip.destination.lat, updatedTrip.destination.lng]
            );
          }

          await pool.query(
            `UPDATE rides SET route_metadata = route_metadata || $1::jsonb WHERE id = $2`,
            [JSON.stringify({ destination: destRoute }), tripId]
          );
          NavigationService.emitLegAdvanced(
            getIo(), tripId, updatedTrip.driver_id, updatedTrip.rider_id, destRoute
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
        getIo(), tripId, updatedTrip.driver_id, updatedTrip.rider_id
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
            fareCents,
            tipCents,
            tripId
          );
        }
      } catch (err: any) {
        console.warn(
          `[RIDE] ⚠️ Wallet credit failed (non-blocking) for trip ${tripId}: ${err.message}`
        );
      }

      // Rider payment: the wallet is charged ONLY when the ride completes
      // successfully — never at request (a cancelled ride costs nothing).
      // Settles the amount reserved at request time (final_payment_cents =
      // fare after promo + credits, stored as integer cents). Idempotent via
      // the wallet ledger's unique idempotency key (wallet-charge:{rideId});
      // non-blocking so a wallet issue can never strand an already-completed
      // trip.
      let walletChargeCents = 0;
      const dueCents = centsValue((updatedTrip as any).final_payment_cents);
      try {
        if (dueCents > 0) {
          const charged = await WalletService.chargeForRide(
            updatedTrip.rider_id,
            tripId,
            dueCents,
          );
          walletChargeCents = charged.walletChargeCents;
          if (charged.walletChargeCents > 0) {
            await pool.query(
              `UPDATE rides SET wallet_payment_cents = $1 WHERE id = $2`,
              [charged.walletChargeCents, tripId],
            );
            notifyWalletCharged(
              updatedTrip.rider_id,
              charged.walletChargeCents,
              tripId,
            ).catch(() => undefined);
          }
        }
      } catch (err: any) {
        console.warn(
          `[RIDE] ⚠️ Rider wallet charge failed (non-blocking) for trip ${tripId}: ${err.message}`
        );
      }

      // Driver earnings (60% share, from the persisted allocation) ride along
      // on the payload so the driver app never computes money client-side.
      const allocation = await getRevenueAllocationForRide(tripId);
      if (allocation) {
        (updatedTrip as any).driver_earnings_cents = allocation.driverShareCents;
      }

      // Financial settlement: exactly one ledger row per completed ride.
      // Idempotent (ride_completion:{rideId} idempotency key + partial unique
      // index on ride_id). Settled only when the full amount due is covered;
      // a shortfall is recorded as PENDING_CAPTURE with the outstanding
      // cents so failed/short payments stay explicit.
      try {
        const tipCents = Math.round(
          parseFloat((updatedTrip as any).tip_amount ?? '0') * 100
        );
        await FinancialLedgerService.recordRideCompletion({
          rideId: tripId,
          riderId: updatedTrip.rider_id,
          driverId: updatedTrip.driver_id,
          fareCents: dueCents,
          promotionCents: centsValue((updatedTrip as any).promo_discount_cents),
          creditsCents: centsValue((updatedTrip as any).credits_applied_cents),
          tipCents,
          walletPaymentCents: walletChargeCents,
          amountOwedCents: Math.max(0, dueCents - walletChargeCents),
          driverShareCents: allocation?.driverShareCents ?? 0,
          platformShareCents: allocation?.platformShareCents ?? 0,
          netrideShareCents: allocation?.netrideShareCents ?? 0,
          paymentProvider: 'wallet',
          paymentReference: tripId,
          completedAt: updatedTrip.completed_at ? new Date(updatedTrip.completed_at) : new Date(),
        });
      } catch (err: any) {
        console.warn(
          `[RIDE] ⚠️ Financial ledger write failed (non-blocking) for trip ${tripId}: ${err.message}`
        );
      }

// Rewards ecosystem: finalize promo usage + partner commission and
      // grant any referral rewards. Non-blocking — must never block the
      // trip end. Fully idempotent (unique guards on every table).
      RewardEngine.onRideCompleted({
        id: tripId,
        rider_id: updatedTrip.rider_id,
        driver_id: updatedTrip.driver_id,
        fare_amount: (updatedTrip as any).fare_amount ?? null,
        status: 'COMPLETED',
      }).catch((err: any) => console.error(`[RIDE] ⚠️ RewardEngine.onRideCompleted failed: ${err.message}`));

      // Sponsorship/SPECIALS: the completed special ride now issues the
      // one-time validation code (hash-only, TTL). Non-blocking + idempotent;
      // no-op for regular rides (no redemption attached).
      SpecialRedemptionService.onRideCompleted(tripId, updatedTrip.rider_id)
        .catch((err: any) => console.error(`[RIDE] ⚠️ SpecialRedemptionService.onRideCompleted failed: ${err.message}`));
    }

    getIo().to(`rider:${updatedTrip.rider_id}`).emit('tripUpdate', updatedTrip);
    if (updatedTrip.driver_id) {
      getIo().to(`driver:${updatedTrip.driver_id}`).emit('tripUpdate', updatedTrip);
    }

    // Broadcast to Admin Monitoring
    getIo().to('monitoring:all_rides').emit('tripUpdate', updatedTrip);

    // Real phone notifications (fire-and-forget, deduped by eventId):
    if (status === 'IN_PROGRESS' && updatedTrip.driver_id) {
      fetchDisplayName(updatedTrip.driver_id)
        .then((driverName) => notifyRideStarted(updatedTrip.rider_id, tripId, driverName))
        .catch(() => undefined);
    } else if (status === 'COMPLETED') {
      const fareCents = Math.round(
        parseFloat((updatedTrip as any).fare_amount ?? '0') * 100
      );
      notifyRideCompleted(updatedTrip.rider_id, tripId, fareCents).catch(() => undefined);
    }

    return updatedTrip;
  }

  static async cancelTrip(
    tripId: string,
    userId: string,
    opts: { reasonCode?: string; reasonText?: string; bypassOwnership?: boolean } = {},
  ): Promise<Trip> {
    const trip = await RideRepository.findById(tripId);
    if (!trip) throw new Error('Trip not found');

    // Security: only the rider, the assigned driver (or an authorized
    // operator with `bypassOwnership`, e.g. an admin dissolving a stuck
    // ride) can cancel.
    if (trip.rider_id !== userId && trip.driver_id !== userId && !opts.bypassOwnership) {
      throw new Error('Unauthorized to cancel this trip');
    }

    // Idempotency: if the ride is already cancelled (e.g. the other party
    // cancelled simultaneously, or the user double-tapped), the existing
    // authoritative cancelled state IS the answer — return it as success
    // instead of erroring a second transition. One cancellation wins.
    if (trip.status === 'CANCELLED') {
      return trip;
    }

    // Cancellation is allowed while searching (REQUESTED), before pickup
    // (ACCEPTED / DRIVER_ARRIVING), and DURING the ride (IN_PROGRESS — the
    // rider may change their mind mid-trip and the trip dissolves without
    // a charge since payment only settles at completion). Only COMPLETED
    // rides are final.
    if (trip.status !== 'REQUESTED' &&
        trip.status !== 'ACCEPTED' &&
        trip.status !== 'DRIVER_ARRIVING' &&
        trip.status !== 'IN_PROGRESS') {
      throw new Error('Cannot cancel a ride that is already completed');
    }

    // Required cancellation reasons (042): an ACCEPTED/DRIVER_ARRIVING or
    // IN_PROGRESS ride may only be dissolved by a human party with a reason
    // code. System timeouts and searching-phase cancels (REQUESTED) stay
    // reason-free.
    if ((trip.status === 'ACCEPTED' || trip.status === 'DRIVER_ARRIVING' || trip.status === 'IN_PROGRESS') && !opts.reasonCode) {
      throw new Error('Please select a reason for cancelling this ride.');
    }

    // Driver cancelling AFTER accepting but BEFORE picking the rider up is
    // NOT a terminal cancellation: the SAME ride (same fare quote, promo +
    // credits untouched) is released back to the pool and re-dispatched, and
    // the rider gets an apology. The driver still earns a star penalty +
    // the accepted-cancellation counter, reason or no reason.
    const isDriverPrePickupCancel =
      userId === trip.driver_id &&
      (trip.status === TripStatus.ACCEPTED || trip.status === TripStatus.DRIVER_ARRIVING);

    // Accepted-ride cancellation by the DRIVER mid-trip (IN_PROGRESS) is a
    // terminal cancellation (not a "release + re-match"): both parties see
    // the terminal state, and both may report each other afterwards. The
    // driver stays on the ride row so history + reporting work.

    // Audit trail: who initiated the cancel and why. Null for system
    // cancels (cleanup/timeouts), which never pass through here.
    const extra: any = {
      cancelled_at: new Date(),
      cancelled_by: userId,
      cancellation_reason_code: opts.reasonCode ?? null,
      cancellation_reason_text: (opts.reasonText ?? '').trim().slice(0, 300) || null,
    };

    // If driver was assigned, cleanup trajectory
    if (trip.driver_id) {
      const trajectory = await LocationsService.getTrajectory(tripId);
      // For a pre-pickup release the partial approach trajectory of the
      // departing driver is discarded — the ride will be driven fresh by
      // the next driver, and this GPS data must never leak into the final
      // ride's "actual route" (admin maps).
      if (trajectory.length > 0 && !isDriverPrePickupCancel) {
        extra.trajectory = JSON.stringify(trajectory);
      }
      await redis.del(`driver:${trip.driver_id}:active_trip`);
      await LocationsService.clearTrajectory(tripId);
      await NavigationService.clearTrip(tripId);
    }

    // Release any dispatched driver offer first so a driver can never accept
    // a request that is being cancelled. Idempotent — safe to run on every
    // path (socket, REST, system cleanup).
    if (trip.status === TripStatus.REQUESTED) {
      const { DriverOfferService } = await import('../../services/driver-offer.service');
      await DriverOfferService.cancelRideOffers(tripId);
    }

    // ------------------------------------------------------------------
    // DRIVER PRE-PICKUP CANCEL → release + re-match the same ride
    // ------------------------------------------------------------------
    if (isDriverPrePickupCancel) {
      const releaseRes = await pool.query(
        `UPDATE rides
            SET status = $3,
                driver_id = NULL,
                cancelled_at = NULL,
                cancelled_by = NULL,
                cancellation_reason_code = NULL,
                cancellation_reason_text = NULL
          WHERE id = $1 AND driver_id = $2 AND status IN ($4, $5)
          RETURNING id`,
        [
          tripId,
          userId,
          TripStatus.REQUESTED,
          TripStatus.ACCEPTED,
          TripStatus.DRIVER_ARRIVING,
        ],
      );

      if ((releaseRes.rowCount ?? 0) === 0) {
        // The ride already flipped (duplicate emit, or another actor took
        // it over) — answer with the latest authoritative state. No second
        // penalty, no state clobber.
        const latest = await RideRepository.findById(tripId);
        return latest ?? trip;
      }

      // Star penalty + accepted-cancellation counter for every driver
      // pre-pickup cancel, reason given or not.
      applyDriverPrePickupCancelPenalty(userId);
      pool
        .query(
          `UPDATE drivers
              SET cancellation_count = COALESCE(cancellation_count, 0) + 1,
                  last_cancellation_at = NOW()
            WHERE user_id = $1`,
          [userId],
        )
        .catch((err: any) =>
          console.error(`[RIDE] ⚠️ Failed to increment driver cancellation counter: ${err.message}`)
        );

      const rematchedTrip = await RideRepository.findById(tripId);
      if (!rematchedTrip) throw new Error('Failed to load released trip');

      // Safety + navigation teardown for the departing driver.
      await SpeedingDetector.finalizeTrip(userId, tripId);
      NavigationService.emitEnded(getIo(), tripId, userId, trip.rider_id);

      // The cancelling driver sees THEIR OWN terminal cancel (who + why) so
      // their app settles the confirmation and returns home — never the
      // re-queued REQUESTED state of the ride they abandoned.
      getIo().to(`driver:${userId}`).emit('tripUpdate', {
        ...rematchedTrip,
        rider_id: trip.rider_id,
        status: TripStatus.CANCELLED,
        cancelled_by: userId,
        cancelled_at: new Date(),
        cancellation_reason_code: opts.reasonCode ?? null,
        cancellation_reason_text: (opts.reasonText ?? '').trim().slice(0, 300) || null,
      });

      // Rider: authoritative REQUESTED state (same ride, same fare quote,
      // same promo + credits — nothing was recreated) + the apology notice.
      // The rider app pops the apology over the re-activated "finding your
      // driver" sheet; no re-request is needed.
      getIo().to(`rider:${trip.rider_id}`).emit('tripUpdate', rematchedTrip);
      getIo().to(`rider:${trip.rider_id}`).emit('tripDriverCancelled', {
        tripId,
        trip: rematchedTrip,
        reasonCode: opts.reasonCode ?? null,
        reasonText: (opts.reasonText ?? '').trim().slice(0, 300) || null,
      });
      getIo().to('monitoring:all_rides').emit('tripUpdate', rematchedTrip);

      // Re-dispatch the SAME ride id through the regular pipeline.
      const pickup = rematchedTrip.pickup;
      if (env.LEGACY_SYNC_MATCHING) {
        import('../../services/matching.service').then(({ matchingService }) => {
          matchingService
            .findAndDispatch(getIo(), tripId, pickup.lat, pickup.lng, trip.rider_id, false)
            .catch((err: any) =>
              console.error(`[RIDE] Re-dispatch after driver pre-pickup cancel failed: ${err.message}`)
            );
        });
      } else {
        matchQueue
          .add('matchRide', {
            tripId,
            pickupLat: pickup.lat,
            pickupLng: pickup.lng,
            riderId: trip.rider_id,
            favoritePriority: false,
          })
          .catch((err) => console.error('[RIDE] Failed to enqueue re-match job:', err.message));
        matchJobsTotal.inc({ outcome: 'enqueued' });
      }

      return rematchedTrip;
    }

    // Idempotent terminal transition handled in the shared helper (below):
    // a concurrent ACCEPT that commits between our read and this update
    // wins the race — we never overwrite a fresher state.
    return RideService._terminalCancel(
      trip,
      extra.cancelled_by,
      extra.cancellation_reason_code,
      extra.cancellation_reason_text,
    );
  }

  /**
   * System-driven terminal cancellation (stale-ride watchdog / boots-time
   * reconciliation). No human actor: `cancelled_by` stays NULL, no reason
   * code is required, and there is NO pre-pickup rematch — the ride is
   * dissolved permanently so neither party's app can keep routing to it.
   * Idempotent — safe to call repeatedly from every cleanup tick.
   */
  static async cancelTripSystem(
    tripId: string,
    opts: { reasonText?: string } = {},
  ): Promise<Trip | null> {
    const trip = await RideRepository.findById(tripId);
    if (!trip) return null;
    if (trip.status === 'CANCELLED') return trip; // idempotent
    if (trip.status === 'COMPLETED') return trip; // never un-complete

    // Cancel is only valid on cancellable states.
    if (trip.status !== 'REQUESTED' &&
        trip.status !== 'ACCEPTED' &&
        trip.status !== 'DRIVER_ARRIVING' &&
        trip.status !== 'IN_PROGRESS') {
      return trip;
    }

    console.log(`[RIDE] ⚠️ System-cancelling stale ride ${tripId} (status=${trip.status})`);

    // Preserve any captured GPS trajectory and release the driver's
    // session/lock/navigation state exactly like a party-initiated cancel.
    if (trip.driver_id) {
      const trajectory = await LocationsService.getTrajectory(tripId);
      if (trajectory.length > 0) {
        await pool.query(`UPDATE rides SET trajectory = $1 WHERE id = $2`, [
          JSON.stringify(trajectory),
          tripId,
        ]);
      }
      await redis.del(`driver:${trip.driver_id}:active_trip`);
      await LocationsService.clearTrajectory(tripId);
      await NavigationService.clearTrip(tripId);
    }

    if (trip.status === TripStatus.REQUESTED) {
      const { DriverOfferService } = await import('../../services/driver-offer.service');
      await DriverOfferService.cancelRideOffers(tripId);
    }

    const reasonText = (opts.reasonText ?? 'Ride was resolved by the system (stale ride).')
      .trim()
      .slice(0, 300);

    return RideService._terminalCancel(trip, null, null, reasonText);
  }

  /**
   * Shared terminal-cancellation core used by party cancels (cancelTrip),
   * system cancels (cancelTripSystem) and admin cancels. Atomic status
   * guard + rewards/sponsor teardown + safety/navigation teardown +
   * authoritative broadcast to both parties and admin monitoring.
   */
  private static async _terminalCancel(
    trip: Trip,
    cancelledBy: string | null,
    reasonCode: string | null,
    reasonText: string | null,
  ): Promise<Trip> {
    const tripId = trip.id;

    // Atomic transition: the WHERE guard means a concurrent ACCEPT that
    // commits between our read and this update wins the race — we never
    // overwrite a fresher state (accept-vs-cancel race safety).
    const cancelRes = await pool.query(
      `UPDATE rides
          SET status = $2, cancelled_at = $3, cancelled_by = $4,
              cancellation_reason_code = $5, cancellation_reason_text = $6
        WHERE id = $1 AND status IN ($7, $8, $9, $10)
        RETURNING id`,
      [
        tripId,
        TripStatus.CANCELLED,
        new Date(),
        cancelledBy,
        reasonCode,
        reasonText,
        TripStatus.REQUESTED,
        TripStatus.ACCEPTED,
        TripStatus.IN_PROGRESS,
        TripStatus.DRIVER_ARRIVING,
      ],
    );

    if ((cancelRes.rowCount ?? 0) === 0) {
      // Another actor flipped the ride between our read and the write
      // (driver accepted, or the ride was already cancelled/completed).
      const latest = await RideRepository.findById(tripId);
      if (latest?.status === TripStatus.CANCELLED) return latest; // idempotent
      throw new Error('Cannot cancel a ride that is already completed');
    }

    const updatedTrip = await RideRepository.findById(tripId);
    if (!updatedTrip) throw new Error('Failed to load cancelled trip');

    // Rewards ecosystem: void promo usage + refund applied credits.
    RewardEngine.onRideCancelled({
      id: tripId,
      rider_id: trip.rider_id,
      driver_id: trip.driver_id ?? null,
      fare_amount: (trip as any).fare_amount ?? null,
      status: 'CANCELLED',
    }).catch((err: any) => console.error(`[RIDE] ⚠️ RewardEngine.onRideCancelled failed: ${err.message}`));

    // Sponsorship/SPECIALS: a TERMINAL cancellation voids any attached
    // redemption AND releases the reserved budget (spec §69 — a cancelled
    // ride never consumes sponsor funding). No-op for regular rides and for
    // driver pre-pickup rematches (the ride keeps REQUESTED and the special
    // stays intact for the next driver).
    SpecialRedemptionService.onRideCancelled(tripId)
      .catch((err: any) => console.error(`[RIDE] ⚠️ SpecialRedemptionService.onRideCancelled failed: ${err.message}`));

    // Safety + navigation teardown on cancel.
    if (trip.driver_id) {
      await SpeedingDetector.finalizeTrip(trip.driver_id, tripId);
      NavigationService.emitEnded(
        getIo(), tripId, trip.driver_id, trip.rider_id
      );
    }

    // Authoritative state broadcast — both parties (and monitoring) react
    // to this same CANCELLED payload carrying cancelled_by + reason.
    getIo().to(`rider:${trip.rider_id}`).emit('tripUpdate', updatedTrip);
    if (trip.driver_id) {
      getIo().to(`driver:${trip.driver_id}`).emit('tripUpdate', updatedTrip);
    }
    getIo().to('monitoring:all_rides').emit('tripUpdate', updatedTrip);

    // Real phone notification carrying WHO cancelled and WHY. A null actor
    // (system watchdog) still notifies the rider so they are not stranded
    // wondering what happened to their pickup.
    const actorRole: 'rider' | 'driver' | 'system' =
      cancelledBy === null
        ? 'system'
        : cancelledBy === trip.driver_id
          ? 'driver'
          : 'rider';
    const notified = trip.driver_id
      ? actorRole === 'driver'
        ? trip.rider_id
        : actorRole === 'rider'
          ? trip.driver_id
          : trip.rider_id
      : null;
    if (notified) {
      const recipientRole: 'rider' | 'driver' = actorRole === 'driver' ? 'rider' : 'driver';
      const cancellerRole: PartyRole = actorRole === 'driver' ? 'DRIVER' : 'RIDER';
      // Push copy uses a human label (never the raw code); the code + free
      // text ride along in `data` for the in-app dialog.
      notifyRideCancelled(
        notified,
        recipientRole,
        tripId,
        actorRole,
        reasonCode ? cancellationReasonLabel(cancellerRole, reasonCode) : undefined,
        reasonText ?? undefined,
      ).catch(() => undefined);
    }

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
