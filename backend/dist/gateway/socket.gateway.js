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
exports.setupSocketGateway = setupSocketGateway;
const locations_service_1 = require("../modules/location/locations.service");
const ride_service_1 = require("../modules/ride/ride.service");
const ride_messages_repository_1 = require("../modules/ride/ride_messages.repository");
const navigation_service_1 = require("../services/navigation.service");
const reroute_service_1 = require("../services/reroute.service");
const route_store_service_1 = require("../services/route-store.service");
const database_1 = require("../config/database");
const types_1 = require("../types");
const env_1 = require("../config/env");
const geohash = __importStar(require("ngeohash"));
const socket_validation_1 = require("../utils/socket-validation");
const push_notification_service_1 = require("../services/push-notification.service");
const notification_service_1 = require("../services/notification.service");
const demand_service_1 = require("../services/demand.service");
const zod_1 = require("zod");
// ---- Chat hardening ------------------------------------------------------
//
// Validation + rate-limiting helpers shared by the driver and rider
// `sendMessage` handlers. The goal is that the only thing the handlers
// have to do is route to the right counterpart room — every other
// invariant (auth, trip state, payload shape, DoS protection, persistence)
// is handled here.
const redis_1 = require("../config/redis");
const metrics_1 = require("../observability/metrics");
// Rider auto-cancel timers: userId → setTimeout handle
// Cancelled when the rider reconnects within the grace period.
const riderAutoCancelTimers = new Map();
// Driver arrival tracking for grace period / wait timer
// tripId → { pickupArrivedAt: timestamp, destinationArrivedAt: timestamp }
const driverArrivalTimes = new Map();
// ---- Active-trip cache ----------------------------------------------------
//
// The updateLocation hot path used to run RideService.getCurrentRide (a
// Postgres query) on EVERY location update — up to 60/min per user. This
// in-process cache with a short TTL removes ~90% of those queries while
// keeping trip-state staleness bounded below the TTL. It is refreshed
// eagerly at every trip lifecycle event (accept, request, pickup,
// complete, cancel, getCurrentTrip), so in practice the window between a
// state change and the next broadcast is a single location update.
const activeTripCache = new Map();
const ACTIVE_TRIP_CACHE_TTL_MS = 6000;
function cachedTripKey(userId, role) {
    return `${role}:${userId}`;
}
async function getCachedCurrentRide(userId, role) {
    const key = cachedTripKey(userId, role);
    const hit = activeTripCache.get(key);
    if (hit && Date.now() - hit.at < ACTIVE_TRIP_CACHE_TTL_MS) {
        return hit.trip;
    }
    const trip = await ride_service_1.RideService.getCurrentRide(userId, role);
    activeTripCache.set(key, { trip, at: Date.now() });
    return trip;
}
function setCachedCurrentRide(userId, role, trip) {
    activeTripCache.set(cachedTripKey(userId, role), { trip, at: Date.now() });
}
function clearCachedCurrentRide(userId, role) {
    activeTripCache.delete(cachedTripKey(userId, role));
}
const MAX_MESSAGE_BODY = 1000;
const RATE_LIMIT_PER_MINUTE = 30;
const RATE_WINDOW_MS = 60 * 1000;
const SOCKET_RATE_LIMIT_LUA = `
local limit_amt   = tonumber(ARGV[1])
local window_ms   = tonumber(ARGV[2])
local now_ms      = tonumber(ARGV[3])
local member_val  = ARGV[4]
local cutoff_ms   = now_ms - window_ms

redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", cutoff_ms)
local count = redis.call("ZCARD", KEYS[1])
if count >= limit_amt then
  return {0, count}
end
redis.call("ZADD", KEYS[1], now_ms, member_val)
redis.call("PEXPIRE", KEYS[1], window_ms)
return {1, count + 1}
`;
async function consumeRateBudget(key) {
    const now = Date.now();
    const member = `${now}:${Math.random().toString(36).slice(2, 10)}`;
    const redisKey = `ratelimit:sock:${key}`;
    const result = await redis_1.redis.eval(SOCKET_RATE_LIMIT_LUA, 1, redisKey, String(RATE_LIMIT_PER_MINUTE), String(RATE_WINDOW_MS), String(now), member);
    if (result[0] === 0) {
        metrics_1.rateLimitedTotal.inc({ bucket: 'socket' });
        return false;
    }
    return true;
}
// Strip ASCII control characters except newline + tab so a malicious
// client can't smuggle ANSI escapes or terminal control sequences into
// the chat render. We still allow basic whitespace.
function sanitizeBody(raw) {
    if (typeof raw !== 'string')
        return null;
    // eslint-disable-next-line no-control-regex
    const cleaned = raw.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '').trim();
    if (cleaned.length === 0)
        return null;
    if (cleaned.length > MAX_MESSAGE_BODY)
        return null;
    return cleaned;
}
/** Trip statuses where in-app chat is allowed. */
function isLiveTripStatus(status) {
    return status === types_1.TripStatus.ACCEPTED || status === types_1.TripStatus.IN_PROGRESS;
}
/**
 * Persist + relay a chat message. On rejection (rate-limited, malformed,
 * trip not in a live state, or wrong sender) an explanatory `error`
 * event is emitted to the sender and the function returns. The
 * counterpart room is derived from the trip itself — the caller just
 * needs to pass the role of the OTHER party (so a driver hitting this
 * passes `'rider'` and vice versa).
 */
