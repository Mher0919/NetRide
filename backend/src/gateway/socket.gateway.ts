// backend/src/gateway/socket.gateway.ts
import { Server, Socket } from 'socket.io';
import { LocationsService } from '../modules/location/locations.service';
import { RideService } from '../modules/ride/ride.service';
import { RideMessagesRepository } from '../modules/ride/ride_messages.repository';
import { NavigationService } from '../services/navigation.service';
import { RerouteService } from '../services/reroute.service';
import { RouteStoreService } from '../services/route-store.service';
import { pool } from '../config/database';
import { UserRole, Location, TripStatus } from '../types';
import { env } from '../config/env';
import * as geohash from 'ngeohash';
import {
  validate,
  checkRateLimit,
  GoOnlineSchema,
  UpdateLocationSchema,
  AcceptTripSchema,
  DeclineTripSchema,
  CancelTripSchema,
  PickUpRiderSchema,
  CompleteTripSchema,
  SendMessageSchema,
  RequestRerouteSchema,
  SubscribeNearbyDriversSchema,
  RiderUpdateLocationSchema,
  RequestRideSchema,
  RiderDestinationChangedSchema,
} from '../utils/socket-validation';
import { isOnline, markOnline, markOffline, pushChatMessage, pushIncomingCall } from '../services/push-notification.service';
import { notifyDriverArrived } from '../services/notification.service';
import { recordRiderActivity } from '../services/demand.service';
import { z } from 'zod';

// ---- Chat hardening ------------------------------------------------------
//
// Validation + rate-limiting helpers shared by the driver and rider
// `sendMessage` handlers. The goal is that the only thing the handlers
// have to do is route to the right counterpart room — every other
// invariant (auth, trip state, payload shape, DoS protection, persistence)
// is handled here.

import { redis } from '../config/redis';
import { rateLimitedTotal } from '../observability/metrics';

// Rider auto-cancel timers: userId → setTimeout handle
// Cancelled when the rider reconnects within the grace period.
const riderAutoCancelTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Driver arrival tracking for grace period / wait timer
// tripId → { pickupArrivedAt: timestamp, destinationArrivedAt: timestamp }
const driverArrivalTimes = new Map<string, { pickupArrivedAt?: number; destinationArrivedAt?: number }>();

// ---- Active-trip cache ----------------------------------------------------
//
// The updateLocation hot path used to run RideService.getCurrentRide (a
// Postgres query) on EVERY location update — up to 60/min per user. This
// in-process cache with a short TTL removes ~90% of those queries while
// keeping trip-state staleness bounded below the TTL. It is refreshed
// eagerly at every trip lifecycle event (accept, request, pickup,
// complete, cancel, getCurrentTrip), so in practice the window between a
// state change and the next broadcast is a single location update.
const activeTripCache = new Map<string, { trip: any; at: number }>();
const ACTIVE_TRIP_CACHE_TTL_MS = 6000;

function cachedTripKey(userId: string, role: string): string {
  return `${role}:${userId}`;
}

async function getCachedCurrentRide(userId: string, role: string): Promise<any | null> {
  const key = cachedTripKey(userId, role);
  const hit = activeTripCache.get(key);
  if (hit && Date.now() - hit.at < ACTIVE_TRIP_CACHE_TTL_MS) {
    return hit.trip;
  }
  const trip = await RideService.getCurrentRide(userId, role);
  activeTripCache.set(key, { trip, at: Date.now() });
  return trip;
}

function setCachedCurrentRide(userId: string, role: string, trip: any | null): void {
  activeTripCache.set(cachedTripKey(userId, role), { trip, at: Date.now() });
}

function clearCachedCurrentRide(userId: string, role: string): void {
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

async function consumeRateBudget(key: string): Promise<boolean> {
  const now = Date.now();
  const member = `${now}:${Math.random().toString(36).slice(2, 10)}`;
  const redisKey = `ratelimit:sock:${key}`;
  const result = await redis.eval(
    SOCKET_RATE_LIMIT_LUA,
    1,
    redisKey,
    String(RATE_LIMIT_PER_MINUTE),
    String(RATE_WINDOW_MS),
    String(now),
    member,
  ) as [number, number];
  if (result[0] === 0) {
    rateLimitedTotal.inc({ bucket: 'socket' });
    return false;
  }
  return true;
}

// Strip ASCII control characters except newline + tab so a malicious
// client can't smuggle ANSI escapes or terminal control sequences into
// the chat render. We still allow basic whitespace.
function sanitizeBody(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '').trim();
  if (cleaned.length === 0) return null;
  if (cleaned.length > MAX_MESSAGE_BODY) return null;
  return cleaned;
}

/** Trip statuses where in-app chat is allowed. */
function isLiveTripStatus(status: string): boolean {
  return status === TripStatus.ACCEPTED || status === TripStatus.IN_PROGRESS;
}

