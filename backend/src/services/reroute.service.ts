// backend/src/services/reroute.service.ts
//
// Backend reroute orchestration. The driver app's RerouteController asks
// this service for a fresh leg when the local recovery state machine
// decides a route change is actually required.
//
// Decision ladder (Google is always the LAST resort):
//   1. Stored ride route — if the ride already has a leg route whose
//      origin is within RIDE_LEG_REUSE_RADIUS_M of the driver's current
//      position and it is younger than RIDE_LEG_MAX_AGE_MS, reuse it
//      verbatim (zero Google traffic).
//   2. OD route cache — H3-neighbor lookup (configurable radius). A hit
//      reuses a stored Google polyline + steps and refreshes the leg
//      cache, emitting cache_hit=true so the driver can skip straight
//      back to ON_ROUTE.
//   3. Google Routes API — only when both stores miss.

import { pool } from '../config/database';
import { redis } from '../config/redis';
import { NavigationService, CachedRoutePayload, NavigationLeg } from './navigation.service';
import { RouteStoreService, LegName, haversineMeters } from './route-store.service';
import { logger } from '../observability/logger';

const RIDE_LEG_MAX_AGE_MS = 30 * 60 * 1000; // 30 min — matches the Redis leg TTL
const RIDE_LEG_REUSE_RADIUS_M = 300; // origin drift tolerated before we need a new route

interface RideEndpoints {
  pickup_lat: number | null;
  pickup_lng: number | null;
  destination_lat: number | null;
  destination_lng: number | null;
  rider_id: string | null;
}

export class RerouteService {
  /**
   * Produce a fresh route payload for a leg, using the store ladder
   * above. Returns the wire payload (CachedRoutePayload) already cached
   * in Redis + persisted in PG, ready to be handed to the driver app.
   */
  static async reroute(
    tripId: string,
    leg: NavigationLeg,
    lat: number,
    lng: number,
  ): Promise<CachedRoutePayload> {
    const ride = await this.loadRide(tripId);
    if (!ride) throw new Error('Trip not found');

    const end: [number, number] =
      leg === 'pickup'
        ? [ride.pickup_lat!, ride.pickup_lng!]
        : [ride.destination_lat!, ride.destination_lng!];

    // ---- Stage 1: fresh stored ride leg with a nearby origin ------------
    const stored = await RouteStoreService.getRideRoute(tripId, leg);
    if (stored) {
      const age = Date.now() - new Date(stored.createdAt).getTime();
      const originDist = haversineMeters([lat, lng], stored.origin);
      if (age <= RIDE_LEG_MAX_AGE_MS && originDist <= RIDE_LEG_REUSE_RADIUS_M) {
        logger.info(
          { tripId, leg, ageMs: age, originDistM: Math.round(originDist) },
          'reroute_stored_leg_reused',
        );
        return this.toPayload(stored, stored.trafficDurationSeconds ?? null);
      }
    }

    // ---- Stage 2: OD route cache (H3 neighbors) -------------------------
    try {
      const hit = await RouteStoreService.findOdcache([lat, lng], end, 1);
      if (hit) {
        const trafficSeconds = this.freshTraffic(hit.createdAt, hit.trafficDurationSeconds);
        const payload = this.toPayload(
          {
            ...hit,
            rideId: tripId,
            leg,
            origin: [lat, lng],
            destination: end,
            originH3: RouteStoreService.h3Cell(lat, lng),
            destH3: RouteStoreService.h3Cell(end[0], end[1]),
            routeHash: '',
            cacheHit: true,
            createdAt: new Date().toISOString(),
          },
          trafficSeconds,
        );
        await this.persist(tripId, leg, lat, lng, end, payload, trafficSeconds);
        logger.info(
          { tripId, leg, exactOd: hit.exactOd, originDistM: Math.round(hit.distanceMetersToOrigin) },
          'reroute_od_cache_hit',
        );
        return payload;
      }
    } catch (cacheErr) {
      logger.warn({ err: (cacheErr as Error).message }, 'reroute_od_cache_lookup_failed');
    }

    // ---- Stage 3: Google Routes API (last resort) -----------------------
    const payload = await NavigationService.cacheRouteLeg(tripId, leg, [lat, lng], end);
    await this.persist(tripId, leg, lat, lng, end, payload, null);
    logger.info({ tripId, leg }, 'reroute_google_fallback');
    return payload;
  }

