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
const app_1 = require("../../app");
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
const notification_service_1 = require("../../services/notification.service");
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
            if (existingRating.rows.length > 0)
                throw new Error('You have already rated this ride');
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
                queue_1.matchQueue.add('matchRide', {
                    tripId: trip.id,
                    pickupLat: pickup.lat,
                    pickupLng: pickup.lng,
                    riderId,
                    favoritePriority,
                }).catch((err) => console.error('[RIDE] Failed to enqueue match job:', err.message));
                metrics_1.matchJobsTotal.inc({ outcome: 'enqueued' });
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
        if (trip.status !== 'REQUESTED')
            throw new Error('Trip already taken or cancelled');
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
            if (rideOffer.status === OfferStatus.EXPIRED) {
                throw new Error('This ride offer has expired.');
            }
            throw new Error(`Offer is in state ${rideOffer.status} and cannot be accepted.`);
        }
        // Atomically accept the offer — this prevents race conditions where
        // two workers or two app clients both try to accept the same offer.
        const accepted = await DriverOfferService.acceptOffer(rideOffer.offerId);
        if (!accepted) {
            throw new Error('Failed to accept offer. It may have already been accepted or expired.');
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
        const updatedTrip = await ride_repository_1.RideRepository.updateStatus(tripId, 'ACCEPTED', {
            driver_id: driverId,
            accepted_at: new Date(),
            compliance_snapshot: JSON.stringify(complianceSnapshot),
            fare_amount: finalFare
        });
        // Cache active trip for trajectory buffering
        await redis_1.redis.set(`driver:${driverId}:active_trip`, tripId, 'EX', 14400); // 4h safety TTL
        // Step 4: Parallel fan-out — record winner and cancel other offers
        await redis_1.redis.set(`dispatch:winners:${tripId}`, driverId, 'EX', 300);
        const dispatchedJson = await redis_1.redis.get(`match:queue:dispatched:${tripId}`);
        if (dispatchedJson) {
            const dispatchedDrivers = JSON.parse(dispatchedJson);
            for (const did of dispatchedDrivers) {
                if (did !== driverId) {
                    app_1.io.to(`driver:${did}`).emit('tripUpdate', {
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
                navigation_service_1.NavigationService.emitStarted(app_1.io, tripId, driverId, trip.rider_id, 'pickup', pickupRoute);
            }
            catch (err) {
                console.error(`[RIDE] ⚠️ pickup route cache failed: ${err.message}`);
            }
        }
        app_1.io.to(`rider:${trip.rider_id}`).emit('tripUpdate', updatedTrip);
        app_1.io.to(`driver:${driverId}`).emit('tripUpdate', updatedTrip);
        metrics_1.dispatchAcceptOutcomeTotal.inc({ outcome: 'accepted' });
        // Broadcast to Admin Monitoring
        app_1.io.to('monitoring:all_rides').emit('tripUpdate', updatedTrip);
        // Real phone notification: driver accepted the ride. Deduplicated by
        // eventId (ride:accepted:{tripId}) — never blocks the accept path.
        fetchDisplayName(driverId)
            .then((driverName) => (0, notification_service_1.notifyRideAccepted)(trip.rider_id, tripId, driverName, Math.round(finalFare * 100)))
            .catch(() => undefined);
        return updatedTrip;
    }
    static async updateTripStatus(tripId, status, userId) {
        const trip = await ride_repository_1.RideRepository.findById(tripId);
        if (!trip)
            throw new Error('Trip not found');
        console.log(`[RIDE] updateTripStatus: tripId=${tripId} status=${status} userId=${userId} trip.driver_id=${trip.driver_id} match=${trip.driver_id === userId}`);
        // Security: Only the assigned driver can update progress
        if (trip.driver_id !== userId) {
            throw new Error('Unauthorized: You are not the assigned driver for this trip');
        }
        const extra = {};
        if (status === 'IN_PROGRESS')
            extra.started_at = new Date();
        if (status === 'COMPLETED') {
            extra.completed_at = new Date();
            // Retrieve and persist trajectory
            const trajectory = await locations_service_1.LocationsService.getTrajectory(tripId);
            extra.trajectory = JSON.stringify(trajectory);
            // Clear active trip cache
            await redis_1.redis.del(`driver:${userId}:active_trip`);
            await locations_service_1.LocationsService.clearTrajectory(tripId);
            await navigation_service_1.NavigationService.clearTrip(tripId);
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
                    navigation_service_1.NavigationService.emitLegAdvanced(app_1.io, tripId, updatedTrip.driver_id, updatedTrip.rider_id, destRoute);
                }
            }
            catch (err) {
                console.error(`[RIDE] ⚠️ destination route cache failed: ${err.message}`);
            }
        }
        // Trip end: finalize the safety pipeline and notify navigation.
        if (status === 'COMPLETED' && updatedTrip.driver_id) {
            await speeding_detector_1.SpeedingDetector.finalizeTrip(updatedTrip.driver_id, tripId);
            navigation_service_1.NavigationService.emitEnded(app_1.io, tripId, updatedTrip.driver_id, updatedTrip.rider_id);
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
                    await driver_service_1.DriverService.creditOnRideComplete(updatedTrip.driver_id, totalCents, tripId);
                }
            }
            catch (err) {
                console.warn(`[RIDE] ⚠️ Wallet credit failed (non-blocking) for trip ${tripId}: ${err.message}`);
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
        }
        app_1.io.to(`rider:${updatedTrip.rider_id}`).emit('tripUpdate', updatedTrip);
        if (updatedTrip.driver_id) {
            app_1.io.to(`driver:${updatedTrip.driver_id}`).emit('tripUpdate', updatedTrip);
        }
        // Broadcast to Admin Monitoring
        app_1.io.to('monitoring:all_rides').emit('tripUpdate', updatedTrip);
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
    static async cancelTrip(tripId, userId) {
        const trip = await ride_repository_1.RideRepository.findById(tripId);
        if (!trip)
            throw new Error('Trip not found');
        // Security: Only the rider or the assigned driver can cancel
        if (trip.rider_id !== userId && trip.driver_id !== userId) {
            throw new Error('Unauthorized to cancel this trip');
        }
        // Only allow cancellation before pickup (REQUESTED or ACCEPTED)
        if (trip.status !== 'REQUESTED' && trip.status !== 'ACCEPTED') {
            throw new Error('Cannot cancel a ride that is already in progress or completed');
        }
        const isDriverCancellingAfterAccept = userId === trip.driver_id && trip.status === 'ACCEPTED';
        const extra = {};
        if (isDriverCancellingAfterAccept) {
            // Driver cancelled after accepting — release assignment and return
            // the ride to REQUESTED so the system can re-match to another driver.
            extra.driver_id = null;
        }
        else {
            extra.cancelled_at = new Date();
        }
        // If driver was assigned, cleanup trajectory
        if (trip.driver_id) {
            const trajectory = await locations_service_1.LocationsService.getTrajectory(tripId);
            if (trajectory.length > 0) {
                extra.trajectory = JSON.stringify(trajectory);
            }
            await redis_1.redis.del(`driver:${trip.driver_id}:active_trip`);
            await locations_service_1.LocationsService.clearTrajectory(tripId);
            await navigation_service_1.NavigationService.clearTrip(tripId);
        }
        const newStatus = isDriverCancellingAfterAccept ? 'REQUESTED' : 'CANCELLED';
        const updatedTrip = await ride_repository_1.RideRepository.updateStatus(tripId, newStatus, extra);
        if (isDriverCancellingAfterAccept) {
            // Driver cancelled after accept — re-queue matching so the system
            // finds another driver for this ride.
            const { matchQueue } = await Promise.resolve().then(() => __importStar(require('../../queue/queue')));
            matchQueue.add('matchRide', {
                tripId,
                pickupLat: trip.pickup.lat,
                pickupLng: trip.pickup.lng,
                riderId: trip.rider_id,
                retryCount: 0,
            }).catch((err) => console.error(`[RIDE] Failed to re-enqueue match after driver cancel: ${err.message}`));
            // Notify the rider that their previous driver cancelled and we're
            // finding a new one.
            app_1.io.to(`rider:${trip.rider_id}`).emit('tripUpdate', {
                ...updatedTrip,
                cancelReason: 'Your driver cancelled. Finding a new driver...',
            });
            // Real phone notification: driver cancelled after accept (deduped).
            (0, notification_service_1.notifyRideCancelled)(trip.rider_id, 'rider', tripId, 'driver').catch(() => undefined);
        }
        else {
            // Rewards ecosystem: void promo usage + refund applied credits.
            reward_engine_service_1.RewardEngine.onRideCancelled({
                id: tripId,
                rider_id: trip.rider_id,
                driver_id: trip.driver_id ?? null,
                fare_amount: trip.fare_amount ?? null,
                status: 'CANCELLED',
            }).catch((err) => console.error(`[RIDE] ⚠️ RewardEngine.onRideCancelled failed: ${err.message}`));
            // Safety + navigation teardown on cancel.
            if (trip.driver_id) {
                await speeding_detector_1.SpeedingDetector.finalizeTrip(trip.driver_id, tripId);
                navigation_service_1.NavigationService.emitEnded(app_1.io, tripId, trip.driver_id, trip.rider_id);
            }
            app_1.io.to(`rider:${trip.rider_id}`).emit('tripUpdate', updatedTrip);
            if (trip.driver_id) {
                app_1.io.to(`driver:${trip.driver_id}`).emit('tripUpdate', updatedTrip);
            }
            // Broadcast to Admin Monitoring
            app_1.io.to('monitoring:all_rides').emit('tripUpdate', updatedTrip);
            // Real phone notification: the rider cancelled an accepted ride, so
            // the assigned driver is informed (deduped per trip).
            if (trip.driver_id && trip.status === 'ACCEPTED') {
                (0, notification_service_1.notifyRideCancelled)(trip.driver_id, 'driver', tripId, 'rider').catch(() => undefined);
            }
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