/**
 * Persist + relay a chat message. On rejection (rate-limited, malformed,
 * trip not in a live state, or wrong sender) an explanatory `error`
 * event is emitted to the sender and the function returns. The
 * counterpart room is derived from the trip itself — the caller just
 * needs to pass the role of the OTHER party (so a driver hitting this
 * passes `'rider'` and vice versa).
 */
async function relayChatMessage(
  io: Server,
  socket: Socket,
  counterpartRole: 'rider' | 'driver',
  payload: { tripId: string; message: string },
  self: { id: string; role: 'rider' | 'driver' },
): Promise<void> {
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
  const trip = await RideService.getCurrentRide(self.id, self.role === 'driver' ? UserRole.DRIVER : UserRole.RIDER);
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
    persisted = await RideMessagesRepository.insert({
      trip_id: payload.tripId,
      sender_id: self.id,
      sender_role: self.role,
      body,
    });
  } catch (err: any) {
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
    const recipientOnline = await isOnline(counterpartId, counterpartRole);
    if (!recipientOnline) {
      // Fetch sender's display name for the notification
      const senderNameRes = await pool.query(
        'SELECT full_name FROM users WHERE id = $1',
        [self.id]
      );
      const senderName = senderNameRes.rows[0]?.full_name || 'Unknown';
      await pushChatMessage(
        counterpartId,
        counterpartRole,
        senderName,
        body,
        payload.tripId
      );
      console.log(`[SOCKET] 📲 Push notification sent to offline ${counterpartRole} ${counterpartId}`);
    }
  } catch (pushErr: any) {
    // Push failure should never break chat delivery
    console.error(`[SOCKET] ⚠️ Push notification failed (non-fatal): ${pushErr.message}`);
  }

  // Echo back to the sender so the optimistic UI can reconcile any
  // pending state (e.g. replace a "pending" spinner with the persisted
  // id). Clients also use this to mark delivery.
  socket.emit('messageDelivered', wirePayload);
}

/** Haversine distance in meters between two lat/lng points. */
function haversineMeters(a: Location, b: { lat: number; lng: number }): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 6371000; // Earth radius in meters
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(x));
}

