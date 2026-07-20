// backend/src/services/navigation.service.ts
//
// Owns the per-trip, per-leg route cache and the navigation lifecycle
// socket events. Built so the driver app can hold a local cached route
// (one routing call per leg) and re-fetch only when an explicit reroute
// signal arrives — never poll the routing API unnecessarily.
//
// Cache shape:
//   key:    trip_route:{tripId}:{leg}     leg in {'pickup','destination'}
//   value:  JSON.stringify({ distance, duration, eta, polyline,
//                             steps[], speedLimitsByRoad, cachedAt })
//   TTL:    30 min (rides are short; longer than any real leg + headroom)

import { Server } from 'socket.io';
import { redis } from '../config/redis';
import { GeospatialService, RouteResponse } from '../modules/geospatial/geospatial.service';

export type NavigationLeg = 'pickup' | 'destination';

const ROUTE_TTL_SECONDS = 30 * 60;

export interface CachedRoutePayload extends RouteResponse {
  cachedAt: string;
}

export class NavigationService {
  /**
   * Fetch + cache a route for a leg. Called at:
   *   - acceptTrip (pickup leg)
   *   - pickUpRider (destination leg)
   *   - rerouteRequested (forced refresh)
   *
   * Returns the route payload so the socket handler can pass it to the
   * driver and rider rooms in the same emit.
   */
  static async cacheRouteLeg(
    tripId: string,
    leg: NavigationLeg,
    start: [number, number],
    end: [number, number]
  ): Promise<CachedRoutePayload> {
    const route = await GeospatialService.getRoute(start, end);
    const payload: CachedRoutePayload = { ...route, cachedAt: new Date().toISOString() };
    await redis.set(this.cacheKey(tripId, leg), JSON.stringify(payload), 'EX', ROUTE_TTL_SECONDS);
    return payload;
  }

  /**
   * Read a previously cached leg. Returns null if missing or expired.
   * The driver app's local navigator calls this on mount to rehydrate
   * its in-memory NavigationRoute without hitting the routing API again.
   */
  static async getCachedRouteLeg(tripId: string, leg: NavigationLeg): Promise<CachedRoutePayload | null> {
    try {
      const raw = await redis.get(this.cacheKey(tripId, leg));
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  static async clearTrip(tripId: string): Promise<void> {
    await Promise.all([
      redis.del(this.cacheKey(tripId, 'pickup')),
      redis.del(this.cacheKey(tripId, 'destination')),
    ]);
  }

  private static cacheKey(tripId: string, leg: NavigationLeg): string {
    return `trip_route:${tripId}:${leg}`;
  }

  // ---- Lifecycle emitters ------------------------------------------------

  /**
   * Emit `navigationStarted` to both driver + rider rooms when a driver
   * accepts a trip (pickup leg).
   */
  static emitStarted(
    io: Server,
    tripId: string,
    driverId: string,
    riderId: string,
    leg: NavigationLeg,
    route: CachedRoutePayload
  ): void {
    io.to(`driver:${driverId}`).emit('navigationStarted', { tripId, leg, route });
    io.to(`rider:${riderId}`).emit('navigationStarted', { tripId, leg });
  }

  /**
   * Emit `navigationLegAdvanced` when the trip flips from
   * ACCEPTED → IN_PROGRESS, picking up the destination leg.
   */
  static emitLegAdvanced(
    io: Server,
    tripId: string,
    driverId: string,
    riderId: string,
    route: CachedRoutePayload
  ): void {
    io.to(`driver:${driverId}`).emit('navigationLegAdvanced', { tripId, leg: 'destination', route });
    io.to(`rider:${riderId}`).emit('navigationLegAdvanced', { tripId });
  }

  /**
   * Emit `navigationRouteUpdated` after a reroute. Only the driver needs
   * the new polyline + steps; the rider only needs a "driver rerouting"
   * toast so they know why ETA just shifted.
   */
  static emitRouteUpdated(
    io: Server,
    tripId: string,
    driverId: string,
    riderId: string,
    leg: NavigationLeg,
    route: CachedRoutePayload
  ): void {
    io.to(`driver:${driverId}`).emit('navigationRouteUpdated', { tripId, leg, route });
    io.to(`rider:${riderId}`).emit('navigationRerouteRequested', { tripId, leg });
  }

  static emitEnded(
    io: Server,
    tripId: string,
    driverId: string,
    riderId: string
  ): void {
    io.to(`driver:${driverId}`).emit('navigationEnded', { tripId });
    io.to(`rider:${riderId}`).emit('navigationEnded', { tripId });
  }
}