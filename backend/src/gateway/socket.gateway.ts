// backend/src/gateway/socket.gateway.ts
import { Server, Socket } from 'socket.io';
import { LocationsService } from '../modules/location/locations.service';
import { RideService } from '../modules/ride/ride.service';
import { RideMessagesRepository } from '../modules/ride/ride_messages.repository';
import { matchingService } from '../services/matching.service';
import { NavigationService } from '../services/navigation.service';
import { pool } from '../config/database';
import { UserRole, Location, TripStatus } from '../types';
import { env } from '../config/env';
import * as geohash from 'ngeohash';

// ---- Chat hardening ------------------------------------------------------
//
// Validation + rate-limiting helpers shared by the driver and rider
// `sendMessage` handlers. The goal is that the only thing the handlers
// have to do is route to the right counterpart room — every other
// invariant (auth, trip state, payload shape, DoS protection, persistence)
// is handled here.

import { redis } from '../config/redis';
import { rateLimitedTotal } from '../observability/metrics';

const MAX_MESSAGE_BODY = 1000;
const RATE_LIMIT_PER_MINUTE = 30;
const RATE_WINDOW_MS = 60 * 1000;

const SOCKET_RATE_LIMIT_LUA = `
local cutoff = tonumber(ARGV[3]) - tonumber(ARGV[2])
redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", cutoff)
local count = redis.call("ZCARD", KEYS[1])
if count >= tonumber(ARGV[1]) then
  return {0, count}
end
redis.call("ZADD", KEYS[1], ARGV[3], ARGV[4])
redis.call("PEXPIRE", KEYS[1], tonumber(ARGV[2]))
return {1, count + 1}
`;