export function setupSocketGateway(io: Server) {
  io.on('connection', (socket: Socket) => {
    // Authentication context from middleware. `role` is the ACTIVE session
    // role resolved from the connecting application's context (Driver App ->
    // DRIVER, Rider App -> RIDER), never inferred from account order.
    const user = (socket as any).user || {};
    const id = user.id;
    const role = user.role;
    const driverId = user.driverId;
    const riderId = user.riderId;
    const sessionId = user.sessionId || socket.id;

    // Requirement 4: structured, debuggable connection log.
    console.log(
      `[SOCKET] ✅ ${role === UserRole.DRIVER ? 'Driver' : role === UserRole.ADMIN ? 'Admin' : 'Rider'} Connected | ` +
      `userId=${id} | activeRole=${role} | driverProfileId=${driverId ?? 'n/a'} | ` +
      `riderProfileId=${riderId ?? 'n/a'} | sessionId=${sessionId} | ` +
      `at=${new Date().toISOString()}`
    );

    (socket as any).isOnline = false;
    (socket as any).currentGeohash = null;
    (socket as any).subscribedGeohashes = [];

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
      markOnline(id, roomRole as 'rider' | 'driver', socket.id).catch((err: any) =>
        console.error(`[SOCKET] ⚠️ Presence tracking failed: ${err.message}`)
      );
    }

    /**
     * ADMIN MONITORING EVENTS
     */
    if (role === UserRole.ADMIN) {
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
    if (role === UserRole.DRIVER) {
      socket.on('goOnline', async (loc?: Location) => {
        const validated = validate(GoOnlineSchema, loc, socket, 'goOnline');
        if (!validated.success || !validated.data) return;
        
        console.log(`[SOCKET] 🟢 Driver ${id} is now ONLINE`);

        (socket as any).isOnline = true;
        if (validated.data.lat && validated.data.lng) {
          const gh = await LocationsService.updateDriverLocation(id, { lat: validated.data.lat, lng: validated.data.lng });
          updateDriverGeohashRoom(socket, gh);

          // When a driver comes online, check for any pending REQUESTED
          // rides nearby and trigger re-matching. The dispatch engine
          // will find this driver naturally via GEORADIUS once the
          // matchRide job runs.
          try {
            const result = await pool.query(`
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
              if (env.LEGACY_SYNC_MATCHING) {
                const { matchingService } = await import('../services/matching.service');
                for (const row of result.rows) {
                  matchingService.findAndDispatch(
                    io, row.id, Number(row.pickup_lat), Number(row.pickup_lng), row.rider_id,
                  ).catch((err: any) => console.error(`[SOCKET] In-process re-match failed for ${row.id}: ${err.message}`));
                  console.log(`[SOCKET] 🔄 Re-triggered matching for pending ride ${row.id} after driver ${id} came online`);
                }
              } else {
                const { matchQueue } = await import('../queue/queue');
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
          } catch (err: any) {
            console.error(`[SOCKET] ❌ Failed to check pending rides on goOnline: ${err.message}`);
          }
        }
      });

      socket.on('goOffline', async () => {
        console.log(`[SOCKET] 🔴 Driver ${id} is now OFFLINE`);
        (socket as any).isOnline = false;
        leaveGeohashRoom(socket);

        await LocationsService.removeDriverLocation(id);
      });

      socket.on('getCurrentTrip', async () => {
        try {
          // Reconnect resync (driver side): after a socket blip the app
          // re-asks for the authoritative active trip so an accepted trip
          // is never lost to a stale local state.
          const currentTrip = await RideService.getCurrentRide(id, UserRole.DRIVER);
          setCachedCurrentRide(id, UserRole.DRIVER, currentTrip);
          console.log(`[SOCKET] getCurrentTrip for driver ${id}: ${currentTrip?.id ?? 'none'}`);
          if (currentTrip) {
            socket.emit('tripUpdate', currentTrip);
          } else {
            socket.emit('currentTripNone');
          }
        } catch (err: any) {
          console.error(`[SOCKET] getCurrentTrip failed: ${err.message}`);
        }
      });

      socket.on('updateLocation', async (loc: Location) => {
        const validated = validate(UpdateLocationSchema, loc, socket, 'updateLocation');
        if (!validated.success || !validated.data) return;
        
        const allowed = await checkRateLimit(socket, 'updateLocation');
        if (!allowed) return;
        
        try {
          if ((socket as any).isOnline) {
            console.log(`[SOCKET] 📍 Location from driver ${id}: lat=${validated.data.lat}, lng=${validated.data.lng}`);
            const gh = await LocationsService.updateDriverLocation(id, validated.data);
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
        } catch (err) {
          // Redis down, skip silently
        }

        // Broadcast to specific rider if driver is on a trip
        const currentTrip = await getCachedCurrentRide(id, UserRole.DRIVER);
        if (currentTrip && currentTrip.status !== TripStatus.COMPLETED && currentTrip.status !== TripStatus.CANCELLED) {
          console.log(`[SOCKET] 📡 Broadcasting driver loc to rider:${currentTrip.rider_id}`);
          io.to(`rider:${currentTrip.rider_id}`).emit('driverLocationUpdate', {
            driverId: id,
            ...validated.data
          });

          // Live ETA push (throttled to 10 s per trip): compute the
          // remaining distance over the stored authoritative leg and
          // emit an updated arrival time — zero Google calls.
          const leg: 'pickup' | 'destination' =
            currentTrip.status === TripStatus.ACCEPTED ? 'pickup' : 'destination';
          const etaThrottleKey = `eta:live:${currentTrip.id}`;
          try {
            const lastEta = await redis.get(etaThrottleKey);
            const nowS = Date.now();
            if (!lastEta || nowS - parseInt(lastEta, 10) > 10000) {
              const stored = await RouteStoreService.getRideRoute(currentTrip.id, leg);
              if (stored && stored.geometry.coordinates.length >= 2) {
                const { remainingMeters, etaSeconds } = RouteStoreService.computeRemaining(
                  stored.geometry.coordinates,
                  validated.data.lat,
                  validated.data.lng,
                );
                io.to(`rider:${currentTrip.rider_id}`).emit('driverEtaUpdate', {
                  tripId: currentTrip.id,
                  leg,
                  etaSeconds,
                  remainingMeters: Math.round(remainingMeters),
                });
                await redis.set(etaThrottleKey, nowS.toString(), 'EX', 30);
              }
            }
          } catch {
            // ETA push is best-effort — never block location updates on it.
          }

          // Driver ARRIVED at pickup: once the driver enters the pickup
          // grace zone, the rider gets a real phone notification. Guarded
          // by a Redis NX key + DB event_id dedup → exactly one per trip.
          if (currentTrip.status === TripStatus.ACCEPTED && currentTrip.rider_id) {
            try {
              const distToPickup = haversineMeters(
                { lat: validated.data.lat, lng: validated.data.lng },
                currentTrip.pickup,
              );
              if (distToPickup <= env.DRIVER_PICKUP_PROXIMITY_M * 2) {
                notifyDriverArrived(
                  currentTrip.rider_id,
                  currentTrip.id,
                  'Your driver',
                ).catch(() => undefined);
              }
            } catch {
              // Arrival notification is best-effort.
            }
          }
        }
      });

      socket.on('acceptTrip', async (payload: string | { tripId: string; offerId?: string }) => {
        let tripId: string;
        let offerId: string | undefined;

        if (typeof payload === 'string') {
          tripId = payload;
        } else {
          tripId = payload.tripId;
          offerId = payload.offerId;
        }

        const validated = validate(AcceptTripSchema, tripId, socket, 'acceptTrip');
        if (!validated.success) return;

        console.log(`[SOCKET] Driver ${id} accepts trip: ${tripId}${offerId ? ` (offer=${offerId})` : ''}`);
        try {
          // Single source of truth: RideService.acceptTrip validates the
          // offer (SENT + belongs to this driver), atomically accepts it,
          // and assigns the trip. The offer MUST NOT be accepted here first:
          // RideService re-validates the offer status and would reject an
          // already-ACCEPTED offer with "Offer is in state ACCEPTED...",
          // failing every legitimate accept. On failure the driver app
          // rolls back its optimistic state via the acceptTripFailed event.
          const acceptedTrip = await RideService.acceptTrip(tripId, id);
          // Prime the active-trip cache immediately so the very next
          // location update broadcasts to the rider without a DB query.
          setCachedCurrentRide(id, UserRole.DRIVER, acceptedTrip);
        } catch (err: any) {
          console.error(`[SOCKET] Accept trip failed: ${err.message}`);
          socket.emit('acceptTripFailed', err.message);
        }
      });

      socket.on('declineTrip', async (payload: string | { tripId: string; offerId?: string }) => {
        let tripId: string;
        let offerId: string | undefined;

        if (typeof payload === 'string') {
          tripId = payload;
        } else {
          tripId = payload.tripId;
          offerId = payload.offerId;
        }

        const validated = validate(DeclineTripSchema, tripId, socket, 'declineTrip');
        if (!validated.success) return;

        console.log(`[SOCKET] Driver ${id} declined trip: ${tripId}${offerId ? ` (offer=${offerId})` : ''}`);
        try {
          if (offerId) {
            const { DriverOfferService } = await import('../services/driver-offer.service');
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
          const { RideRejectionService } = await import('../services/ride-rejection.service');
          await RideRejectionService.recordRejection(tripId, id).catch((err: any) => {
            console.error(`[SOCKET] Failed to persist rejection for ${tripId}/${id}: ${err.message}`);
          });
          // Re-enqueue matching so the system progresses to the next candidate
          const { RideRepository } = await import('../modules/ride/ride.repository');
          const trip = await RideRepository.findById(tripId);
          if (trip && trip.status === 'REQUESTED') {
            if (env.LEGACY_SYNC_MATCHING) {
              const { matchingService } = await import('../services/matching.service');
              matchingService.findAndDispatch(
                io, tripId, (trip as any).pickup?.lat ?? 0, (trip as any).pickup?.lng ?? 0, trip.rider_id,
              ).catch((err: any) => console.error(`[SOCKET] In-process re-match failed for ${tripId}: ${err.message}`));
            } else {
              const { matchQueue } = await import('../queue/queue');
              await matchQueue.add('matchRide', {
                tripId,
                pickupLat: (trip as any).pickup?.lat ?? 0,
                pickupLng: (trip as any).pickup?.lng ?? 0,
                riderId: trip.rider_id,
                retryCount: 0,
              });
            }
          }
        } catch (err: any) {
          console.error(`[SOCKET] Decline trip failed: ${err.message}`);
        }
      });

      socket.on('cancelTrip', async (payload: unknown) => {
        const validated = validate(CancelTripSchema, payload, socket, 'cancelTrip');
        if (!validated.success || !validated.data) return;

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
          const { DriverOfferService } = await import('../services/driver-offer.service');
          await DriverOfferService.releaseDriver(id);

          await RideService.cancelTrip(tripId, id, cancelOpts);
          clearCachedCurrentRide(id, UserRole.DRIVER);
        } catch (err: any) {
          console.error(`[SOCKET] Cancel trip failed: ${err.message}`);
          // Dedicated event so the client can distinguish a REJECTED
          // cancellation from a generic socket error (spec §60).
          socket.emit('cancelTripFailed', { message: err.message });
        }
      });

      socket.on('pickUpRider', async (tripId: string) => {
        const validated = validate(PickUpRiderSchema, tripId, socket, 'pickUpRider');
        if (!validated.success || !validated.data) return;
        
        console.log(`[SOCKET] 🚕 Driver ${id} picked up rider for trip: ${validated.data}`);
        try {
          const trip: any = await RideService.getCurrentRide(id, UserRole.DRIVER);
          console.log(`[SOCKET] pickUpRider: getCurrentRide returned`, trip?.id, 'match:', trip?.id === validated.data);
          if (!trip || trip.id !== validated.data) {
            socket.emit('error', 'You are not assigned to this trip.');
            return;
          }
          const driverLoc = await LocationsService.getDriverLocation(id);
          console.log(`[SOCKET] pickUpRider: driverLoc=`, driverLoc);
          if (!driverLoc) {
            socket.emit('error', 'Driver location unknown. Make sure GPS is enabled.');
            return;
          }
          const dist = haversineMeters(driverLoc, trip.pickup);
          console.log(`[SOCKET] pickUpRider: dist=`, dist, 'limit=', env.DRIVER_PICKUP_PROXIMITY_M);
          
          const arrival = driverArrivalTimes.get(validated.data) || {};
          const now = Date.now();
          const strictLimit = env.DRIVER_PICKUP_PROXIMITY_M;
          const graceLimit = strictLimit * 2; // 2x strict limit during grace
          
          if (dist > strictLimit) {
            // Not at pickup yet - record arrival time if close
            if (dist <= graceLimit) {
              if (!arrival.pickupArrivedAt) {
                arrival.pickupArrivedAt = now;
                driverArrivalTimes.set(validated.data, arrival);
              }
              
              const waitTimeS = Math.ceil((now - arrival.pickupArrivedAt!) / 1000);
              const graceS = env.DRIVER_PROXIMITY_GRACE_S;
              const waitTimerS = env.DRIVER_WAIT_TIMER_S;
              
              if (waitTimeS >= waitTimerS) {
                console.log(`[SOCKET] pickUpRider: wait timer (${waitTimerS}s) exceeded, force-allowing pickup`);
              } else if (waitTimeS >= graceS) {
                console.log(`[SOCKET] pickUpRider: grace period (${graceS}s) exceeded, allowing pickup`);
              } else {
                socket.emit('error', `You must be at the pickup to start the trip. You are ${Math.round(dist)}m away (${graceS - waitTimeS}s grace remaining).`);
                return;
              }
            } else {
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
          await RideService.updateTripStatus(validated.data, TripStatus.IN_PROGRESS, id);
          console.log(`[SOCKET] pickUpRider: updateTripStatus done`);
          clearCachedCurrentRide(id, UserRole.DRIVER);
          
          // Clear arrival time on successful pickup
          if (arrival.pickupArrivedAt) {
            driverArrivalTimes.delete(validated.data);
          }
        } catch (err: any) {
          console.error(`[SOCKET] ❌ Pick up rider failed: ${err.message}`);
          socket.emit('error', err.message || 'Unable to start trip. Please ensure you are assigned to this ride.');
        }
      });

      socket.on('completeTrip', async (tripId: string) => {
        const validated = validate(CompleteTripSchema, tripId, socket, 'completeTrip');
        if (!validated.success || !validated.data) return;
        
        console.log(`[SOCKET] 🏁 Driver ${id} completed trip: ${validated.data}`);
        try {
          // Server-side proximity gate with grace period:
          // - AT the destination (within DRIVER_DESTINATION_PROXIMITY_M):
          //   allow immediately — the client already requires this radius
          //   to enable the COMPLETE TRIP button. The old gate forced a
          //   30-60s wait even standing on the destination pin, which the
          //   driver app swallowed silently and left the ride IN_PROGRESS
          //   forever (both apps stuck on the ride screen).
          // - Close (within 1.5x): grace period after DRIVER_PROXIMITY_GRACE_S
          // - Nearby (within 2x): wait timer after DRIVER_WAIT_TIMER_S
          const trip: any = await RideService.getCurrentRide(id, UserRole.DRIVER);
          if (!trip || trip.id !== tripId) {
            socket.emit('error', 'You are not assigned to this trip.');
            return;
          }
          const driverLoc = await LocationsService.getDriverLocation(id);
          if (!driverLoc) {
            socket.emit('error', 'Driver location unknown. Make sure GPS is enabled.');
            return;
          }
          const dist = haversineMeters(driverLoc, trip.destination);
          const strict = env.DRIVER_DESTINATION_PROXIMITY_M;
          const graceDist = strict * 1.5;
          const waitDist = strict * 2;
          const graceS = env.DRIVER_PROXIMITY_GRACE_S;
          const waitTimerS = env.DRIVER_WAIT_TIMER_S;

          // Track arrival time
          const arrivalKey = `arrival:${tripId}`;
          let arrival = driverArrivalTimes.get(arrivalKey) || { destinationArrivedAt: undefined };
          
          if (dist <= strict) {
            console.log(`[SOCKET] completeTrip: at destination (${Math.round(dist)}m <= ${strict}m), allowing complete`);
          } else if (dist <= graceDist) {
            if (!arrival.destinationArrivedAt) {
              arrival.destinationArrivedAt = Date.now();
              driverArrivalTimes.set(arrivalKey, arrival);
            }
            const waitTimeS = (Date.now() - arrival.destinationArrivedAt) / 1000;
            
            if (waitTimeS >= waitTimerS) {
              console.log(`[SOCKET] completeTrip: wait timer (${waitTimerS}s) exceeded, force-allowing complete`);
            } else if (waitTimeS >= graceS) {
              console.log(`[SOCKET] completeTrip: grace period (${graceS}s) exceeded, allowing complete`);
            } else {
              socket.emit('error', `You must reach the destination to finish. You are ${Math.round(dist)}m away (${graceS - waitTimeS}s grace remaining).`);
              return;
            }
          } else if (dist <= waitDist) {
            // Within wait distance but not grace distance - only allow if wait timer exceeded
            if (arrival.destinationArrivedAt) {
              const waitTimeS = (Date.now() - arrival.destinationArrivedAt) / 1000;
              if (waitTimeS >= waitTimerS) {
                console.log(`[SOCKET] completeTrip: wait timer (${waitTimerS}s) exceeded at wait distance, allowing complete`);
              } else {
                socket.emit('error', `You must reach the destination to finish. You are ${Math.round(dist)}m away (${waitTimerS - waitTimeS}s wait timer remaining).`);
                return;
              }
            } else {
              socket.emit('error', `You must reach the destination to finish. You are ${Math.round(dist)}m away.`);
              return;
            }
          } else {
            // Too far - clear any arrival time
            if (arrival.destinationArrivedAt) {
              arrival.destinationArrivedAt = undefined;
              driverArrivalTimes.set(arrivalKey, arrival);
            }
            socket.emit('error', `You must reach the destination to finish. You are ${Math.round(dist)}m away.`);
            return;
          }
          
          await RideService.updateTripStatus(tripId, TripStatus.COMPLETED, id);
          clearCachedCurrentRide(id, UserRole.DRIVER);
          
          // Clear arrival time on successful completion
          if (arrival.destinationArrivedAt) {
            driverArrivalTimes.delete(arrivalKey);
          }
        } catch (err: any) {
          console.error(`[SOCKET] ❌ Complete trip failed: ${err.message}`);
          socket.emit('error', err.message || 'Unable to complete trip. Please try again.');
        }
      });

      socket.on('sendMessage', async (data: { tripId: string, message: string }) => {
        const validated = validate(SendMessageSchema, data, socket, 'sendMessage');
        if (!validated.success || !validated.data) return;
        
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
      socket.on('requestReroute', async (data: { tripId: string; leg: 'pickup' | 'destination'; lat: number; lng: number }) => {
        const validated = validate(RequestRerouteSchema, data, socket, 'requestReroute');
        if (!validated.success || !validated.data) return;
        
        console.log(`[SOCKET] 🔁 Driver ${id} requested reroute for trip ${validated.data.tripId} (leg: ${validated.data.leg})`);
        try {
          const trip: any = await RideService.getCurrentRide(id, UserRole.DRIVER);
          if (!trip || trip.id !== validated.data.tripId) {
            socket.emit('error', 'You are not assigned to this trip.');
            return;
          }

          // Rate limit reroutes: minimum 30 seconds between reroutes per trip+leg
          const rerouteKey = `reroute:${data.tripId}:${data.leg}`;
          const lastReroute = await redis.get(rerouteKey);
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
          const lastPos = await redis.get(lastPosKey);
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
          const route = await RerouteService.reroute(
            data.tripId,
            data.leg,
            data.lat,
            data.lng
          );
          
          // Store current position for distance check on next reroute
          await redis.set(lastPosKey, `${data.lat},${data.lng}`, 'EX', 3600);
          await redis.set(rerouteKey, Date.now().toString(), 'EX', 3600);

          NavigationService.emitRouteUpdated(
            io, data.tripId, id, trip.rider_id, data.leg, route
          );
        } catch (err: any) {
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
        clearCachedCurrentRide(id, UserRole.DRIVER);
        markOffline(id, 'driver').catch((err: any) =>
          console.error(`[SOCKET] ⚠️ Presence tracking failed on disconnect: ${err.message}`)
        );
      });
    }

    /**
     * RIDER EVENTS
     */
    if (role === UserRole.RIDER) {
      // Cancel any pending auto-cancel timer — rider is back online.
      const pendingTimer = riderAutoCancelTimers.get(id);
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        riderAutoCancelTimers.delete(id);
        console.log(`[SOCKET] ✅ Cleared auto-cancel timer for reconnecting rider ${id}`);
      }

      socket.on('subscribeToNearbyDrivers', (loc: Location) => {
        const validated = validate(SubscribeNearbyDriversSchema, loc, socket, 'subscribeToNearbyDrivers');
        if (!validated.success || !validated.data) return;
        
        const gh = geohash.encode(validated.data.lat, validated.data.lng, 6);
        const neighbors = geohash.neighbors(gh);
        const rooms = [gh, ...neighbors].map(g => `drivers:near:${g}`);
        
        // Leave old rooms
        (socket as any).subscribedGeohashes.forEach((room: string) => socket.leave(room));
        
        // Join new rooms
        rooms.forEach(room => socket.join(room));
        (socket as any).subscribedGeohashes = rooms;
        
        console.log(`[SOCKET] 🔍 Rider ${id} subscribed to geohash rooms: ${rooms.length}`);

        // Demand heatmap signal: the rider is live on the map. Cooldown
        // (300 s) keeps the 15 s subscription from flooding the table.
        recordRiderActivity({
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
      const reportActivitySchema = z.object({
        type: z.enum(['REQUEST_FLOW', 'APP_ACTIVE']),
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
      });
      socket.on('reportActivity', (payload: unknown) => {
        const parsed = reportActivitySchema.safeParse(payload);
        if (!parsed.success) return;
        recordRiderActivity({
          riderId: id,
          type: parsed.data.type,
          lat: parsed.data.lat,
          lng: parsed.data.lng,
        }).catch(() => undefined);
      });

      socket.on('updateLocation', async (loc: Location) => {
        const validated = validate(RiderUpdateLocationSchema, loc, socket, 'updateLocation');
        if (!validated.success || !validated.data) return;

        // Same per-user budget as drivers — the rider app throttles to
        // ~1 Hz client-side, and the server stays symmetric + bounded.
        const allowed = await checkRateLimit(socket, 'updateLocation');
        if (!allowed) return;
        
        try {
          // Broadcast to specific driver if rider is on a trip
          const currentTrip = await getCachedCurrentRide(id, UserRole.RIDER);
          if (currentTrip && currentTrip.driver_id && currentTrip.status !== TripStatus.COMPLETED) {
            console.log(`[SOCKET] 📡 Broadcasting rider loc to driver:${currentTrip.driver_id}`);
            io.to(`driver:${currentTrip.driver_id}`).emit('riderLocationUpdate', loc);
            // Demand heatmap signal: a rider actively on a trip near here.
            recordRiderActivity({
              riderId: id,
              type: 'APP_ACTIVE',
              lat: validated.data.lat,
              lng: validated.data.lng,
              tripId: currentTrip.id,
            }).catch(() => undefined);
          }
        } catch (err) {}
      });

      socket.on('getCurrentTrip', async () => {
        try {
          // Reconnect resync: after a socket blip, apps ask for the
          // authoritative trip (if any) instead of staying stuck in a
          // stale local state (e.g. rider stuck on "searching" after a
          // missed ACCEPTED tripUpdate).
          const currentTrip = await RideService.getCurrentRide(id, UserRole.RIDER);
          setCachedCurrentRide(id, UserRole.RIDER, currentTrip);
          console.log(`[SOCKET] getCurrentTrip for rider ${id}: ${currentTrip?.id ?? 'none'}`);
          if (currentTrip) {
            socket.emit('tripUpdate', currentTrip);
          } else {
            socket.emit('currentTripNone');
          }
        } catch (err: any) {
          console.error(`[SOCKET] getCurrentTrip failed: ${err.message}`);
        }
      });

      socket.on('requestRide', async (data: { pickup: Location & { address: string }; destination: Location & { address: string }; favoritePriority?: boolean; idempotencyKey?: string; promoCode?: string; applyCredits?: boolean; creditUseCents?: number; specialRedemptionId?: string }) => {
        const validated = validate(RequestRideSchema, data, socket, 'requestRide');
        if (!validated.success || !validated.data) return;
        
        console.log(`[SOCKET] 🚕 Ride request from rider ${id}: From ${validated.data.pickup.address} to ${validated.data.destination.address} favorite=${!!validated.data.favoritePriority} special=${validated.data.specialRedemptionId ?? 'none'}`);
        try {
          const trip = await RideService.requestRide(
            id, 
            data.pickup, 
            data.destination,
            undefined,
            false,
            data.idempotencyKey,
            { promoCode: data.promoCode, applyCredits: data.applyCredits, creditUseCents: data.creditUseCents, specialRedemptionId: data.specialRedemptionId },
            validated.data.favoritePriority
          );
          setCachedCurrentRide(id, UserRole.RIDER, trip);
          socket.emit('tripUpdate', trip);

          // Demand heatmap signal: a REAL ride request — the strongest
          // demand marker on the platform.
          recordRiderActivity({
            riderId: id,
            type: 'RIDE_REQUESTED',
            lat: data.pickup.lat,
            lng: data.pickup.lng,
            tripId: trip.id,
          }).catch(() => undefined);
        } catch (err: any) {
          console.error(`[SOCKET] ❌ Request ride failed: ${err.message}`);
          socket.emit('error', err.message);
        }
      });

      socket.on('cancelTrip', async (payload: unknown) => {
        const validated = validate(CancelTripSchema, payload, socket, 'cancelTrip');
        if (!validated.success || !validated.data) return;

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
          const { DriverOfferService } = await import('../services/driver-offer.service');
          const releasedDriver = await DriverOfferService.cancelRideOffers(tripId);
          if (releasedDriver) {
            console.log(`[SOCKET] Released driver ${releasedDriver} from cancelled ride ${tripId}`);
          }
          await RideService.cancelTrip(tripId, id, cancelOpts);
          clearCachedCurrentRide(id, UserRole.RIDER);
        } catch (err: any) {
          console.error(`[SOCKET] Cancel trip failed: ${err.message}`);
          // Dedicated event so the client can distinguish a REJECTED
          // cancellation from a generic socket error (spec §60).
          socket.emit('cancelTripFailed', { message: err.message });
        }
      });

      socket.on('sendMessage', async (data: { tripId: string, message: string }) => {
        const validated = validate(SendMessageSchema, data, socket, 'sendMessage');
        if (!validated.success || !validated.data) return;
        
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
      socket.on('riderDestinationChanged', async (data: { tripId: string; lat: number; lng: number; address: string }) => {
        const validated = validate(RiderDestinationChangedSchema, data, socket, 'riderDestinationChanged');
        if (!validated.success || !validated.data) return;
        
        console.log(`[SOCKET] 🎯 Rider ${id} changed destination for trip ${validated.data.tripId} → ${validated.data.address}`);
        try {
          const trip: any = await RideService.getCurrentRide(id, UserRole.RIDER);
          setCachedCurrentRide(id, UserRole.RIDER, trip);
          if (!trip || trip.id !== data.tripId || !trip.driver_id) {
            socket.emit('error', 'No active trip to update.');
            return;
          }
          // Persist new destination on the ride (trajectory kept).
          await pool.query(
            `UPDATE rides SET destination_lat = $1, destination_lng = $2, destination_address = $3 WHERE id = $4`,
            [data.lat, data.lng, data.address, data.tripId]
          );

          // Re-route the destination leg from where the driver is now.
          const driverLoc = await LocationsService.getDriverLocation(trip.driver_id);
          const start: [number, number] = driverLoc
            ? [driverLoc.lat, driverLoc.lng]
            : [trip.pickup.lat, trip.pickup.lng];
          const route = await NavigationService.cacheRouteLeg(
            data.tripId,
            'destination',
            start,
            [data.lat, data.lng]
          );
          await pool.query(
            `UPDATE rides SET route_metadata = route_metadata || $1::jsonb WHERE id = $2`,
            [JSON.stringify({ destination: route }), data.tripId]
          );

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
        } catch (err: any) {
          console.error(`[SOCKET] ❌ riderDestinationChanged failed: ${err.message}`);
          socket.emit('error', err.message || 'Unable to update destination.');
        }
      });

      socket.on('disconnect', async () => {
        console.log(`[SOCKET] ❌ Rider ${id} disconnected`);
        clearCachedCurrentRide(id, UserRole.RIDER);
        
        // Mark rider as offline for push notification delivery
        markOffline(id, 'rider').catch((err: any) =>
          console.error(`[SOCKET] ⚠️ Presence tracking failed on disconnect: ${err.message}`)
        );

        // Cancel ride if rider doesn't reconnect within 3 minutes.
        // This covers: app force-closed, OS killed background process.
        // Brief app switches reconnect within seconds and clear the timer.
        const timer = setTimeout(async () => {
          riderAutoCancelTimers.delete(id);
          try {
            const currentTrip = await RideService.getCurrentRide(id, UserRole.RIDER);
            if (currentTrip && currentTrip.status === TripStatus.REQUESTED) {
              console.log(`[SOCKET] 🧹 Auto-cancelling stale request for disconnected rider ${id}: ${currentTrip.id}`);
              await RideService.cancelTrip(currentTrip.id, id);
            }
          } catch (err) {}
        }, 180_000); // 3 minutes
        riderAutoCancelTimers.set(id, timer);
      });
    }

    socket.on('error', (err) => {
      console.error('[SOCKET] 💥 Error:', err);
    });
  });
}

function updateDriverGeohashRoom(socket: Socket, newGeohash: string) {
  const currentGh = (socket as any).currentGeohash;
  if (currentGh !== newGeohash) {
    if (currentGh) {
      socket.leave(`drivers:at:${currentGh}`);
    }
    socket.join(`drivers:at:${newGeohash}`);
    (socket as any).currentGeohash = newGeohash;
  }
}

function leaveGeohashRoom(socket: Socket) {
  const currentGh = (socket as any).currentGeohash;
  if (currentGh) {
    socket.leave(`drivers:at:${currentGh}`);
    (socket as any).currentGeohash = null;
  }
}