  // ---- Internals ---------------------------------------------------------

  private static async loadRide(tripId: string): Promise<RideEndpoints | null> {
    try {
      const res = await pool.query(
        `SELECT pickup_lat, pickup_lng, destination_lat, destination_lng, rider_id
         FROM rides WHERE id = $1`,
        [tripId],
      );
      return res.rows[0] ?? null;
    } catch (err: any) {
      logger.error({ err: err.message }, 'reroute_load_ride_failed');
      throw new Error('Failed to load trip');
    }
  }

  /** Traffic-aware durations are only reusable while < 15 min old. */
  private static freshTraffic(createdAt: string, trafficSeconds: number | null): number | null {
    if (trafficSeconds == null) return null;
    const age = Date.now() - new Date(createdAt).getTime();
    return age <= 15 * 60 * 1000 ? trafficSeconds : null;
  }

  /** Build the wire payload the driver app parses (additive keys). */
  private static toPayload(stored: any, trafficSeconds: number | null): CachedRoutePayload {
    const staticDuration = stored.durationSeconds ?? stored.osrm_duration ?? 0;
    const effectiveDuration = trafficSeconds ?? staticDuration;
    const multiplier =
      staticDuration > 0 && effectiveDuration > 0
        ? Math.round((effectiveDuration / staticDuration) * 100) / 100
        : 1.0;

    return {
      distance: stored.distanceMeters ?? 0,
      osrm_duration: staticDuration,
      duration: staticDuration,
      eta: Math.round(effectiveDuration),
      geometry: stored.geometry,
      polyline: stored.geometry?.coordinates ?? [],
      steps: stored.steps ?? [],
      speedLimitsByRoad: stored.speedLimitsByRoad ?? {},
      cache_hit: stored.cacheHit === true,
      model_multiplier: multiplier,
      engine: stored.engine ?? 'GoogleRoutes',
      trafficDurationSeconds: trafficSeconds,
      cachedAt: new Date().toISOString(),
    };
  }

  /** Persist the leg: Redis trip_route + PG ride_routes + ride_metadata. */
  private static async persist(
    tripId: string,
    leg: LegName,
    lat: number,
    lng: number,
    end: [number, number],
    payload: CachedRoutePayload,
    trafficSeconds: number | null,
  ): Promise<void> {
    const redisKey = `trip_route:${tripId}:${leg}`;
    try {
      await redis.set(redisKey, JSON.stringify(payload), 'EX', 30 * 60);
    } catch {
      // Redis down — the ride_routes row is authoritative.
    }

    try {
      await RouteStoreService.saveRideRoute({
        rideId: tripId,
        leg,
        origin: [lat, lng],
        destination: end,
        distanceMeters: payload.distance,
        durationSeconds: payload.osrm_duration,
        trafficDurationSeconds: trafficSeconds,
        etaSeconds: payload.eta,
        geometry: payload.geometry,
        steps: payload.steps ?? [],
        engine: payload.engine,
        cacheHit: payload.cache_hit === true,
      });
    } catch (err: any) {
      logger.warn({ err: err.message }, 'reroute_ride_route_persist_failed');
    }

    try {
      await pool.query(
        `UPDATE rides SET route_metadata = route_metadata || $1::jsonb WHERE id = $2`,
        [JSON.stringify({ [leg]: payload }), tripId],
      );
    } catch (err: any) {
      logger.warn({ err: err.message }, 'reroute_metadata_persist_failed');
    }
  }
}
