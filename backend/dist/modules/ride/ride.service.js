"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.RideService = void 0;
// backend/src/modules/ride/ride.service.ts
console.log('[SVC_INIT] ride.service.ts loaded at', new Date().toISOString());
const ride_repository_1 = require("./ride.repository");
console.log('[SVC_INIT] FULL findCurrentByDriverId toString:\n' + (ride_repository_1.RideRepository?.findCurrentByDriverId?.toString() || 'undefined'));
const locations_service_1 = require("../location/locations.service");
const geospatial_service_1 = require("../geospatial/geospatial.service");
const types_1 = require("../../types");
const env_1 = require("../../config/env");
const io_handle_1 = require("../../gateway/io-handle");
const database_1 = require("../../config/database");
const redis_1 = require("../../config/redis");
const pricing_service_1 = require("../../services/pricing.service");
const navigation_service_1 = require("../../services/navigation.service");
const route_store_service_1 = require("../../services/route-store.service");
const speeding_detector_1 = require("../../services/speeding_detector");
const driver_service_1 = require("../driver/driver.service");
const testUser_1 = require("../../utils/testUser");
const queue_1 = require("../../queue/queue");
const metrics_1 = require("../../observability/metrics");
const tracing_1 = require("../../utils/tracing");
const reward_engine_service_1 = require("../../services/reward-engine.service");
const wallet_service_1 = require("../wallet/wallet.service");
const financial_ledger_service_1 = require("../../services/financial-ledger.service");
const special_redemption_service_1 = require("../sponsor/special-redemption.service");
const notification_service_1 = require("../../services/notification.service");
const report_reasons_1 = require("../reporting/report.reasons");
/** Display name of a platform user (used in notification copy). */
async function fetchDisplayName(userId) {
    try {
        const res = await database_1.pool.query('SELECT full_name FROM users WHERE id = $1', [userId]);
        return res.rows[0]?.full_name || 'Your driver';
    }
    catch {
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
function applyDriverPrePickupCancelPenalty(userId) {
    database_1.pool
        .query(`UPDATE users
          SET rating = GREATEST(1.0, ROUND((rating - $1)::numeric, 2))
        WHERE id = $2`, [DRIVER_PRE_PICKUP_CANCEL_STAR_PENALTY, userId])
        .then(() => database_1.pool.query(`UPDATE drivers
            SET rating = GREATEST(1.0, ROUND((rating - $1)::numeric, 2))
          WHERE user_id = $2`, [DRIVER_PRE_PICKUP_CANCEL_STAR_PENALTY, userId]))
        .catch((err) => console.error(`[RIDE] ⚠️ Failed to apply driver pre-pickup cancel star penalty: ${err.message}`));
}
class RideService {
    static async rateRide(data) {
        const client = await database_1.pool.connect();
        try {
            await client.query('BEGIN');
            // 1. Check Ride
            const rideRes = await client.query('SELECT * FROM rides WHERE id = $1', [data.ride_id]);
            const ride = rideRes.rows[0];
            if (!ride)
                throw new Error('Ride not found');
            if (ride.status !== 'COMPLETED')
                throw new Error('Ride is not completed');
            // Determine roles
            let target_id;
            let target_role;
            if (ride.rider_id === data.rater_id) {
                // Rider is rating Driver
                if (!ride.driver_id)
                    throw new Error('No driver assigned to this ride');
                target_id = ride.driver_id;
                target_role = 'DRIVER';
            }
            else if (ride.driver_id === data.rater_id) {
                // Driver is rating Rider
                target_id = ride.rider_id;
                target_role = 'RIDER';
            }
            else {
                throw new Error('Unauthorized');
            }
            // 2. Check if already rated by this person for this ride
            const existingRating = await client.query('SELECT id FROM ratings WHERE ride_id = $1 AND rater_id = $2', [data.ride_id, data.rater_id]);
            if (existingRating.rows.length > 0) {
                // IDEMPOTENT (mirrors cancelTrip): a double-tap, a retry after a
                // lost response, or a re-submit from a re-rendered rating screen
                // must NEVER trap the user on a 400. The existing rating IS the
                // answer — return it as success.
                await client.query('COMMIT');
                return { id: existingRating.rows[0].id, ride_id: data.ride_id, rater_id: data.rater_id, alreadyRated: true };
            }
            // 3. Create Rating
            // Flag for admin review when a low rating (<3) is left with a note.
            const flagged = data.rating < 3 && !!data.review_text && String(data.review_text).trim().length > 0;
            const ratingRes = await client.query(`INSERT INTO ratings (ride_id, rater_id, target_id, target_role, rating, review_text, flagged_for_review)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`, [data.ride_id, data.rater_id, target_id, target_role, data.rating, data.review_text, flagged]);
            // 4. Update Target Rating (Moving Average of last 100)
            const lastRatings = await client.query(`SELECT rating FROM ratings WHERE target_id = $1 ORDER BY created_at DESC LIMIT 100`, [target_id]);
            const totalRatingsCount = parseInt((await client.query('SELECT COUNT(*) FROM ratings WHERE target_id = $1', [target_id])).rows[0].count);
            let newRating = 5.0;
            if (totalRatingsCount >= 100) {
                const sum = lastRatings.rows.reduce((acc, curr) => acc + curr.rating, 0);
                newRating = parseFloat((sum / lastRatings.rows.length).toFixed(1));
            }
            // Update User table rating for everyone
            await client.query('UPDATE users SET rating = $1, rating_count = $2 WHERE id = $3', [newRating, totalRatingsCount, target_id]);
            // If target is a driver, also update drivers table for redundancy/legacy compatibility
            if (target_role === 'DRIVER') {
                await client.query('UPDATE drivers SET rating = $1, total_rides = total_rides + 1 WHERE user_id = $2', [newRating, target_id]);
            }
            await client.query('COMMIT');
            return ratingRes.rows[0];
        }
        catch (e) {
            await client.query('ROLLBACK');
            throw e;
        }
        finally {
            client.release();
        }
    }
    static async requestRide(riderId, pickup, destination, scheduledAt, isScheduled = false, idempotencyKey, rewards = {}, favoritePriority = false) {
        return (0, tracing_1.traceAsync)('RideService.requestRide', async () => {
            const traceId = (0, tracing_1.getCurrentTraceId)();
            console.log(`[RIDE] New request from rider ${riderId}${isScheduled ? ' [SCHEDULED]' : ''} [trace=${traceId}]. Pickup: ${pickup.lat}, ${pickup.lng}`);
            // Idempotency: if key provided, check for existing ride
            if (idempotencyKey) {
                const existing = await database_1.pool.query(`SELECT * FROM rides WHERE idempotency_key = $1 AND rider_id = $2`, [idempotencyKey, riderId]);
                if (existing.rows.length > 0) {
                    console.log(`[RIDE] ♻️ Idempotent request - returning existing trip ${existing.rows[0].id}`);
                    const existingTrip = await ride_repository_1.RideRepository.findById(existing.rows[0].id);
                    if (!existingTrip)
                        throw new Error('Idempotent ride not found');
                    return existingTrip;
                }
            }
            // Snapshot rider rating
            const riderRes = await database_1.pool.query('SELECT rating FROM users WHERE id = $1', [riderId]);
            const snapshotRating = riderRes.rows[0]?.rating || 5.0;
            // Get Route
            const routeStart = Date.now();
            const route = await geospatial_service_1.GeospatialService.getRoute([pickup.lat, pickup.lng], [destination.lat, destination.lng]).catch(() => null);
            console.log(`[RIDE] Route fetched in ${Date.now() - routeStart}ms (cached=${route != null})`);
            const distanceKm = route ? (route.distance / 1000) : 10.0;
            const etaSeconds = route ? route.eta : 600;
            // Every ride request runs through one transactional path: ride INSERT
            // + price snapshot + promo/credits/wallet all commit atomically. A
            // failed promo/credits application aborts the entire request so the
            // rider can fix the code and re-request. The wallet is the default
            // payment method — it is charged the fare remaining after discounts.
            const client = await database_1.pool.connect();
            let tripId;
            try {
                await client.query('BEGIN');
                const res = await client.query(`INSERT INTO rides (
            rider_id, status, pickup_lat, pickup_lng, pickup_address,
            destination_lat, destination_lng, destination_address,
            requested_class, snapshot_rider_rating, scheduled_at, is_scheduled,
            distance_meters, duration_seconds, idempotency_key
          )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
           RETURNING id`, [
                    riderId,
                    types_1.TripStatus.REQUESTED,
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
                ]);
                tripId = res.rows[0].id;
                const breakdown = await (0, pricing_service_1.createPriceSnapshot)(tripId, {
                    distanceMeters: route ? route.distance : distanceKm * 1000,
                    durationSeconds: etaSeconds,
                }, client);
                await reward_engine_service_1.RewardEngine.applyToRideRequest(client, {
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
                    await special_redemption_service_1.SpecialRedemptionService.attachToRideRequest(client, {
                        riderId,
                        rideId: tripId,
                        fareCents: Math.round(breakdown.totalFare * 100),
                        specialRedemptionId: rewards.specialRedemptionId,
                    });
                }
                await client.query('COMMIT');
            }
            catch (err) {
                try {
                    await client.query('ROLLBACK');
                }
                catch { /* noop */ }
                throw err;
            }
            finally {
                client.release();
            }
            const trip = await ride_repository_1.RideRepository.findById(tripId);
            if (!trip)
                throw new Error('Failed to create trip record');
            if (route) {
                trip.route_geometry = route.geometry;
                // Persist the rider-generated route as the authoritative
                // destination leg (pickup → destination). The driver reuses it
                // at IN_PROGRESS instead of requesting another Google route.
                route_store_service_1.RouteStoreService.saveRideRoute({
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
                if (env_1.env.LEGACY_SYNC_MATCHING) {
                    // In-process dispatch (no BullMQ worker in this environment). Uses
                    // the same DispatchEngine/offer pipeline as the queue handler.
                    Promise.resolve().then(() => __importStar(require('../../services/matching.service'))).then(({ matchingService }) => {
                        matchingService.findAndDispatch((0, io_handle_1.getIo)(), trip.id, pickup.lat, pickup.lng, riderId, favoritePriority).catch((err) => console.error('[RIDE] In-process dispatch failed:', err.message));
                    });
                }
                else {
                    queue_1.matchQueue.add('matchRide', {
                        tripId: trip.id,
                        pickupLat: pickup.lat,
                        pickupLng: pickup.lng,
                        riderId,
                        favoritePriority,
                    }).catch((err) => console.error('[RIDE] Failed to enqueue match job:', err.message));
                    metrics_1.matchJobsTotal.inc({ outcome: 'enqueued' });
                }
            }
            // Rewards bookkeeping (non-blocking): referral state machine progress.
            reward_engine_service_1.RewardEngine.onRideRequested({ id: trip.id, rider_id: riderId, driver_id: null, fare_amount: null, status: 'REQUESTED' })
                .catch((err) => console.error(`[RIDE] ⚠️ onRideRequested failed: ${err.message}`));
            return trip;
        });
    }
    static async acceptTrip(tripId, driverId) {
        const trip = await ride_repository_1.RideRepository.findById(tripId);
        if (!trip)
            throw new Error('Trip not found');
        // Idempotent re-accept: the same driver accepting the same trip again
        // (socket retransmit, double-tap) is a success, not an error — the
        // trip is already assigned to this driver.
        if (trip.driver_id === driverId &&
            (trip.status === 'ACCEPTED' || trip.status === 'IN_PROGRESS')) {
            return trip;
        }
        if (trip.status !== 'REQUESTED')
            throw new Error('Trip already taken or cancelled');
        // Driver-specific exclusion (spec §16/§12): a driver who rejected this
        // ride BEFORE accepting, or ACCEPTED then CANCELLED it, must never be
        // assigned again — even if a stale accept emit arrives late (old offer
        // id, listener replay, double tap around the release). The dispatch
        // pipeline already excludes these drivers; this is the authoritative
        // per-accept guard so no stale client action can resurrect them.
        const { RideRejectionService } = await Promise.resolve().then(() => __importStar(require('../../services/ride-rejection.service')));
        if (await RideRejectionService.hasRejected(tripId, driverId)) {
            throw new Error('You have already declined or cancelled this ride.');
        }
        // Security: Ensure driver doesn't have another active trip. A stale
        // Redis key from a prior run (e.g. previous smoke test that crashed
        // before pickup) would otherwise block this driver permanently.
        const activeTripId = await redis_1.redis.get(`driver:${driverId}:active_trip`);
        if (activeTripId) {
            // If the cached trip is already terminal (COMPLETED/CANCELLED) in
            // Postgres, the key is stale — drop it and continue. Otherwise the
            // driver genuinely has an active trip in progress and we must refuse.
            const activeTrip = await ride_repository_1.RideRepository.findById(activeTripId);
            if (!activeTrip || activeTrip.status === 'COMPLETED' || activeTrip.status === 'CANCELLED') {
                console.log(`[RIDE] 🧹 Clearing stale active_trip key for driver ${driverId} (was ${activeTripId}, status=${activeTrip?.status})`);
                await redis_1.redis.del(`driver:${driverId}:active_trip`);
            }
            else {
                throw new Error('You already have an active trip. Complete it before accepting another.');
            }
        }
        // Validate that this driver has an active offer for this ride.
        // This prevents stale acceptances (e.g., driver accepts after timeout)
        // and ensures the driver was actually offered this ride.
        const { DriverOfferService, OfferStatus } = await Promise.resolve().then(() => __importStar(require('../../services/driver-offer.service')));
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
            }
            else if (rideOffer.status === OfferStatus.EXPIRED) {
                throw new Error('This ride offer has expired.');
            }
            else {
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
        const snapshot = await (0, pricing_service_1.getSnapshotForRide)(tripId);
        const finalFare = snapshot
            ? snapshot.final_fare
            : (0, pricing_service_1.computeEstimate)({
                distanceMeters: (trip.distance_km || 10.0) * 1000,
                durationSeconds: (trip.duration_minutes ? trip.duration_minutes * 60 : 600),
            }).totalFare;
        // Capture Compliance Snapshot
        const driverProfile = await database_1.pool.query(`SELECT d.*, dv.inspection_photo_url, dv.inspection_expiry_date, dv.inspection_status, dv.license_plate_number
       FROM drivers d
       LEFT JOIN driver_vehicles dv ON d.user_id = dv.driver_id
       WHERE d.user_id = $1`, [driverId]);
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
        const acceptRes = await database_1.pool.query(`UPDATE rides
          SET status = $2, driver_id = $3, accepted_at = $4,
              compliance_snapshot = $5, fare_amount = $6
        WHERE id = $1 AND status = $7
        RETURNING id`, [tripId, 'ACCEPTED', driverId, new Date(), JSON.stringify(complianceSnapshot), finalFare, types_1.TripStatus.REQUESTED]);
        if ((acceptRes.rowCount ?? 0) === 0) {
            await DriverOfferService.supersedeOffer(rideOffer.offerId);
            const latest = await ride_repository_1.RideRepository.findById(tripId);
            if (latest?.status === types_1.TripStatus.CANCELLED) {
                throw new Error('This ride was cancelled by the rider.');
            }
            throw new Error('Trip already taken or cancelled');
        }
        const updatedTrip = await ride_repository_1.RideRepository.findById(tripId);
        if (!updatedTrip)
            throw new Error('Failed to load accepted trip');
        // Persist the per-ride revenue allocation (the driver — and thus the
        // fleet partner share — is now known). Never blocks the accept path;
        // the wallet credit at completion falls back to a live computation
        // when this write is missing.
        (0, pricing_service_1.persistRevenueAllocation)(tripId, driverId, Math.round(finalFare * 100))
            .catch((err) => console.error(`[RIDE] ⚠️ Revenue allocation persist failed: ${err.message}`));
        // Cache active trip for trajectory buffering
        await redis_1.redis.set(`driver:${driverId}:active_trip`, tripId, 'EX', 14400); // 4h safety TTL
        // Step 4: Parallel fan-out — record winner and cancel other offers
        await redis_1.redis.set(`dispatch:winners:${tripId}`, driverId, 'EX', 300);
        const dispatchedJson = await redis_1.redis.get(`match:queue:dispatched:${tripId}`);
        if (dispatchedJson) {
            const dispatchedDrivers = JSON.parse(dispatchedJson);
            for (const did of dispatchedDrivers) {
                if (did !== driverId) {
                    (0, io_handle_1.getIo)().to(`driver:${did}`).emit('tripUpdate', {
                        ...trip,
                        status: types_1.TripStatus.CANCELLED,
                        cancelReason: 'Another driver accepted this trip',
                    });
                    metrics_1.dispatchAcceptOutcomeTotal.inc({ outcome: 'cancelled' });
                }
            }
            await redis_1.redis.del(`match:queue:dispatched:${tripId}`);
        }
        await redis_1.redis.del(`dispatch:lock:${tripId}`);
        await redis_1.redis.del(`dispatch:${tripId}`);
        const driverLoc = await locations_service_1.LocationsService.getDriverLocation(driverId);
        updatedTrip.driver_location = driverLoc;
        // Navigation cache + route_metadata for the pickup leg. We resolve
        // the route via the routing service, cache it for the speeding detector + driver
        // app, persist a snapshot on the ride, and emit the start event.
        if (driverLoc) {
            try {
                const pickupRoute = await navigation_service_1.NavigationService.cacheRouteLeg(tripId, 'pickup', [driverLoc.lat, driverLoc.lng], [trip.pickup.lat, trip.pickup.lng]);
                await database_1.pool.query(`UPDATE rides SET route_metadata = route_metadata || $1::jsonb WHERE id = $2`, [JSON.stringify({ pickup: pickupRoute }), tripId]);
                navigation_service_1.NavigationService.emitStarted((0, io_handle_1.getIo)(), tripId, driverId, trip.rider_id, 'pickup', pickupRoute);
            }
            catch (err) {
                console.error(`[RIDE] ⚠️ pickup route cache failed: ${err.message}`);
            }
        }
        (0, io_handle_1.getIo)().to(`rider:${trip.rider_id}`).emit('tripUpdate', updatedTrip);
        (0, io_handle_1.getIo)().to(`driver:${driverId}`).emit('tripUpdate', updatedTrip);
        metrics_1.dispatchAcceptOutcomeTotal.inc({ outcome: 'accepted' });
        // Broadcast to Admin Monitoring
        (0, io_handle_1.getIo)().to('monitoring:all_rides').emit('tripUpdate', updatedTrip);
        // Real phone notification: driver accepted the ride. Deduplicated by
        // eventId (ride:accepted:{tripId}) — never blocks the accept path.
        fetchDisplayName(driverId)
            .then((driverName) => (0, notification_service_1.notifyRideAccepted)(trip.rider_id, tripId, driverName, Math.round(finalFare * 100)))
            .catch(() => undefined);
        return updatedTrip;
    }
    static async updateTripStatus(tripId, status, userId, opts = {}) {
        const trip = await ride_repository_1.RideRepository.findById(tripId);
        if (!trip)
            throw new Error('Trip not found');
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
        const extra = {};
        if (status === 'IN_PROGRESS')
            extra.started_at = new Date();
        if (status === 'COMPLETED') {
            extra.completed_at = new Date();
            // Trajectory snapshot + cache cleanup are best-effort: a Redis blip
            // must NEVER abort the completion before the DB update and the
            // tripUpdate broadcast — otherwise the ride stays IN_PROGRESS in
            // the DB while both apps keep showing the ride (and the driver app
            // has already "celebrated" a completion that never happened).
            try {
                const trajectory = await locations_service_1.LocationsService.getTrajectory(tripId);
                extra.trajectory = JSON.stringify(trajectory);
            }
            catch (err) {
                console.warn(`[RIDE] ⚠️ Trajectory read failed (non-blocking) for trip ${tripId}: ${err.message}`);
            }
            try {
                await redis_1.redis.del(`driver:${userId}:active_trip`);
                await locations_service_1.LocationsService.clearTrajectory(tripId);
                await navigation_service_1.NavigationService.clearTrip(tripId);
            }
            catch (err) {
                console.warn(`[RIDE] ⚠️ Trip cache cleanup failed (non-blocking) for trip ${tripId}: ${err.message}`);
            }
            // TODO: Calculate distance/fare based on trajectory if needed
        }
        const updatedTrip = await ride_repository_1.RideRepository.updateStatus(tripId, status, extra);
        if (updatedTrip.driver_id) {
            const driverLoc = await locations_service_1.LocationsService.getDriverLocation(updatedTrip.driver_id);
            updatedTrip.driver_location = driverLoc;
        }
        // Navigation lifecycle: when the driver flips ACCEPTED → IN_PROGRESS
        // we cache the destination leg and emit legAdvanced so the rider
        // sees "now heading to destination" and the driver swaps route.
        if (status === 'IN_PROGRESS' && updatedTrip.driver_id) {
            try {
                const driverLoc = await locations_service_1.LocationsService.getDriverLocation(userId);
                if (driverLoc) {
                    // Reuse the rider-generated route (stored at request time) when
                    // the driver is at/near pickup and the route is fresh — no
                    // Google call. Only fall back to a fresh computation otherwise.
                    const storedDest = await route_store_service_1.RouteStoreService.getRideRoute(tripId, 'destination');
                    let destRoute = null;
                    if (storedDest && storedDest.geometry.coordinates.length >= 2) {
                        const ageMs = Date.now() - new Date(storedDest.createdAt).getTime();
                        const pickupDistM = (0, route_store_service_1.haversineMeters)([driverLoc.lat, driverLoc.lng], [updatedTrip.pickup.lat, updatedTrip.pickup.lng]);
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
                        destRoute = await navigation_service_1.NavigationService.cacheRouteLeg(tripId, 'destination', [driverLoc.lat, driverLoc.lng], [updatedTrip.destination.lat, updatedTrip.destination.lng]);
                    }
                    await database_1.pool.query(`UPDATE rides SET route_metadata = route_metadata || $1::jsonb WHERE id = $2`, [JSON.stringify({ destination: destRoute }), tripId]);
                    navigation_service_1.NavigationService.emitLegAdvanced((0, io_handle_1.getIo)(), tripId, updatedTrip.driver_id, updatedTrip.rider_id, destRoute);
                }
            }
            catch (err) {
                console.error(`[RIDE] ⚠️ destination route cache failed: ${err.message}`);
            }
        }
        // Trip end: finalize the safety pipeline and notify navigation.
        if (status === 'COMPLETED' && updatedTrip.driver_id) {
            await speeding_detector_1.SpeedingDetector.finalizeTrip(updatedTrip.driver_id, tripId);
            navigation_service_1.NavigationService.emitEnded((0, io_handle_1.getIo)(), tripId, updatedTrip.driver_id, updatedTrip.rider_id);
            // Wallet credit: every completed ride deposits fare + tip into the
            // driver's wallet. Wrapped in try/catch so a wallet bug cannot block
            // the trip end / socket emit. Idempotent via partial UNIQUE INDEX on
            // payouts(ride_id) WHERE method='RIDE_CREDIT'.
            try {
                const fareCents = Math.round(parseFloat(updatedTrip.fare_amount ?? '0') * 100);
                const tipCents = Math.round(parseFloat(updatedTrip.tip_amount ?? '0') * 100);
                const totalCents = fareCents + tipCents;
                // Test-mode bypass: when both the rider and the driver are test
                // accounts, we still credit the driver wallet (so the test driver
                // grows their balance and the wallet math stays exercised) but
                // we skip anything rider-side that would require a real payment
                // method. The end result is the same as a normal completed ride,
                // just without a payment hold.
                const isTestTrip = await (0, testUser_1.areBothTestUsers)(updatedTrip.rider_id, updatedTrip.driver_id);
                if (isTestTrip) {
                    console.log(`[RIDE] 🧪 Test-mode: bypassed rider payment, auto-credited driver wallet (trip=${tripId}, $${(totalCents / 100).toFixed(2)})`);
                }
                if (totalCents > 0) {
                    await driver_service_1.DriverService.creditOnRideComplete(updatedTrip.driver_id, fareCents, tipCents, tripId);
                }
            }
            catch (err) {
                console.warn(`[RIDE] ⚠️ Wallet credit failed (non-blocking) for trip ${tripId}: ${err.message}`);
            }
            // Rider payment: the wallet is charged ONLY when the ride completes
            // successfully — never at request (a cancelled ride costs nothing).
            // Settles the amount reserved at request time (final_payment_cents =
            // fare after promo + credits, stored as integer cents). Idempotent via
            // the wallet ledger's unique idempotency key (wallet-charge:{rideId});
            // non-blocking so a wallet issue can never strand an already-completed
            // trip.
            let walletChargeCents = 0;
            const dueCents = (0, financial_ledger_service_1.centsValue)(updatedTrip.final_payment_cents);
            try {
                if (dueCents > 0) {
                    const charged = await wallet_service_1.WalletService.chargeForRide(updatedTrip.rider_id, tripId, dueCents);
                    walletChargeCents = charged.walletChargeCents;
                    if (charged.walletChargeCents > 0) {
                        await database_1.pool.query(`UPDATE rides SET wallet_payment_cents = $1 WHERE id = $2`, [charged.walletChargeCents, tripId]);
                        (0, notification_service_1.notifyWalletCharged)(updatedTrip.rider_id, charged.walletChargeCents, tripId).catch(() => undefined);
                    }
                }
            }
            catch (err) {
                console.warn(`[RIDE] ⚠️ Rider wallet charge failed (non-blocking) for trip ${tripId}: ${err.message}`);
            }
            // Driver earnings (60% share, from the persisted allocation) ride along
            // on the payload so the driver app never computes money client-side.
            const allocation = await (0, pricing_service_1.getRevenueAllocationForRide)(tripId);
            if (allocation) {
                updatedTrip.driver_earnings_cents = allocation.driverShareCents;
            }
            // Financial settlement: exactly one ledger row per completed ride.
            // Idempotent (ride_completion:{rideId} idempotency key + partial unique
            // index on ride_id). Settled only when the full amount due is covered;
            // a shortfall is recorded as PENDING_CAPTURE with the outstanding
            // cents so failed/short payments stay explicit.
            try {
                const tipCents = Math.round(parseFloat(updatedTrip.tip_amount ?? '0') * 100);
                await financial_ledger_service_1.FinancialLedgerService.recordRideCompletion({
                    rideId: tripId,
                    riderId: updatedTrip.rider_id,
                    driverId: updatedTrip.driver_id,
                    fareCents: dueCents,
                    promotionCents: (0, financial_ledger_service_1.centsValue)(updatedTrip.promo_discount_cents),
                    creditsCents: (0, financial_ledger_service_1.centsValue)(updatedTrip.credits_applied_cents),
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
            }
            catch (err) {
                console.warn(`[RIDE] ⚠️ Financial ledger write failed (non-blocking) for trip ${tripId}: ${err.message}`);
            }
            // Rewards ecosystem: finalize promo usage + partner commission and
            // grant any referral rewards. Non-blocking — must never block the
            // trip end. Fully idempotent (unique guards on every table).
            reward_engine_service_1.RewardEngine.onRideCompleted({
                id: tripId,
                rider_id: updatedTrip.rider_id,
                driver_id: updatedTrip.driver_id,
                fare_amount: updatedTrip.fare_amount ?? null,
                status: 'COMPLETED',
            }).catch((err) => console.error(`[RIDE] ⚠️ RewardEngine.onRideCompleted failed: ${err.message}`));
            // Sponsorship/SPECIALS: the completed special ride now issues the
            // one-time validation code (hash-only, TTL). Non-blocking + idempotent;
            // no-op for regular rides (no redemption attached).
            special_redemption_service_1.SpecialRedemptionService.onRideCompleted(tripId, updatedTrip.rider_id)
                .catch((err) => console.error(`[RIDE] ⚠️ SpecialRedemptionService.onRideCompleted failed: ${err.message}`));
        }
        (0, io_handle_1.getIo)().to(`rider:${updatedTrip.rider_id}`).emit('tripUpdate', updatedTrip);
        if (updatedTrip.driver_id) {
            (0, io_handle_1.getIo)().to(`driver:${updatedTrip.driver_id}`).emit('tripUpdate', updatedTrip);
        }
        // Broadcast to Admin Monitoring
        (0, io_handle_1.getIo)().to('monitoring:all_rides').emit('tripUpdate', updatedTrip);
        // Real phone notifications (fire-and-forget, deduped by eventId):
        if (status === 'IN_PROGRESS' && updatedTrip.driver_id) {
            fetchDisplayName(updatedTrip.driver_id)
                .then((driverName) => (0, notification_service_1.notifyRideStarted)(updatedTrip.rider_id, tripId, driverName))
                .catch(() => undefined);
        }
        else if (status === 'COMPLETED') {
            const fareCents = Math.round(parseFloat(updatedTrip.fare_amount ?? '0') * 100);
            (0, notification_service_1.notifyRideCompleted)(updatedTrip.rider_id, tripId, fareCents).catch(() => undefined);
        }
        return updatedTrip;
    }
    static async cancelTrip(tripId, userId, opts = {}) {
        const trip = await ride_repository_1.RideRepository.findById(tripId);
        if (!trip)
            throw new Error('Trip not found');
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
        const isDriverPrePickupCancel = userId === trip.driver_id &&
            (trip.status === types_1.TripStatus.ACCEPTED || trip.status === types_1.TripStatus.DRIVER_ARRIVING);
        // Accepted-ride cancellation by the DRIVER mid-trip (IN_PROGRESS) is a
        // terminal cancellation (not a "release + re-match"): both parties see
        // the terminal state, and both may report each other afterwards. The
        // driver stays on the ride row so history + reporting work.
        // Audit trail: who initiated the cancel and why. Null for system
        // cancels (cleanup/timeouts), which never pass through here.
        const extra = {
            cancelled_at: new Date(),
            cancelled_by: userId,
            cancellation_reason_code: opts.reasonCode ?? null,
            cancellation_reason_text: (opts.reasonText ?? '').trim().slice(0, 300) || null,
        };
        // If driver was assigned, cleanup trajectory
        if (trip.driver_id) {
            const trajectory = await locations_service_1.LocationsService.getTrajectory(tripId);
            // For a pre-pickup release the partial approach trajectory of the
            // departing driver is discarded — the ride will be driven fresh by
            // the next driver, and this GPS data must never leak into the final
            // ride's "actual route" (admin maps).
            if (trajectory.length > 0 && !isDriverPrePickupCancel) {
                extra.trajectory = JSON.stringify(trajectory);
            }
            await redis_1.redis.del(`driver:${trip.driver_id}:active_trip`);
            await locations_service_1.LocationsService.clearTrajectory(tripId);
            await navigation_service_1.NavigationService.clearTrip(tripId);
        }
        // Release any dispatched driver offer first so a driver can never accept
        // a request that is being cancelled. Idempotent — safe to run on every
        // path (socket, REST, system cleanup).
        if (trip.status === types_1.TripStatus.REQUESTED) {
            const { DriverOfferService } = await Promise.resolve().then(() => __importStar(require('../../services/driver-offer.service')));
            await DriverOfferService.cancelRideOffers(tripId);
        }
        // ------------------------------------------------------------------
        // DRIVER PRE-PICKUP CANCEL → release + re-match the same ride
        // ------------------------------------------------------------------
        if (isDriverPrePickupCancel) {
            // Atomic release: the transaction verifies (a) this driver is STILL
            // the assigned driver and (b) the ride is still in a pre-pickup
            // state — a stale/delayed cancel from a previous driver can never
            // clobber a newer assignment (spec §16/§17), and a rider cancel that
            // commits first wins deterministically. The same transaction then
            // persists the ACCEPTED_THEN_CANCELLED exclusion so the departing
            // driver can never be offered this ride again on the re-match.
            const client = await database_1.pool.connect();
            let releaseRes;
            try {
                await client.query('BEGIN');
                releaseRes = await client.query(ride_repository_1.RELEASE_DRIVER_PRE_PICKUP_SQL, [
                    tripId,
                    userId,
                    types_1.TripStatus.REQUESTED,
                    types_1.TripStatus.ACCEPTED,
                    types_1.TripStatus.DRIVER_ARRIVING,
                ]);
                if ((releaseRes.rowCount ?? 0) > 0) {
                    await client.query(ride_repository_1.UPSERT_DRIVER_RIDE_INTERACTION_SQL, [
                        tripId,
                        userId,
                        'ACCEPTED_THEN_CANCELLED',
                        'ACCEPTED_THEN_CANCELLED',
                        opts.reasonCode ?? null,
                        (opts.reasonText ?? '').trim().slice(0, 300) || null,
                    ]);
                }
                await client.query('COMMIT');
            }
            catch (err) {
                try {
                    await client.query('ROLLBACK');
                }
                catch { /* noop */ }
                throw err;
            }
            finally {
                client.release();
            }
            if ((releaseRes.rowCount ?? 0) === 0) {
                // The ride already flipped (duplicate emit, or another actor took
                // it over) — answer with the latest authoritative state. No second
                // penalty, no state clobber.
                const latest = await ride_repository_1.RideRepository.findById(tripId);
                return latest ?? trip;
            }
            // Clear the previous assignment's dispatch residue so the fresh
            // matching pass starts clean: winner marker, dispatched-offer list,
            // and the departing driver's offer slot (the old offer must never be
            // re-read or answered by a stale tap). The ride-level match lock is
            // deliberately NOT deleted here — it serializes matchers; a live
            // in-flight matcher still holding it must not be joined by a second
            // dispatcher (it unwinds and releases it as soon as it observes the
            // non-REQUESTED → REQUESTED transition; orphans expire via TTL).
            await Promise.all([
                redis_1.redis.del(`dispatch:winners:${tripId}`),
                redis_1.redis.del(`dispatch:${tripId}`),
                redis_1.redis.del(`ride:offer:${tripId}`),
            ]);
            // Star penalty + accepted-cancellation counter for every driver
            // pre-pickup cancel, reason given or not.
            applyDriverPrePickupCancelPenalty(userId);
            database_1.pool
                .query(`UPDATE drivers
              SET cancellation_count = COALESCE(cancellation_count, 0) + 1,
                  last_cancellation_at = NOW()
            WHERE user_id = $1`, [userId])
                .catch((err) => console.error(`[RIDE] ⚠️ Failed to increment driver cancellation counter: ${err.message}`));
            const rematchedTrip = await ride_repository_1.RideRepository.findById(tripId);
            if (!rematchedTrip)
                throw new Error('Failed to load released trip');
            // Safety + navigation teardown for the departing driver.
            await speeding_detector_1.SpeedingDetector.finalizeTrip(userId, tripId);
            navigation_service_1.NavigationService.emitEnded((0, io_handle_1.getIo)(), tripId, userId, trip.rider_id);
            // The cancelling driver sees THEIR OWN terminal cancel (who + why) so
            // their app settles the confirmation and returns home — never the
            // re-queued REQUESTED state of the ride they abandoned.
            (0, io_handle_1.getIo)().to(`driver:${userId}`).emit('tripUpdate', {
                ...rematchedTrip,
                rider_id: trip.rider_id,
                status: types_1.TripStatus.CANCELLED,
                cancelled_by: userId,
                cancelled_at: new Date(),
                cancellation_reason_code: opts.reasonCode ?? null,
                cancellation_reason_text: (opts.reasonText ?? '').trim().slice(0, 300) || null,
            });
            // Rider: authoritative REQUESTED state (same ride, same fare quote,
            // same promo + credits — nothing was recreated) + the apology notice.
            // The rider app pops the apology over the re-activated "finding your
            // driver" sheet; no re-request is needed.
            (0, io_handle_1.getIo)().to(`rider:${trip.rider_id}`).emit('tripUpdate', rematchedTrip);
            (0, io_handle_1.getIo)().to(`rider:${trip.rider_id}`).emit('tripDriverCancelled', {
                tripId,
                trip: rematchedTrip,
                reasonCode: opts.reasonCode ?? null,
                reasonText: (opts.reasonText ?? '').trim().slice(0, 300) || null,
            });
            (0, io_handle_1.getIo)().to('monitoring:all_rides').emit('tripUpdate', rematchedTrip);
            // Re-dispatch the SAME ride id through the regular pipeline.
            const pickup = rematchedTrip.pickup;
            if (env_1.env.LEGACY_SYNC_MATCHING) {
                Promise.resolve().then(() => __importStar(require('../../services/matching.service'))).then(({ matchingService }) => {
                    matchingService
                        .findAndDispatch((0, io_handle_1.getIo)(), tripId, pickup.lat, pickup.lng, trip.rider_id, false)
                        .catch((err) => console.error(`[RIDE] Re-dispatch after driver pre-pickup cancel failed: ${err.message}`));
                });
            }
            else {
                queue_1.matchQueue
                    .add('matchRide', {
                    tripId,
                    pickupLat: pickup.lat,
                    pickupLng: pickup.lng,
                    riderId: trip.rider_id,
                    favoritePriority: false,
                })
                    .catch((err) => console.error('[RIDE] Failed to enqueue re-match job:', err.message));
                metrics_1.matchJobsTotal.inc({ outcome: 'enqueued' });
            }
            return rematchedTrip;
        }
        // Idempotent terminal transition handled in the shared helper (below):
        // a concurrent ACCEPT that commits between our read and this update
        // wins the race — we never overwrite a fresher state.
        return RideService._terminalCancel(trip, extra.cancelled_by, extra.cancellation_reason_code, extra.cancellation_reason_text);
    }
    /**
     * System-driven terminal cancellation (stale-ride watchdog / boots-time
     * reconciliation). No human actor: `cancelled_by` stays NULL, no reason
     * code is required, and there is NO pre-pickup rematch — the ride is
     * dissolved permanently so neither party's app can keep routing to it.
     * Idempotent — safe to call repeatedly from every cleanup tick.
     */
    static async cancelTripSystem(tripId, opts = {}) {
        const trip = await ride_repository_1.RideRepository.findById(tripId);
        if (!trip)
            return null;
        if (trip.status === 'CANCELLED')
            return trip; // idempotent
        if (trip.status === 'COMPLETED')
            return trip; // never un-complete
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
            const trajectory = await locations_service_1.LocationsService.getTrajectory(tripId);
            if (trajectory.length > 0) {
                await database_1.pool.query(`UPDATE rides SET trajectory = $1 WHERE id = $2`, [
                    JSON.stringify(trajectory),
                    tripId,
                ]);
            }
            await redis_1.redis.del(`driver:${trip.driver_id}:active_trip`);
            await locations_service_1.LocationsService.clearTrajectory(tripId);
            await navigation_service_1.NavigationService.clearTrip(tripId);
        }
        if (trip.status === types_1.TripStatus.REQUESTED) {
            const { DriverOfferService } = await Promise.resolve().then(() => __importStar(require('../../services/driver-offer.service')));
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
    static async _terminalCancel(trip, cancelledBy, reasonCode, reasonText) {
        const tripId = trip.id;
        // Atomic transition: the WHERE guard means a concurrent ACCEPT that
        // commits between our read and this update wins the race — we never
        // overwrite a fresher state (accept-vs-cancel race safety).
        const cancelRes = await database_1.pool.query(`UPDATE rides
          SET status = $2, cancelled_at = $3, cancelled_by = $4,
              cancellation_reason_code = $5, cancellation_reason_text = $6
        WHERE id = $1 AND status IN ($7, $8, $9, $10)
        RETURNING id`, [
            tripId,
            types_1.TripStatus.CANCELLED,
            new Date(),
            cancelledBy,
            reasonCode,
            reasonText,
            types_1.TripStatus.REQUESTED,
            types_1.TripStatus.ACCEPTED,
            types_1.TripStatus.IN_PROGRESS,
            types_1.TripStatus.DRIVER_ARRIVING,
        ]);
        if ((cancelRes.rowCount ?? 0) === 0) {
            // Another actor flipped the ride between our read and the write
            // (driver accepted, or the ride was already cancelled/completed).
            const latest = await ride_repository_1.RideRepository.findById(tripId);
            if (latest?.status === types_1.TripStatus.CANCELLED)
                return latest; // idempotent
            throw new Error('Cannot cancel a ride that is already completed');
        }
        const updatedTrip = await ride_repository_1.RideRepository.findById(tripId);
        if (!updatedTrip)
            throw new Error('Failed to load cancelled trip');
        // Rewards ecosystem: void promo usage + refund applied credits.
        reward_engine_service_1.RewardEngine.onRideCancelled({
            id: tripId,
            rider_id: trip.rider_id,
            driver_id: trip.driver_id ?? null,
            fare_amount: trip.fare_amount ?? null,
            status: 'CANCELLED',
        }).catch((err) => console.error(`[RIDE] ⚠️ RewardEngine.onRideCancelled failed: ${err.message}`));
        // Sponsorship/SPECIALS: a TERMINAL cancellation voids any attached
        // redemption AND releases the reserved budget (spec §69 — a cancelled
        // ride never consumes sponsor funding). No-op for regular rides and for
        // driver pre-pickup rematches (the ride keeps REQUESTED and the special
        // stays intact for the next driver).
        special_redemption_service_1.SpecialRedemptionService.onRideCancelled(tripId)
            .catch((err) => console.error(`[RIDE] ⚠️ SpecialRedemptionService.onRideCancelled failed: ${err.message}`));
        // Safety + navigation teardown on cancel.
        if (trip.driver_id) {
            await speeding_detector_1.SpeedingDetector.finalizeTrip(trip.driver_id, tripId);
            navigation_service_1.NavigationService.emitEnded((0, io_handle_1.getIo)(), tripId, trip.driver_id, trip.rider_id);
        }
        // Authoritative state broadcast — both parties (and monitoring) react
        // to this same CANCELLED payload carrying cancelled_by + reason.
        (0, io_handle_1.getIo)().to(`rider:${trip.rider_id}`).emit('tripUpdate', updatedTrip);
        if (trip.driver_id) {
            (0, io_handle_1.getIo)().to(`driver:${trip.driver_id}`).emit('tripUpdate', updatedTrip);
        }
        (0, io_handle_1.getIo)().to('monitoring:all_rides').emit('tripUpdate', updatedTrip);
        // Real phone notification carrying WHO cancelled and WHY. A null actor
        // (system watchdog) still notifies the rider so they are not stranded
        // wondering what happened to their pickup.
        const actorRole = cancelledBy === null
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
            const recipientRole = actorRole === 'driver' ? 'rider' : 'driver';
            const cancellerRole = actorRole === 'driver' ? 'DRIVER' : 'RIDER';
            // Push copy uses a human label (never the raw code); the code + free
            // text ride along in `data` for the in-app dialog.
            (0, notification_service_1.notifyRideCancelled)(notified, recipientRole, tripId, actorRole, reasonCode ? (0, report_reasons_1.cancellationReasonLabel)(cancellerRole, reasonCode) : undefined, reasonText ?? undefined).catch(() => undefined);
        }
        return updatedTrip;
    }
    static async getHistory(userId, role) {
        if (role === 'driver') {
            return ride_repository_1.RideRepository.findByDriverId(userId);
        }
        return ride_repository_1.RideRepository.findByRiderId(userId);
    }
    static async getCurrentRide(userId, role) {
        console.log(`[RIDE] getCurrentRide userId=${userId} role=${role} RideRepository=${typeof ride_repository_1.RideRepository} fcdByDriverId=${typeof ride_repository_1.RideRepository.findCurrentByDriverId}`);
        let r;
        if (role === types_1.UserRole.DRIVER || role === 'driver' || role === 'DRIVER') {
            console.log('[RIDE] about to call RideRepository.findCurrentByDriverId');
            r = await ride_repository_1.RideRepository.findCurrentByDriverId(userId);
            console.log('[RIDE] returned from findCurrentByDriverId, r=', r?.id);
        }
        else {
            r = await ride_repository_1.RideRepository.findCurrentByRiderId(userId);
        }
        console.log(`[RIDE] getCurrentRide result=${r?.id} status=${r?.status} driver_id=${r?.driver_id}`);
        return r;
    }
    static async deleteHistory(rideId, userId) {
        return ride_repository_1.RideRepository.delete(rideId, userId);
    }
}
exports.RideService = RideService;
//# sourceMappingURL=ride.service.js.map