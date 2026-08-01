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
import { RouteStoreService } from './route-store.service';

export type NavigationLeg = 'pickup' | 'destination';

const ROUTE_TTL_SECONDS = 30 * 60;

export interface CachedRoutePayload extends RouteResponse {
  cachedAt: string;
  /** [lng,lat] coordinate array — mirrors `geometry` for clients that
   *  parse a flat polyline key. Additive, never breaks existing fields. */
  polyline?: Array<[number, number]>;
  /** Static duration alias — additive. */
  duration?: number;
  trafficDurationSeconds?: number | null;
}

export class NavigationService {
  /**
   * Fetch + cache a route for a leg. Called at:
   *   - acceptTrip (pickup leg)
   *   - pickUpRider (destination leg)
   *   - rerouteRequested (forced refresh)
   *
   * Returns the route payload so the socket handler can pass it to the
   * driver and rider rooms in the same emit. The result is persisted to
   * the ride_routes store as well, so a Redis flush never loses the leg.
   */
  static async cacheRouteLeg(
    tripId: string,
    leg: NavigationLeg,
    start: [number, number],
    end: [number, number]
  ): Promise<CachedRoutePayload> {
    const route = await GeospatialService.getRoute(start, end);
    const payload: CachedRoutePayload = {
      ...route,
      polyline: route.geometry?.coordinates ?? [],
      duration: route.osrm_duration,
      trafficDurationSeconds: null,
      cachedAt: new Date().toISOString(),
    };
    await redis.set(this.cacheKey(tripId, leg), JSON.stringify(payload), 'EX', ROUTE_TTL_SECONDS);

    // Persist the authoritative leg so the rider-generated / previously
    // computed route survives Redis restarts and cache evictions.
    try {
      await RouteStoreService.saveRideRoute({
        rideId: tripId,
        leg,
        origin: [start[0], start[1]],
        destination: [end[0], end[1]],
        distanceMeters: route.distance,
        durationSeconds: route.osrm_duration,
        trafficDurationSeconds: null,
        etaSeconds: route.eta,
        geometry: route.geometry,
        steps: route.steps ?? [],
        engine: route.engine,
        cacheHit: route.cache_hit === true,
      });
    } catch (err: any) {
      // Best-effort: the Redis leg cache remains the hot-path source.
      console.error(`[NAV] ride_routes persist failed: ${err.message}`);
    }

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
      if (raw) return JSON.parse(raw);
    } catch {
      // fall through to the DB-backed store
    }

    // Redis miss (flush, eviction, restart) — the ride_routes table is
    // the durable copy. Wire the stored row into the same payload shape.
    try {
      const stored = await RouteStoreService.getRideRoute(tripId, leg);
      if (stored) {
        return {
          distance: stored.distanceMeters,
          osrm_duration: stored.durationSeconds,
          duration: stored.durationSeconds,
          eta: stored.etaSeconds,
          geometry: stored.geometry,
          polyline: stored.geometry.coordinates,
          steps: stored.steps,
          speedLimitsByRoad: {},
          cache_hit: stored.cacheHit,
          model_multiplier: 1.0,
          engine: stored.engine,
          trafficDurationSeconds: stored.trafficDurationSeconds,
          cachedAt: stored.createdAt,
        };
      }
    } catch {
      // No durable copy either.
    }

    return null;
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
    io.to(`rider:${riderId}`).emit('navigationStarted', { tripId, leg, route });
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
    io.to(`rider:${riderId}`).emit('navigationLegAdvanced', { tripId, leg: 'destination', route });
  }

  /**
   * Emit `navigationRouteUpdated` after a reroute. Both the driver and
   * the rider receive the new polyline + steps so the rider map renders
   * the same authoritative route (single source of truth).
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
    io.to(`rider:${riderId}`).emit('navigationRerouteRequested', { tripId, leg, route });
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