async function relayChatMessage(io, socket, counterpartRole, payload, self) {
    const body = sanitizeBody(payload?.message);
    if (!body) {
        socket.emit('error', 'Message must be 1–1000 characters.');
        return;
    }
    if (typeof payload?.tripId !== 'string') {
        socket.emit('error', 'Missing trip id.');
        return;
    }
    if (!(await consumeRateBudget(`${self.id}:${payload.tripId}`))) {
        socket.emit('error', 'You are sending messages too quickly. Please slow down.');
        return;
    }
    // Verify the sender is actually a party to this trip AND that the
    // trip is still in a state where chat makes sense. We re-fetch on
    // every message so a cancelled/completed trip can't be chatted on
    // by a stale client.
    const trip = await ride_service_1.RideService.getCurrentRide(self.id, self.role === 'driver' ? types_1.UserRole.DRIVER : types_1.UserRole.RIDER);
    if (!trip || trip.id !== payload.tripId) {
        socket.emit('error', 'You are not part of this trip.');
        return;
    }
    if (!isLiveTripStatus(String(trip.status))) {
        socket.emit('error', 'Chat is only available during an active trip.');
        return;
    }
    // Confirm counterpart is on the trip at all (driver must be assigned
    // for the rider to chat, etc). Avoids echoing into the void.
    const counterpartId = counterpartRole === 'driver' ? trip.driver_id : trip.rider_id;
    if (!counterpartId) {
        socket.emit('error', 'Your counterpart is not assigned to this trip yet.');
        return;
    }
    let persisted;
    try {
        persisted = await ride_messages_repository_1.RideMessagesRepository.insert({
            trip_id: payload.tripId,
            sender_id: self.id,
            sender_role: self.role,
            body,
        });
    }
    catch (err) {
        console.error(`[SOCKET] ❌ Failed to persist chat message: ${err.message}`);
        socket.emit('error', 'Unable to send your message. Please try again.');
        return;
    }
    const wirePayload = {
        id: persisted.id,
        tripId: persisted.trip_id,
        senderId: persisted.sender_id,
        role: persisted.sender_role,
        message: persisted.body,
        timestamp: persisted.created_at,
    };
    io.to(`${counterpartRole}:${counterpartId}`).emit('messageReceived', wirePayload);
    // If recipient is offline (not connected to a socket), send a push notification
    // so they still see the message on their lock screen / notification tray.
    try {
        const recipientOnline = await (0, push_notification_service_1.isOnline)(counterpartId, counterpartRole);
        if (!recipientOnline) {
            // Fetch sender's display name for the notification
            const senderNameRes = await database_1.pool.query('SELECT full_name FROM users WHERE id = $1', [self.id]);
            const senderName = senderNameRes.rows[0]?.full_name || 'Unknown';
            await (0, push_notification_service_1.pushChatMessage)(counterpartId, counterpartRole, senderName, body, payload.tripId);
            console.log(`[SOCKET] 📲 Push notification sent to offline ${counterpartRole} ${counterpartId}`);
        }
    }
    catch (pushErr) {
        // Push failure should never break chat delivery
        console.error(`[SOCKET] ⚠️ Push notification failed (non-fatal): ${pushErr.message}`);
    }
    // Echo back to the sender so the optimistic UI can reconcile any
    // pending state (e.g. replace a "pending" spinner with the persisted
    // id). Clients also use this to mark delivery.
    socket.emit('messageDelivered', wirePayload);
}
/** Haversine distance in meters between two lat/lng points. */
function haversineMeters(a, b) {
    const toRad = (deg) => (deg * Math.PI) / 180;
    const R = 6371000; // Earth radius in meters
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const x = Math.sin(dLat / 2) ** 2 +
        Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
    return 2 * R * Math.asin(Math.sqrt(x));
}
function setupSocketGateway(io) {
    io.on('connection', (socket) => {
        // Authentication context from middleware. `role` is the ACTIVE session
        // role resolved from the connecting application's context (Driver App ->
        // DRIVER, Rider App -> RIDER), never inferred from account order.
        const user = socket.user || {};
        const id = user.id;
        const role = user.role;
        const driverId = user.driverId;
        const riderId = user.riderId;
        const sessionId = user.sessionId || socket.id;
        // Requirement 4: structured, debuggable connection log.
        console.log(`[SOCKET] ✅ ${role === types_1.UserRole.DRIVER ? 'Driver' : role === types_1.UserRole.ADMIN ? 'Admin' : 'Rider'} Connected | ` +
            `userId=${id} | activeRole=${role} | driverProfileId=${driverId ?? 'n/a'} | ` +
            `riderProfileId=${riderId ?? 'n/a'} | sessionId=${sessionId} | ` +
            `at=${new Date().toISOString()}`);
        socket.isOnline = false;
        socket.currentGeohash = null;
        socket.subscribedGeohashes = [];
        // Join specialized rooms. Lower-case the role so the broadcast rooms
        // used by MatchingService + ride/location handlers (e.g. `driver:{id}`,
        // `rider:{id}`) match. The previous uppercase join left drivers unable
        // to receive `newTripRequest`.
        const roomRole = role?.toLowerCase();
        socket.join(`${roomRole}:${id}`);
        console.log(`[SOCKET] 🏠 ${id} joined room: ${roomRole}:${id}`);
        // Track online presence for push notification delivery.
        // When a user disconnects, their presence key expires (60s TTL)
        // and the system falls back to FCM push notifications.
        if (roomRole === 'driver' || roomRole === 'rider') {
            (0, push_notification_service_1.markOnline)(id, roomRole, socket.id).catch((err) => console.error(`[SOCKET] ⚠️ Presence tracking failed: ${err.message}`));
        }
        /**
         * ADMIN MONITORING EVENTS
         */
        if (role === types_1.UserRole.ADMIN) {
            socket.on('subscribeToMonitoring', () => {
                console.log(`[SOCKET] 👁️ Admin ${id} subscribed to MONITORING`);
                socket.join('monitoring:all_rides');
                socket.join('monitoring:all_drivers');
            });
            socket.on('unsubscribeFromMonitoring', () => {
                console.log(`[SOCKET] 🙈 Admin ${id} unsubscribed from MONITORING`);
                socket.leave('monitoring:all_rides');
                socket.leave('monitoring:all_drivers');
            });
        }
        /**
         * DRIVER INITIAL CLEANUP
         */
        // NOTE: Do NOT remove driver location on connect — the driver may be
        // reconnecting after a brief network blip. Removing their location
        // makes them invisible to the match worker's GEORADIUS query.
        // Location is only removed on explicit goOffline or disconnect.
        /**
         * DRIVER EVENTS
         */
        if (role === types_1.UserRole.DRIVER) {
            socket.on('goOnline', async (loc) => {
                const validated = (0, socket_validation_1.validate)(socket_validation_1.GoOnlineSchema, loc, socket, 'goOnline');
                if (!validated.success || !validated.data)
                    return;
                console.log(`[SOCKET] 🟢 Driver ${id} is now ONLINE`);
                socket.isOnline = true;
                if (validated.data.lat && validated.data.lng) {
                    const gh = await locations_service_1.LocationsService.updateDriverLocation(id, { lat: validated.data.lat, lng: validated.data.lng });
                    updateDriverGeohashRoom(socket, gh);
                    // When a driver comes online, check for any pending REQUESTED
                    // rides nearby and trigger re-matching. The dispatch engine
                    // will find this driver naturally via GEORADIUS once the
                    // matchRide job runs.
                    try {
                        const result = await database_1.pool.query(`
              SELECT id, pickup_lat, pickup_lng, rider_id
              FROM rides
              WHERE status = 'REQUESTED'
                AND driver_id IS NULL
                AND pickup_lat IS NOT NULL
                AND pickup_lng IS NOT NULL
                AND created_at > NOW() - INTERVAL '10 minutes'
              ORDER BY created_at ASC
              LIMIT 5
            `);
                        if (result.rows.length > 0) {
                            if (env_1.env.LEGACY_SYNC_MATCHING) {
                                const { matchingService } = await Promise.resolve().then(() => __importStar(require('../services/matching.service')));
                                for (const row of result.rows) {
                                    matchingService.findAndDispatch(io, row.id, Number(row.pickup_lat), Number(row.pickup_lng), row.rider_id).catch((err) => console.error(`[SOCKET] In-process re-match failed for ${row.id}: ${err.message}`));
                                    console.log(`[SOCKET] 🔄 Re-triggered matching for pending ride ${row.id} after driver ${id} came online`);
                                }
                            }
                            else {
                                const { matchQueue } = await Promise.resolve().then(() => __importStar(require('../queue/queue')));
                                for (const row of result.rows) {
                                    await matchQueue.add('matchRide', {
                                        tripId: row.id,
                                        pickupLat: Number(row.pickup_lat),
                                        pickupLng: Number(row.pickup_lng),
                                        riderId: row.rider_id,
                                        retryCount: 0,
                                    });
                                    console.log(`[SOCKET] 🔄 Re-triggered matching for pending ride ${row.id} after driver ${id} came online`);
                                }
                            }
                        }
                    }
                    catch (err) {
                        console.error(`[SOCKET] ❌ Failed to check pending rides on goOnline: ${err.message}`);
                    }
                }
            });
            socket.on('goOffline', async () => {
                console.log(`[SOCKET] 🔴 Driver ${id} is now OFFLINE`);
                socket.isOnline = false;
                leaveGeohashRoom(socket);
                await locations_service_1.LocationsService.removeDriverLocation(id);
            });
            socket.on('getCurrentTrip', async () => {
                try {
                    // Reconnect resync (driver side): after a socket blip the app
                    // re-asks for the authoritative active trip so an accepted trip
                    // is never lost to a stale local state.
                    const currentTrip = await ride_service_1.RideService.getCurrentRide(id, types_1.UserRole.DRIVER);
                    setCachedCurrentRide(id, types_1.UserRole.DRIVER, currentTrip);
                    console.log(`[SOCKET] getCurrentTrip for driver ${id}: ${currentTrip?.id ?? 'none'}`);
                    if (currentTrip) {
                        socket.emit('tripUpdate', currentTrip);
                    }
                    else {
                        socket.emit('currentTripNone');
                    }
                }
                catch (err) {
                    console.error(`[SOCKET] getCurrentTrip failed: ${err.message}`);
                }
            });
            socket.on('updateLocation', async (loc) => {
                const validated = (0, socket_validation_1.validate)(socket_validation_1.UpdateLocationSchema, loc, socket, 'updateLocation');
                if (!validated.success || !validated.data)
                    return;
                const allowed = await (0, socket_validation_1.checkRateLimit)(socket, 'updateLocation');
                if (!allowed)
                    return;
                try {
                    if (socket.isOnline) {
                        console.log(`[SOCKET] 📍 Location from driver ${id}: lat=${validated.data.lat}, lng=${validated.data.lng}`);
                        const gh = await locations_service_1.LocationsService.updateDriverLocation(id, validated.data);
                        updateDriverGeohashRoom(socket, gh);
                        const payload = {
                            driverId: id,
                            ...validated.data,
                            timestamp: new Date()
                        };
                        // 1. Broadcast to nearby riders via geohash room
                        io.to(`drivers:near:${gh}`).emit('driverLocationUpdate', payload);
                        // 2. Broadcast to Admin Monitoring
                        io.to('monitoring:all_drivers').emit('driverLocationUpdate', payload);
                    }
                }
                catch (err) {
                    // Redis down, skip silently
                }
                // Broadcast to specific rider if driver is on a trip
                const currentTrip = await getCachedCurrentRide(id, types_1.UserRole.DRIVER);
                if (currentTrip && currentTrip.status !== types_1.TripStatus.COMPLETED && currentTrip.status !== types_1.TripStatus.CANCELLED) {
                    console.log(`[SOCKET] 📡 Broadcasting driver loc to rider:${currentTrip.rider_id}`);
                    io.to(`rider:${currentTrip.rider_id}`).emit('driverLocationUpdate', {
                        driverId: id,
                        ...validated.data
                    });
                    // Live ETA push (throttled to 10 s per trip): compute the
                    // remaining distance over the stored authoritative leg and
                    // emit an updated arrival time — zero Google calls.
                    const leg = currentTrip.status === types_1.TripStatus.ACCEPTED ? 'pickup' : 'destination';
                    const etaThrottleKey = `eta:live:${currentTrip.id}`;
                    try {
                        const lastEta = await redis_1.redis.get(etaThrottleKey);
                        const nowS = Date.now();
                        if (!lastEta || nowS - parseInt(lastEta, 10) > 10000) {
                            const stored = await route_store_service_1.RouteStoreService.getRideRoute(currentTrip.id, leg);
                            if (stored && stored.geometry.coordinates.length >= 2) {
                                const { remainingMeters, etaSeconds } = route_store_service_1.RouteStoreService.computeRemaining(stored.geometry.coordinates, validated.data.lat, validated.data.lng);
                                io.to(`rider:${currentTrip.rider_id}`).emit('driverEtaUpdate', {
                                    tripId: currentTrip.id,
                                    leg,
                                    etaSeconds,
                                    remainingMeters: Math.round(remainingMeters),
                                });
                                await redis_1.redis.set(etaThrottleKey, nowS.toString(), 'EX', 30);
                            }
                        }
                    }
                    catch {
                        // ETA push is best-effort — never block location updates on it.
                    }
                    // Driver ARRIVED at pickup: once the driver enters the pickup
                    // grace zone, the rider gets a real phone notification. Guarded
                    // by a Redis NX key + DB event_id dedup → exactly one per trip.
                    if (currentTrip.status === types_1.TripStatus.ACCEPTED && currentTrip.rider_id) {
                        try {
                            const distToPickup = haversineMeters({ lat: validated.data.lat, lng: validated.data.lng }, currentTrip.pickup);
                            if (distToPickup <= env_1.env.DRIVER_PICKUP_PROXIMITY_M * 2) {
                                (0, notification_service_1.notifyDriverArrived)(currentTrip.rider_id, currentTrip.id, 'Your driver').catch(() => undefined);
                            }
                        }
                        catch {
                            // Arrival notification is best-effort.
                        }
                    }
                }
            });
            socket.on('acceptTrip', async (payload) => {
                let tripId;
                let offerId;
                if (typeof payload === 'string') {
                    tripId = payload;
                }
                else {
                    tripId = payload.tripId;
                    offerId = payload.offerId;
                }
                const validated = (0, socket_validation_1.validate)(socket_validation_1.AcceptTripSchema, tripId, socket, 'acceptTrip');
                if (!validated.success)
                    return;
                console.log(`[SOCKET] Driver ${id} accepts trip: ${tripId}${offerId ? ` (offer=${offerId})` : ''}`);
                try {
                    // Single source of truth: RideService.acceptTrip validates the
                    // offer (SENT + belongs to this driver), atomically accepts it,
                    // and assigns the trip. The offer MUST NOT be accepted here first:
                    // RideService re-validates the offer status and would reject an
                    // already-ACCEPTED offer with "Offer is in state ACCEPTED...",
                    // failing every legitimate accept. On failure the driver app
                    // rolls back its optimistic state via the acceptTripFailed event.
                    const acceptedTrip = await ride_service_1.RideService.acceptTrip(tripId, id);
                    // Prime the active-trip cache immediately so the very next
                    // location update broadcasts to the rider without a DB query.
                    setCachedCurrentRide(id, types_1.UserRole.DRIVER, acceptedTrip);
                }
                catch (err) {
                    console.error(`[SOCKET] Accept trip failed: ${err.message}`);
                    socket.emit('acceptTripFailed', err.message);
                }
            });
            socket.on('declineTrip', async (payload) => {
                let tripId;
                let offerId;
                if (typeof payload === 'string') {
                    tripId = payload;
                }
                else {
                    tripId = payload.tripId;
                    offerId = payload.offerId;
                }
                const validated = (0, socket_validation_1.validate)(socket_validation_1.DeclineTripSchema, tripId, socket, 'declineTrip');
                if (!validated.success)
                    return;
                console.log(`[SOCKET] Driver ${id} declined trip: ${tripId}${offerId ? ` (offer=${offerId})` : ''}`);
                try {
                    if (offerId) {
                        const { DriverOfferService } = await Promise.resolve().then(() => __importStar(require('../services/driver-offer.service')));
                        await DriverOfferService.declineOffer(offerId);
                        await DriverOfferService.releaseDriver(id);
                    }
                    // Persist the driver-specific rejection (ride_driver_rejections).
                    // This is what keeps the declined request from ever coming back to
                    // THIS driver — across engine retries, re-enqueues, listener
                    // refreshes, app restarts, and offline/online cycles. It is a
                    // per-driver exclusion, NOT a ride-wide cancellation: the same
                    // ride stays offerable to every other eligible driver. The pair
                    // primary key makes the write idempotent (double tap / retry safe).
                    const { RideRejectionService } = await Promise.resolve().then(() => __importStar(require('../services/ride-rejection.service')));
                    await RideRejectionService.recordRejection(tripId, id).catch((err) => {
                        console.error(`[SOCKET] Failed to persist rejection for ${tripId}/${id}: ${err.message}`);
                    });
                    // Re-enqueue matching so the system progresses to the next candidate
                    const { RideRepository } = await Promise.resolve().then(() => __importStar(require('../modules/ride/ride.repository')));
                    const trip = await RideRepository.findById(tripId);
                    if (trip && trip.status === 'REQUESTED') {
                        if (env_1.env.LEGACY_SYNC_MATCHING) {
                            const { matchingService } = await Promise.resolve().then(() => __importStar(require('../services/matching.service')));
                            matchingService.findAndDispatch(io, tripId, trip.pickup?.lat ?? 0, trip.pickup?.lng ?? 0, trip.rider_id).catch((err) => console.error(`[SOCKET] In-process re-match failed for ${tripId}: ${err.message}`));
                        }
                        else {
                            const { matchQueue } = await Promise.resolve().then(() => __importStar(require('../queue/queue')));
                            await matchQueue.add('matchRide', {
                                tripId,
                                pickupLat: trip.pickup?.lat ?? 0,
                                pickupLng: trip.pickup?.lng ?? 0,
                                riderId: trip.rider_id,
                                retryCount: 0,
                            });
                        }
                    }
                }
                catch (err) {
                    console.error(`[SOCKET] Decline trip failed: ${err.message}`);
                }
            });
            socket.on('cancelTrip', async (payload) => {
                const validated = (0, socket_validation_1.validate)(socket_validation_1.CancelTripSchema, payload, socket, 'cancelTrip');
                if (!validated.success || !validated.data)
                    return;
                const tripId = typeof validated.data === 'string' ? validated.data : validated.data.tripId;
                const cancelOpts = typeof validated.data === 'string'
                    ? {}
                    : {
                        reasonCode: validated.data.reasonCode,
                        reasonText: validated.data.reasonText,
                    };
                console.log(`[SOCKET] Trip cancellation from driver ${id} for trip: ${tripId}`);
                try {
                    // Release any active offers and clean up
                    const { DriverOfferService } = await Promise.resolve().then(() => __importStar(require('../services/driver-offer.service')));
                    await DriverOfferService.releaseDriver(id);
                    await ride_service_1.RideService.cancelTrip(tripId, id, cancelOpts);
                    clearCachedCurrentRide(id, types_1.UserRole.DRIVER);
                }
                catch (err) {
                    console.error(`[SOCKET] Cancel trip failed: ${err.message}`);
                    // Dedicated event so the client can distinguish a REJECTED
                    // cancellation from a generic socket error (spec §60).
                    socket.emit('cancelTripFailed', { message: err.message });
                }
            });
            socket.on('pickUpRider', async (tripId) => {
                const validated = (0, socket_validation_1.validate)(socket_validation_1.PickUpRiderSchema, tripId, socket, 'pickUpRider');
                if (!validated.success || !validated.data)
                    return;
                console.log(`[SOCKET] 🚕 Driver ${id} picked up rider for trip: ${validated.data}`);
                try {
                    const trip = await ride_service_1.RideService.getCurrentRide(id, types_1.UserRole.DRIVER);
                    console.log(`[SOCKET] pickUpRider: getCurrentRide returned`, trip?.id, 'match:', trip?.id === validated.data);
                    if (!trip || trip.id !== validated.data) {
                        socket.emit('error', 'You are not assigned to this trip.');
                        return;
                    }
                    const driverLoc = await locations_service_1.LocationsService.getDriverLocation(id);
                    console.log(`[SOCKET] pickUpRider: driverLoc=`, driverLoc);
                    if (!driverLoc) {
                        socket.emit('error', 'Driver location unknown. Make sure GPS is enabled.');
                        return;
                    }
                    const dist = haversineMeters(driverLoc, trip.pickup);
                    console.log(`[SOCKET] pickUpRider: dist=`, dist, 'limit=', env_1.env.DRIVER_PICKUP_PROXIMITY_M);
                    const arrival = driverArrivalTimes.get(validated.data) || {};
                    const now = Date.now();
                    const strictLimit = env_1.env.DRIVER_PICKUP_PROXIMITY_M;
                    const graceLimit = strictLimit * 2; // 2x strict limit during grace
                    if (dist > strictLimit) {
                        // Not at pickup yet - record arrival time if close
                        if (dist <= graceLimit) {
                            if (!arrival.pickupArrivedAt) {
                                arrival.pickupArrivedAt = now;
                                driverArrivalTimes.set(validated.data, arrival);
                            }
                            const waitTimeS = Math.ceil((now - arrival.pickupArrivedAt) / 1000);
                            const graceS = env_1.env.DRIVER_PROXIMITY_GRACE_S;
                            const waitTimerS = env_1.env.DRIVER_WAIT_TIMER_S;
                            if (waitTimeS >= waitTimerS) {
                                console.log(`[SOCKET] pickUpRider: wait timer (${waitTimerS}s) exceeded, force-allowing pickup`);
                            }
                            else if (waitTimeS >= graceS) {
                                console.log(`[SOCKET] pickUpRider: grace period (${graceS}s) exceeded, allowing pickup`);
                            }
                            else {
                                socket.emit('error', `You must be at the pickup to start the trip. You are ${Math.round(dist)}m away (${graceS - waitTimeS}s grace remaining).`);
                                return;
                            }
                        }
                        else {
                            // Too far - clear any arrival time
                            if (arrival.pickupArrivedAt) {
                                arrival.pickupArrivedAt = undefined;
                                driverArrivalTimes.set(validated.data, arrival);
                            }
                            socket.emit('error', `You must be at the pickup to start the trip. You are ${Math.round(dist)}m away.`);
                            return;
                        }
                    }
                    console.log(`[SOCKET] pickUpRider: calling updateTripStatus`);
                    await ride_service_1.RideService.updateTripStatus(validated.data, types_1.TripStatus.IN_PROGRESS, id);
                    console.log(`[SOCKET] pickUpRider: updateTripStatus done`);
                    clearCachedCurrentRide(id, types_1.UserRole.DRIVER);
                    // Clear arrival time on successful pickup
                    if (arrival.pickupArrivedAt) {
                        driverArrivalTimes.delete(validated.data);
                    }
                }
                catch (err) {
                    console.error(`[SOCKET] ❌ Pick up rider failed: ${err.message}`);
                    socket.emit('error', err.message || 'Unable to start trip. Please ensure you are assigned to this ride.');
                }
            });
            socket.on('completeTrip', async (tripId) => {
                const validated = (0, socket_validation_1.validate)(socket_validation_1.CompleteTripSchema, tripId, socket, 'completeTrip');
                if (!validated.success || !validated.data)
                    return;
                console.log(`[SOCKET] 🏁 Driver ${id} completed trip: ${validated.data}`);
                try {
                    // Server-side proximity gate with grace period:
                    // - Must be within DRIVER_DESTINATION_PROXIMITY_M of destination
                    // - Grace period: 60s once within 1.5x proximity
                    // - Wait timer: 30s if within 2x proximity
                    const trip = await ride_service_1.RideService.getCurrentRide(id, types_1.UserRole.DRIVER);
                    if (!trip || trip.id !== tripId) {
                        socket.emit('error', 'You are not assigned to this trip.');
                        return;
                    }
                    const driverLoc = await locations_service_1.LocationsService.getDriverLocation(id);
                    if (!driverLoc) {
                        socket.emit('error', 'Driver location unknown. Make sure GPS is enabled.');
                        return;
                    }
                    const dist = haversineMeters(driverLoc, trip.destination);
                    const strict = env_1.env.DRIVER_DESTINATION_PROXIMITY_M;
                    const graceDist = strict * 1.5;
                    const waitDist = strict * 2;
                    const graceS = 60;
                    const waitTimerS = 30;
                    // Track arrival time
                    const arrivalKey = `arrival:${tripId}`;
                    let arrival = driverArrivalTimes.get(arrivalKey) || { destinationArrivedAt: undefined };
                    if (dist <= graceDist) {
                        if (!arrival.destinationArrivedAt) {
                            arrival.destinationArrivedAt = Date.now();
                            driverArrivalTimes.set(arrivalKey, arrival);
                        }
                        const waitTimeS = (Date.now() - arrival.destinationArrivedAt) / 1000;
                        if (waitTimeS >= waitTimerS) {
                            console.log(`[SOCKET] completeTrip: wait timer (${waitTimerS}s) exceeded, force-allowing complete`);
                        }
                        else if (waitTimeS >= graceS) {
                            console.log(`[SOCKET] completeTrip: grace period (${graceS}s) exceeded, allowing complete`);
                        }
                        else {
                            socket.emit('error', `You must reach the destination to finish. You are ${Math.round(dist)}m away (${graceS - waitTimeS}s grace remaining).`);
                            return;
                        }
                    }
                    else if (dist <= waitDist) {
                        // Within wait distance but not grace distance - only allow if wait timer exceeded
                        if (arrival.destinationArrivedAt) {
                            const waitTimeS = (Date.now() - arrival.destinationArrivedAt) / 1000;
                            if (waitTimeS >= waitTimerS) {
                                console.log(`[SOCKET] completeTrip: wait timer (${waitTimerS}s) exceeded at wait distance, allowing complete`);
                            }
                            else {
                                socket.emit('error', `You must reach the destination to finish. You are ${Math.round(dist)}m away (${waitTimerS - waitTimeS}s wait timer remaining).`);
                                return;
                            }
                        }
                        else {
                            socket.emit('error', `You must reach the destination to finish. You are ${Math.round(dist)}m away.`);
                            return;
                        }
                    }
                    else {
                        // Too far - clear any arrival time
                        if (arrival.destinationArrivedAt) {
                            arrival.destinationArrivedAt = undefined;
                            driverArrivalTimes.set(arrivalKey, arrival);
                        }
                        socket.emit('error', `You must reach the destination to finish. You are ${Math.round(dist)}m away.`);
                        return;
                    }
                    await ride_service_1.RideService.updateTripStatus(tripId, types_1.TripStatus.COMPLETED, id);
                    clearCachedCurrentRide(id, types_1.UserRole.DRIVER);
                    // Clear arrival time on successful completion
                    if (arrival.destinationArrivedAt) {
                        driverArrivalTimes.delete(arrivalKey);
                    }
                }
                catch (err) {
                    console.error(`[SOCKET] ❌ Complete trip failed: ${err.message}`);
                    socket.emit('error', err.message || 'Unable to complete trip. Please try again.');
                }
            });
            socket.on('sendMessage', async (data) => {
                const validated = (0, socket_validation_1.validate)(socket_validation_1.SendMessageSchema, data, socket, 'sendMessage');
                if (!validated.success || !validated.data)
                    return;
                // relayChatMessage needs the role of the OTHER party: a driver's
                // counterpart is the rider. Passing 'driver' here emitted the
                // message back into the driver's OWN room — the sender's app
                // showed the message twice (optimistic copy + echoed copy) while
                // the rider never got a live socket delivery.
                await relayChatMessage(io, socket, 'rider', validated.data, { id, role: 'driver' });
            });
            /**
             * Manual reroute request from the driver app. The driver sends
             * `{ tripId, leg, lat, lng }` — `lat/lng` is the current GPS so
             * we re-route from where they actually are (the cached polyline
             * might be stale). The server replaces the cached leg and emits
             * `navigationRouteUpdated` (driver-only payload) and a
             * `navigationRerouteRequested` toast to the rider.
             */
            socket.on('requestReroute', async (data) => {
                const validated = (0, socket_validation_1.validate)(socket_validation_1.RequestRerouteSchema, data, socket, 'requestReroute');
                if (!validated.success || !validated.data)
                    return;
                console.log(`[SOCKET] 🔁 Driver ${id} requested reroute for trip ${validated.data.tripId} (leg: ${validated.data.leg})`);
                try {
                    const trip = await ride_service_1.RideService.getCurrentRide(id, types_1.UserRole.DRIVER);
                    if (!trip || trip.id !== validated.data.tripId) {
                        socket.emit('error', 'You are not assigned to this trip.');
                        return;
                    }
                    // Rate limit reroutes: minimum 30 seconds between reroutes per trip+leg
                    const rerouteKey = `reroute:${data.tripId}:${data.leg}`;
                    const lastReroute = await redis_1.redis.get(rerouteKey);
                    if (lastReroute) {
                        const lastTime = parseInt(lastReroute, 10);
                        const elapsedS = (Date.now() - lastTime) / 1000;
                        if (elapsedS < 30) {
                            socket.emit('error', `Please wait ${Math.ceil(30 - elapsedS)}s before requesting another reroute.`);
                            return;
                        }
                    }
                    // Also check minimum distance from last reroute start point
                    const lastPosKey = `reroute:pos:${data.tripId}:${data.leg}`;
                    const lastPos = await redis_1.redis.get(lastPosKey);
                    if (lastPos) {
                        const [lastLat, lastLng] = lastPos.split(',').map(Number);
                        const distM = haversineMeters({ lat: data.lat, lng: data.lng }, { lat: lastLat, lng: lastLng });
                        if (distM < 200) {
                            socket.emit('error', `Please drive at least 200m before requesting another reroute.`);
                            return;
                        }
                    }
                    // Reroute through the decision ladder: stored ride leg → OD
                    // route cache → Google Routes API (last resort only).
                    const route = await reroute_service_1.RerouteService.reroute(data.tripId, data.leg, data.lat, data.lng);
                    // Store current position for distance check on next reroute
                    await redis_1.redis.set(lastPosKey, `${data.lat},${data.lng}`, 'EX', 3600);
                    await redis_1.redis.set(rerouteKey, Date.now().toString(), 'EX', 3600);
                    navigation_service_1.NavigationService.emitRouteUpdated(io, data.tripId, id, trip.rider_id, data.leg, route);
                }
                catch (err) {
                    console.error(`[SOCKET] ❌ Reroute failed: ${err.message}`);
                    socket.emit('error', err.message || 'Unable to refresh route. Please try again.');
                }
            });
            socket.on('disconnect', async () => {
                console.log(`[SOCKET] ❌ Driver ${id} disconnected (location kept — will expire via heartbeat)`);
                // Do NOT remove driver location here. On free-tier Render the
                // service spins down and ALL sockets disconnect — wiping every
                // driver's location makes them invisible when the service wakes.
                // Location is only removed on explicit goOffline or heartbeat expiry.
                clearCachedCurrentRide(id, types_1.UserRole.DRIVER);
                (0, push_notification_service_1.markOffline)(id, 'driver').catch((err) => console.error(`[SOCKET] ⚠️ Presence tracking failed on disconnect: ${err.message}`));
            });
        }
        /**
         * RIDER EVENTS
         */
        if (role === types_1.UserRole.RIDER) {
            // Cancel any pending auto-cancel timer — rider is back online.
            const pendingTimer = riderAutoCancelTimers.get(id);
            if (pendingTimer) {
                clearTimeout(pendingTimer);
                riderAutoCancelTimers.delete(id);
                console.log(`[SOCKET] ✅ Cleared auto-cancel timer for reconnecting rider ${id}`);
            }
            socket.on('subscribeToNearbyDrivers', (loc) => {
                const validated = (0, socket_validation_1.validate)(socket_validation_1.SubscribeNearbyDriversSchema, loc, socket, 'subscribeToNearbyDrivers');
                if (!validated.success || !validated.data)
                    return;
                const gh = geohash.encode(validated.data.lat, validated.data.lng, 6);
                const neighbors = geohash.neighbors(gh);
                const rooms = [gh, ...neighbors].map(g => `drivers:near:${g}`);
                // Leave old rooms
                socket.subscribedGeohashes.forEach((room) => socket.leave(room));
                // Join new rooms
                rooms.forEach(room => socket.join(room));
                socket.subscribedGeohashes = rooms;
                console.log(`[SOCKET] 🔍 Rider ${id} subscribed to geohash rooms: ${rooms.length}`);
                // Demand heatmap signal: the rider is live on the map. Cooldown
                // (300 s) keeps the 15 s subscription from flooding the table.
                (0, demand_service_1.recordRiderActivity)({
                    riderId: id,
                    type: 'APP_OPEN',
                    lat: validated.data.lat,
                    lng: validated.data.lng,
                }).catch(() => undefined);
            });
            /**
             * RIDER-REPORTED ACTIVITY (demand heatmap). The rider app emits this
             * when the user performs a meaningful in-app action that isn't a ride
             * mutation:
             *   REQUEST_FLOW — opened the ride request flow (picked pickup/dest)
             *   APP_ACTIVE   — actively engaged while traveling (mid-trip)
             * Cooldown-limited server-side; never blocks the socket.
             */
            const reportActivitySchema = zod_1.z.object({
                type: zod_1.z.enum(['REQUEST_FLOW', 'APP_ACTIVE']),
                lat: zod_1.z.number().min(-90).max(90),
                lng: zod_1.z.number().min(-180).max(180),
            });
            socket.on('reportActivity', (payload) => {
                const parsed = reportActivitySchema.safeParse(payload);
                if (!parsed.success)
                    return;
                (0, demand_service_1.recordRiderActivity)({
                    riderId: id,
                    type: parsed.data.type,
                    lat: parsed.data.lat,
                    lng: parsed.data.lng,
                }).catch(() => undefined);
            });
            socket.on('updateLocation', async (loc) => {
                const validated = (0, socket_validation_1.validate)(socket_validation_1.RiderUpdateLocationSchema, loc, socket, 'updateLocation');
                if (!validated.success || !validated.data)
                    return;
                // Same per-user budget as drivers — the rider app throttles to
                // ~1 Hz client-side, and the server stays symmetric + bounded.
                const allowed = await (0, socket_validation_1.checkRateLimit)(socket, 'updateLocation');
                if (!allowed)
                    return;
                try {
                    // Broadcast to specific driver if rider is on a trip
                    const currentTrip = await getCachedCurrentRide(id, types_1.UserRole.RIDER);
                    if (currentTrip && currentTrip.driver_id && currentTrip.status !== types_1.TripStatus.COMPLETED) {
                        console.log(`[SOCKET] 📡 Broadcasting rider loc to driver:${currentTrip.driver_id}`);
                        io.to(`driver:${currentTrip.driver_id}`).emit('riderLocationUpdate', loc);
                        // Demand heatmap signal: a rider actively on a trip near here.
                        (0, demand_service_1.recordRiderActivity)({
                            riderId: id,
                            type: 'APP_ACTIVE',
                            lat: validated.data.lat,
                            lng: validated.data.lng,
                            tripId: currentTrip.id,
                        }).catch(() => undefined);
                    }
                }
                catch (err) { }
            });
            socket.on('getCurrentTrip', async () => {
                try {
                    // Reconnect resync: after a socket blip, apps ask for the
                    // authoritative trip (if any) instead of staying stuck in a
                    // stale local state (e.g. rider stuck on "searching" after a
                    // missed ACCEPTED tripUpdate).
                    const currentTrip = await ride_service_1.RideService.getCurrentRide(id, types_1.UserRole.RIDER);
                    setCachedCurrentRide(id, types_1.UserRole.RIDER, currentTrip);
                    console.log(`[SOCKET] getCurrentTrip for rider ${id}: ${currentTrip?.id ?? 'none'}`);
                    if (currentTrip) {
                        socket.emit('tripUpdate', currentTrip);
                    }
                    else {
                        socket.emit('currentTripNone');
                    }
                }
                catch (err) {
                    console.error(`[SOCKET] getCurrentTrip failed: ${err.message}`);
                }
            });
            socket.on('requestRide', async (data) => {
                const validated = (0, socket_validation_1.validate)(socket_validation_1.RequestRideSchema, data, socket, 'requestRide');
                if (!validated.success || !validated.data)
                    return;
                console.log(`[SOCKET] 🚕 Ride request from rider ${id}: From ${validated.data.pickup.address} to ${validated.data.destination.address} favorite=${!!validated.data.favoritePriority} special=${validated.data.specialRedemptionId ?? 'none'}`);
                try {
                    const trip = await ride_service_1.RideService.requestRide(id, data.pickup, data.destination, undefined, false, data.idempotencyKey, { promoCode: data.promoCode, applyCredits: data.applyCredits, creditUseCents: data.creditUseCents, specialRedemptionId: data.specialRedemptionId }, validated.data.favoritePriority);
                    setCachedCurrentRide(id, types_1.UserRole.RIDER, trip);
                    socket.emit('tripUpdate', trip);
                    // Demand heatmap signal: a REAL ride request — the strongest
                    // demand marker on the platform.
                    (0, demand_service_1.recordRiderActivity)({
                        riderId: id,
                        type: 'RIDE_REQUESTED',
                        lat: data.pickup.lat,
                        lng: data.pickup.lng,
                        tripId: trip.id,
                    }).catch(() => undefined);
                }
                catch (err) {
                    console.error(`[SOCKET] ❌ Request ride failed: ${err.message}`);
                    socket.emit('error', err.message);
                }
            });
            socket.on('cancelTrip', async (payload) => {
                const validated = (0, socket_validation_1.validate)(socket_validation_1.CancelTripSchema, payload, socket, 'cancelTrip');
                if (!validated.success || !validated.data)
                    return;
                const tripId = typeof validated.data === 'string' ? validated.data : validated.data.tripId;
                const cancelOpts = typeof validated.data === 'string'
                    ? {}
                    : {
                        reasonCode: validated.data.reasonCode,
                        reasonText: validated.data.reasonText,
                    };
                console.log(`[SOCKET] Trip cancellation from rider ${id} for trip: ${tripId}`);
                try {
                    // Clean up any active driver offer before cancelling
                    const { DriverOfferService } = await Promise.resolve().then(() => __importStar(require('../services/driver-offer.service')));
                    const releasedDriver = await DriverOfferService.cancelRideOffers(tripId);
                    if (releasedDriver) {
                        console.log(`[SOCKET] Released driver ${releasedDriver} from cancelled ride ${tripId}`);
                    }
                    await ride_service_1.RideService.cancelTrip(tripId, id, cancelOpts);
                    clearCachedCurrentRide(id, types_1.UserRole.RIDER);
                }
                catch (err) {
                    console.error(`[SOCKET] Cancel trip failed: ${err.message}`);
                    // Dedicated event so the client can distinguish a REJECTED
                    // cancellation from a generic socket error (spec §60).
                    socket.emit('cancelTripFailed', { message: err.message });
                }
            });
            socket.on('sendMessage', async (data) => {
                const validated = (0, socket_validation_1.validate)(socket_validation_1.SendMessageSchema, data, socket, 'sendMessage');
                if (!validated.success || !validated.data)
                    return;
                await relayChatMessage(io, socket, 'driver', validated.data, { id, role: 'rider' });
            });
            /**
             * Rider changed the destination mid-trip. We persist the new
             * target, refresh the destination leg route from the driver's
             * current position, and emit a reroute request to the driver.
             * The rider still gets a `tripUpdate` from updateTripStatus flow
             * downstream — this handler is the bridge that says "your driver
             * is being told to recalculate".
             */
            socket.on('riderDestinationChanged', async (data) => {
                const validated = (0, socket_validation_1.validate)(socket_validation_1.RiderDestinationChangedSchema, data, socket, 'riderDestinationChanged');
                if (!validated.success || !validated.data)
                    return;
                console.log(`[SOCKET] 🎯 Rider ${id} changed destination for trip ${validated.data.tripId} → ${validated.data.address}`);
                try {
                    const trip = await ride_service_1.RideService.getCurrentRide(id, types_1.UserRole.RIDER);
                    setCachedCurrentRide(id, types_1.UserRole.RIDER, trip);
                    if (!trip || trip.id !== data.tripId || !trip.driver_id) {
                        socket.emit('error', 'No active trip to update.');
                        return;
                    }
                    // Persist new destination on the ride (trajectory kept).
                    await database_1.pool.query(`UPDATE rides SET destination_lat = $1, destination_lng = $2, destination_address = $3 WHERE id = $4`, [data.lat, data.lng, data.address, data.tripId]);
                    // Re-route the destination leg from where the driver is now.
                    const driverLoc = await locations_service_1.LocationsService.getDriverLocation(trip.driver_id);
                    const start = driverLoc
                        ? [driverLoc.lat, driverLoc.lng]
                        : [trip.pickup.lat, trip.pickup.lng];
                    const route = await navigation_service_1.NavigationService.cacheRouteLeg(data.tripId, 'destination', start, [data.lat, data.lng]);
                    await database_1.pool.query(`UPDATE rides SET route_metadata = route_metadata || $1::jsonb WHERE id = $2`, [JSON.stringify({ destination: route }), data.tripId]);
                    // Tell the driver to swap their route. The driver app will
                    // re-fetch via `navigationStarted` payload, then rehydrate its
                    // local NavigationRoute.
                    io.to(`driver:${trip.driver_id}`).emit('navigationRerouteRequested', {
                        tripId: data.tripId,
                        leg: 'destination',
                        reason: 'rider_destination_changed',
                        route,
                    });
                    // Notify the rider the driver has been told.
                    socket.emit('navigationRerouteRequested', {
                        tripId: data.tripId,
                        leg: 'destination',
                        reason: 'rider_destination_changed',
                    });
                }
                catch (err) {
                    console.error(`[SOCKET] ❌ riderDestinationChanged failed: ${err.message}`);
                    socket.emit('error', err.message || 'Unable to update destination.');
                }
            });
            socket.on('disconnect', async () => {
                console.log(`[SOCKET] ❌ Rider ${id} disconnected`);
                clearCachedCurrentRide(id, types_1.UserRole.RIDER);
                // Mark rider as offline for push notification delivery
                (0, push_notification_service_1.markOffline)(id, 'rider').catch((err) => console.error(`[SOCKET] ⚠️ Presence tracking failed on disconnect: ${err.message}`));
                // Cancel ride if rider doesn't reconnect within 3 minutes.
                // This covers: app force-closed, OS killed background process.
                // Brief app switches reconnect within seconds and clear the timer.
                const timer = setTimeout(async () => {
                    riderAutoCancelTimers.delete(id);
                    try {
                        const currentTrip = await ride_service_1.RideService.getCurrentRide(id, types_1.UserRole.RIDER);
                        if (currentTrip && currentTrip.status === types_1.TripStatus.REQUESTED) {
                            console.log(`[SOCKET] 🧹 Auto-cancelling stale request for disconnected rider ${id}: ${currentTrip.id}`);
                            await ride_service_1.RideService.cancelTrip(currentTrip.id, id);
                        }
                    }
                    catch (err) { }
                }, 180000); // 3 minutes
                riderAutoCancelTimers.set(id, timer);
            });
        }
        socket.on('error', (err) => {
            console.error('[SOCKET] 💥 Error:', err);
        });
    });
}
function updateDriverGeohashRoom(socket, newGeohash) {
    const currentGh = socket.currentGeohash;
    if (currentGh !== newGeohash) {
        if (currentGh) {
            socket.leave(`drivers:at:${currentGh}`);
        }
        socket.join(`drivers:at:${newGeohash}`);
        socket.currentGeohash = newGeohash;
    }
}
function leaveGeohashRoom(socket) {
    const currentGh = socket.currentGeohash;
    if (currentGh) {
        socket.leave(`drivers:at:${currentGh}`);
        socket.currentGeohash = null;
    }
}
//# sourceMappingURL=socket.gateway.js.map