async function consumeRateBudget(key: string): Promise<boolean> {
  const now = Date.now();
  const member = `${now}:${Math.random().toString(36).slice(2, 10)}`;
  const redisKey = `ratelimit:sock:${key}`;
  const result = await redis.eval(SOCKET_RATE_LIMIT_LUA, 1, redisKey, String(RATE_LIMIT_PER_MINUTE), String(RATE_WINDOW_MS), String(now), member) as [number, number];
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
    // Authentication context from middleware
    const { id, role } = (socket as any).user || {};
    
    console.log(`[SOCKET] ✅ Connected: ${id} as ${role} (SocketID: ${socket.id})`);

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
    if (role === UserRole.DRIVER) {
      LocationsService.removeDriverLocation(id).catch(() => {});
    }

    /**
     * DRIVER EVENTS
     */
    if (role === UserRole.DRIVER) {
      socket.on('goOnline', async (loc?: Location) => {
        console.log(`[SOCKET] 🟢 Driver ${id} is now ONLINE`);

        (socket as any).isOnline = true;
        if (loc) {
          const gh = await LocationsService.updateDriverLocation(id, loc);
          updateDriverGeohashRoom(socket, gh);
        }
      });

      socket.on('goOffline', async () => {
        console.log(`[SOCKET] 🔴 Driver ${id} is now OFFLINE`);
        (socket as any).isOnline = false;
        leaveGeohashRoom(socket);

        await LocationsService.removeDriverLocation(id);
      });

      socket.on('updateLocation', async (loc: Location) => {
        try {
          if ((socket as any).isOnline) {
            console.log(`[SOCKET] 📍 Location from driver ${id}: lat=${loc.lat}, lng=${loc.lng}`);
            const gh = await LocationsService.updateDriverLocation(id, loc);
            updateDriverGeohashRoom(socket, gh);

            const payload = {
              driverId: id,
              ...loc,
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
        const currentTrip = await RideService.getCurrentRide(id, UserRole.DRIVER);
        if (currentTrip && currentTrip.status !== TripStatus.COMPLETED && currentTrip.status !== TripStatus.CANCELLED) {
          console.log(`[SOCKET] 📡 Broadcasting driver loc to rider:${currentTrip.rider_id}`);
          io.to(`rider:${currentTrip.rider_id}`).emit('driverLocationUpdate', {
            driverId: id,
            ...loc
          });
        }
      });

      socket.on('acceptTrip', async (tripId: string) => {
        console.log(`[SOCKET] 🤝 Driver ${id} accepts trip: ${tripId}`);
        try {
          await RideService.acceptTrip(tripId, id);
        } catch (err: any) {
          console.error(`[SOCKET] ❌ Accept trip failed: ${err.message}`);
          socket.emit('error', err.message);
        }
      });

      socket.on('declineTrip', async (tripId: string) => {
        console.log(`[SOCKET] 🙅 Driver ${id} declined trip: ${tripId}`);
        try {
          await matchingService.handleDecline(io, tripId, id);
        } catch (err: any) {
          console.error(`[SOCKET] ❌ Decline trip failed: ${err.message}`);
        }
      });

      socket.on('pickUpRider', async (tripId: string) => {
        console.log(`[SOCKET] 🚕 Driver ${id} picked up rider for trip: ${tripId}`);
        try {
          // Server-side proximity gate: driver must be within
          // DRIVER_PICKUP_PROXIMITY_M of the pickup point to start the trip.
          const trip: any = await RideService.getCurrentRide(id, UserRole.DRIVER);
          console.log(`[SOCKET] pickUpRider: getCurrentRide returned`, trip?.id, 'match:', trip?.id === tripId);
          if (!trip || trip.id !== tripId) {
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
          if (dist > env.DRIVER_PICKUP_PROXIMITY_M) {
            socket.emit('error',
              `You must be at the pickup to start the trip. You are ${Math.round(dist)}m away.`);
            return;
          }
          console.log(`[SOCKET] pickUpRider: calling updateTripStatus`);
          await RideService.updateTripStatus(tripId, TripStatus.IN_PROGRESS, id);
          console.log(`[SOCKET] pickUpRider: updateTripStatus done`);
        } catch (err: any) {
          console.error(`[SOCKET] ❌ Pick up rider failed: ${err.message}`);
          socket.emit('error', err.message || 'Unable to start trip. Please ensure you are assigned to this ride.');
        }
      });

      socket.on('completeTrip', async (tripId: string) => {
        console.log(`[SOCKET] 🏁 Driver ${id} completed trip: ${tripId}`);
        try {
          // Server-side proximity gate: driver must be within
          // DRIVER_DESTINATION_PROXIMITY_M of the destination to finish.
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
          if (dist > env.DRIVER_DESTINATION_PROXIMITY_M) {
            socket.emit('error',
              `You must reach the destination to finish the trip. You are ${Math.round(dist)}m away.`);
            return;
          }
          await RideService.updateTripStatus(tripId, TripStatus.COMPLETED, id);
        } catch (err: any) {
          console.error(`[SOCKET] ❌ Complete trip failed: ${err.message}`);
          socket.emit('error', err.message || 'Unable to complete trip. Please try again.');
        }
      });

      socket.on('sendMessage', async (data: { tripId: string, message: string }) => {
        await relayChatMessage(io, socket, 'driver', data, { id, role: 'driver' });
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
        console.log(`[SOCKET] 🔁 Driver ${id} requested reroute for trip ${data.tripId} (leg: ${data.leg})`);
        try {
          const trip: any = await RideService.getCurrentRide(id, UserRole.DRIVER);
          if (!trip || trip.id !== data.tripId) {
            socket.emit('error', 'You are not assigned to this trip.');
            return;
          }
          const end =
            data.leg === 'pickup' ? trip.pickup : trip.destination;
          const route = await NavigationService.cacheRouteLeg(
            data.tripId,
            data.leg,
            [data.lat, data.lng],
            [end.lat, end.lng]
          );
          await pool.query(
            `UPDATE rides SET route_metadata = route_metadata || $1::jsonb WHERE id = $2`,
            [JSON.stringify({ [data.leg]: route }), data.tripId]
          );
          NavigationService.emitRouteUpdated(
            io, data.tripId, id, trip.rider_id, data.leg, route
          );
        } catch (err: any) {
          console.error(`[SOCKET] ❌ Reroute failed: ${err.message}`);
          socket.emit('error', err.message || 'Unable to refresh route. Please try again.');
        }
      });

      socket.on('disconnect', async () => {
        console.log(`[SOCKET] ❌ Driver ${id} disconnected`);
        try {
          await LocationsService.removeDriverLocation(id);
        } catch (err) {}
      });
    }

    /**
     * RIDER EVENTS
     */
    if (role === UserRole.RIDER) {
      socket.on('subscribeToNearbyDrivers', (loc: Location) => {
        const gh = geohash.encode(loc.lat, loc.lng, 6);
        const neighbors = geohash.neighbors(gh);
        const rooms = [gh, ...neighbors].map(g => `drivers:near:${g}`);
        
        // Leave old rooms
        (socket as any).subscribedGeohashes.forEach((room: string) => socket.leave(room));
        
        // Join new rooms
        rooms.forEach(room => socket.join(room));
        (socket as any).subscribedGeohashes = rooms;
        
        console.log(`[SOCKET] 🔍 Rider ${id} subscribed to geohash rooms: ${rooms.length}`);
      });

      socket.on('updateLocation', async (loc: Location) => {
        try {
          console.log(`[SOCKET] 📍 Location from rider ${id}: lat=${loc.lat}, lng=${loc.lng}`);
          // Broadcast to specific driver if rider is on a trip
          const currentTrip = await RideService.getCurrentRide(id, UserRole.RIDER);
          if (currentTrip && currentTrip.driver_id && currentTrip.status !== TripStatus.COMPLETED) {
            console.log(`[SOCKET] 📡 Broadcasting rider loc to driver:${currentTrip.driver_id}`);
            io.to(`driver:${currentTrip.driver_id}`).emit('riderLocationUpdate', loc);
          }
        } catch (err) {}
      });

      socket.on('requestRide', async (data: { pickup: Location & { address: string }; destination: Location & { address: string }; requestedClass?: any }) => {
        console.log(`[SOCKET] 🚕 Ride request from rider ${id}: From ${data.pickup?.address} to ${data.destination?.address} (Class: ${data.requestedClass})`);
        try {
          const trip = await RideService.requestRide(
            id, 
            data.pickup, 
            data.destination, 
            data.requestedClass as any
          );
          socket.emit('tripUpdate', trip);
        } catch (err: any) {
          console.error(`[SOCKET] ❌ Request ride failed: ${err.message}`);
          socket.emit('error', err.message);
        }
      });

      socket.on('cancelTrip', async (tripId: string) => {
        console.log(`[SOCKET] 🚫 Trip cancellation from rider ${id} for trip: ${tripId}`);
        try {
          await RideService.cancelTrip(tripId, id);
        } catch (err: any) {
          console.error(`[SOCKET] ❌ Cancel trip failed: ${err.message}`);
          socket.emit('error', 'Unable to cancel trip. Please try again.');
        }
      });

      socket.on('sendMessage', async (data: { tripId: string, message: string }) => {
        await relayChatMessage(io, socket, 'driver', data, { id, role: 'rider' });
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
        console.log(`[SOCKET] 🎯 Rider ${id} changed destination for trip ${data.tripId} → ${data.address}`);
        try {
          const trip: any = await RideService.getCurrentRide(id, UserRole.RIDER);
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
        
        // If rider has an active request, mark it for potential cleanup
        // We wait a few seconds before cancelling to allow for brief reconnects
        setTimeout(async () => {
          try {
            const currentTrip = await RideService.getCurrentRide(id, UserRole.RIDER);
            if (currentTrip && currentTrip.status === TripStatus.REQUESTED) {
              console.log(`[SOCKET] 🧹 Auto-cancelling stale request for disconnected rider ${id}: ${currentTrip.id}`);
              await RideService.cancelTrip(currentTrip.id, id);
            }
          } catch (err) {}
        }, 30000); // 30 second grace period
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
