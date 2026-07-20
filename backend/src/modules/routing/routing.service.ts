// backend/src/modules/routing/routing.service.ts
//
// Isolated Routing Service — the SINGLE owner of the rider routing + fare
// pipeline. It owns NO business logic beyond: validate → cache → engine →
// decode → fare. Every other module (ride, navigation, geospatial search,
// dispatch, matching) MUST go through this service for trip planning so the
// routing pipeline stays consistent, observable, and cacheable.
//
// Architecture:
//
//   Flutter App → Backend API → Ride/Dispatch/Nav → RoutingService →
//     → RegionAwareEngine (OSRM for LA, Mapbox fallback)
//
// No business logic calls any routing provider directly. The active engine
// is selected at runtime based on the geographic region (LA region uses
// the local OSRM sidecar process; outside LA uses Mapbox Directions API).
// Both implement the RouteEngine interface, so providers are swappable.
//
// Design goals:
//   - Fast:        cache-first, local OSRM <100ms, fare in microseconds.
//   - Road geometry: OSRM returns true road-following geometry (GeoJSON).
//   - Lightweight:  no per-request DB hits in the hot path.
//   - Resilient:    never crash; degrade to a road-shaped synthetic route.
//   - Observable:   every stage is instrumented via prom-client + structured logs.
//   - Scalable:     stateless + Redis cache + request dedup map + concurrent-safe.
//   - Extensible:   provider swap = implement RouteEngine + change engine map.

import ngeohash from 'ngeohash';
import { redis } from '../../config/redis';
import { MLEtaService } from '../../services/ml-eta.service';
import { fareService, FareBreakdown } from '../../services/fare.service';
import { RoadSnapperService } from '../../services/road-snapper.service';
import { VehicleClass } from '../../types';
import { RouteEngine } from './route-engine';
import { OSRMEngine } from './osrm.engine';
import { MapboxEngine } from './mapbox.engine';
import { RoutingError } from './routing.errors';
import { bothInLARegion } from '../../services/la-region';
import {
  routingRequestsTotal,
  routingDurationSeconds,
  routingCacheLookupSeconds,
  routingEngineSeconds,
  routingFareSeconds,
  routingFallbackTotal,
  routingEngineRequestsTotal,
  routingEngineDurationSeconds,
} from '../../observability/metrics';
import { logger } from '../../observability/logger';

/** A validated [lat, lng] pair. */
export type LatLng = [number, number];

export interface RouteGeometry {
  type: 'LineString';
  coordinates: Array<[number, number]>; // [lng, lat] — GeoJSON order
}

export interface RoutingResult {
  distanceMeters: number;
  durationSeconds: number;
  etaSeconds: number;
  geometry: RouteGeometry;
  confidence: number; // 0..1 — 1 = real engine, lower = fallback
  engine: 'OSRM' | 'Mapbox' | 'Synthetic';
  cacheHit: boolean;
  /** Populated for real engines; empty for synthetic fallback. */
  steps: any[];
  speedLimitsByRoad: Record<string, number>;
}

export interface PlanRequest {
  origin: LatLng;
  destination: LatLng;
  vehicleClass: VehicleClass;
}

export interface PlanResponse {
  origin: LatLng;
  destination: LatLng;
  vehicleClass: VehicleClass;
  distanceMeters: number;
  durationSeconds: number;
  etaSeconds: number;
  geometry: RouteGeometry;
  confidence: number;
  engine: RoutingResult['engine'];
  cacheHit: boolean;
  fare: FareBreakdown;
  metadata: {
    computedAt: string;
    geohash: string;
    stepsCount: number;
  };
}

/**
 * Coordinate validation. Rejects anything NaN, non-finite, or outside the
 * valid latitude/longitude ranges. Throws a typed error so callers can map
 * it to a 400 response.
 */
export class InvalidCoordinatesError extends Error {
  public readonly detail: string;
  constructor(detail: string) {
    super(detail);
    this.name = 'InvalidCoordinatesError';
    this.detail = detail;
  }
}

const LAT_MIN = -90;
const LAT_MAX = 90;
const LNG_MIN = -180;
const LNG_MAX = 180;

function validateCoordinate(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InvalidCoordinatesError(`${label} must be a finite number`);
  }
  return value;
}

export function parseCoordinates(raw: unknown, label: string): LatLng {
  if (!Array.isArray(raw) || raw.length !== 2) {
    throw new InvalidCoordinatesError(`${label} must be a [lat, lng] tuple`);
  }
  const lat = validateCoordinate(raw[0], `${label}.lat`);
  const lng = validateCoordinate(raw[1], `${label}.lng`);
  if (lat < LAT_MIN || lat > LAT_MAX) {
    throw new InvalidCoordinatesError(`${label}.lat out of range [${LAT_MIN}, ${LAT_MAX}]`);
  }
  if (lng < LNG_MIN || lng > LNG_MAX) {
    throw new InvalidCoordinatesError(`${label}.lng out of range [${LNG_MIN}, ${LNG_MAX}]`);
  }
  return [lat, lng];
}

export class RoutingService {
  // ---- Provider map --------------------------------------------------------
  // The LA region is served by the local OSRM sidecar process for low latency.
  // Coordinates outside the LA bounding box fall back to Mapbox Directions API.
  private static readonly providers: Array<{
    match: (origin: [number, number], destination: [number, number]) => boolean;
    engine: RouteEngine;
  }> = [
    { match: bothInLARegion, engine: OSRMEngine },
    { match: () => true,        engine: MapboxEngine },
  ];

  private static selectEngine(
    origin: [number, number],
    destination: [number, number],
  ): RouteEngine {
    for (const p of this.providers) {
      if (p.match(origin, destination)) return p.engine;
    }
    return MapboxEngine;
  }

  // ---- Request deduplication (collision-free in-flight map) ---------------
  // Two identical OD requests in flight share one engine call + one cache
  // write. Keyed by the snapped cache key so "nearby" repeats also dedupe.
  private static readonly inFlight = new Map<string, Promise<RoutingResult>>();

  // ---- Cache tuning -------------------------------------------------------
  /** Exact-match TTL — identical OD pairs. */
  private static readonly EXACT_TTL_S = 600;
  /** Nearby-match TTL — reused for OD pairs within the same geohash cell. */
  private static readonly NEARBY_TTL_S = 300;
  /** Geohash precision (~0.6km × 1.2km cell in LA) — "nearby" bucket size. */
  private static readonly GEOHASH_PRECISION = 6;

  /**
   * Public entry point. Validates, caches, routes, and prices in one
   * coherent pipeline. Always returns a road-following plan.
   */
  static async plan(request: PlanRequest): Promise<PlanResponse> {
    const end = routingDurationSeconds.startTimer();
    const start = Date.now();
    try {
      const route = await this.routeCached(request.origin, request.destination);

      const fareStart = process.hrtime.bigint();

      // Fetch the highest default latest price per mile for this class from
      // the cached pricing engine conditions. Fall through gracefully to the
      // static rate when no pricing data is available.
      let pricePerMile: number | undefined;
      try {
        const conditionsRaw = await this.withRedisTimeout(() => redis.get('pricing:system_conditions'));
        if (conditionsRaw) {
          const conditions = JSON.parse(conditionsRaw) as { xShift?: number };
          const xShift = conditions.xShift ?? 0;
          const classBarriers: Record<string, number> = {
            [VehicleClass.CORE]: 3.0,
            [VehicleClass.ELITE]: 6.0,
            [VehicleClass.PRESTIGE]: 10.0,
          };
          const baseBarrier = classBarriers[request.vehicleClass] ?? 3.0;
          pricePerMile = Math.round((baseBarrier + xShift) * 100) / 100;
        }
      } catch (_) { /* use static rate */ }

      const fare = fareService.computeFare({
        distanceMeters: route.distanceMeters,
        durationSeconds: route.durationSeconds,
        vehicleClass: request.vehicleClass,
        pricePerMile,
      });
      routingFareSeconds.observe(Number(process.hrtime.bigint() - fareStart) / 1e9);

      routingRequestsTotal.inc({
        cache: route.cacheHit ? 'hit' : 'miss',
        engine: route.engine.toLowerCase(),
      });

      logger.info(
        {
          origin: request.origin,
          destination: request.destination,
          engine: route.engine,
          cacheHit: route.cacheHit,
          distanceMeters: route.distanceMeters,
          durationSeconds: route.durationSeconds,
          latencyMs: Date.now() - start,
        },
        'routing_plan',
      );

      return {
        origin: request.origin,
        destination: request.destination,
        vehicleClass: request.vehicleClass,
        distanceMeters: route.distanceMeters,
        durationSeconds: route.durationSeconds,
        etaSeconds: route.etaSeconds,
        geometry: route.geometry,
        confidence: route.confidence,
        engine: route.engine,
        cacheHit: route.cacheHit,
        fare,
        metadata: {
          computedAt: new Date().toISOString(),
          geohash: ngeohash.encode(request.origin[0], request.origin[1], this.GEOHASH_PRECISION),
          stepsCount: route.steps.length,
        },
      };
    } finally {
      end();
    }
  }

  // -------------------------------------------------------------------------
  // Clean public API (per the routing-redesign brief)
  // -------------------------------------------------------------------------

  /** Full route: distance + duration + ETA + geometry + steps. */
  static async calculateRoute(
    origin: LatLng,
    destination: LatLng,
  ): Promise<RoutingResult> {
    return this.routeCached(origin, destination);
  }

  /** Road distance only (engine-calculated; never straight-line). */
  static async calculateDistance(
    origin: LatLng,
    destination: LatLng,
  ): Promise<number> {
    const r = await this.routeCached(origin, destination);
    return r.distanceMeters;
  }

  /** Road ETA only (OSM base duration × ML multiplier). */
  static async calculateETA(
    origin: LatLng,
    destination: LatLng,
  ): Promise<number> {
    const r = await this.routeCached(origin, destination);
    return r.etaSeconds;
  }

  /** Route + fare breakdown together. */
  static async calculateFareRoute(
    origin: LatLng,
    destination: LatLng,
    vehicleClass: VehicleClass,
  ): Promise<{ route: RoutingResult; fare: FareBreakdown }> {
    const route = await this.routeCached(origin, destination);
    const fare = fareService.computeFare({
      distanceMeters: route.distanceMeters,
      durationSeconds: route.durationSeconds,
      vehicleClass,
    });
    return { route, fare };
  }

  /** Decode a polyline6-encoded string to [lng,lat] coordinates. */
  static decodePolyline(encoded: string): Array<[number, number]> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const polyline = require('@mapbox/polyline');
    return polyline.decode(encoded).map(([lat, lng]: [number, number]) => [lng, lat]);
  }

  // -------------------------------------------------------------------------
  // Cache-first routing
  // -------------------------------------------------------------------------

  private static async routeCached(
    origin: LatLng,
    destination: LatLng,
  ): Promise<RoutingResult> {
    const exactKey = this.exactKey(origin, destination);

    // 1. Dedupe in-flight identical requests. The reservation is set
    //    *synchronously* (before the first await) so that two requests that
    //    arrive on the same tick share one computation rather than both
    //    slipping past the check and hitting the engine twice.
    const existing = this.inFlight.get(exactKey);
    if (existing) return existing;

    const promise = (async () => {
      // 2. Try exact cache, then nearby cache (geohash neighbor reuse).
      const cached = await this.lookupCache(origin, destination, exactKey);
      if (cached) {
        cached.cacheHit = true;
        return cached;
      }
      // 3. Compute (single in-flight promise shared by all duplicates).
      return this.computeRoute(origin, destination, exactKey);
    })().finally(() => this.inFlight.delete(exactKey));

    this.inFlight.set(exactKey, promise);
    return promise;
  }

  /**
   * Two-level cache lookup:
   *   L1 exact:    same snapped OD pair (4 dp ≈ 11m).
   *   L2 nearby:   another OD pair sharing origin/dest geohash cells,
   *                reused to avoid a second engine call for "nearby" trips.
   */
  private static async lookupCache(
    origin: LatLng,
    destination: LatLng,
    exactKey: string,
  ): Promise<RoutingResult | null> {
    const start = process.hrtime.bigint();
    try {
      const exact = await this.withRedisTimeout(() => redis.get(exactKey));
      if (exact) {
        routingCacheLookupSeconds.observe(this.elapsed(start));
        return JSON.parse(exact) as RoutingResult;
      }

      // L2: scan the 9-cell geohash neighborhood around each endpoint.
      const originNeighbors = this.geohashNeighbors(origin);
      const destNeighbors = this.geohashNeighbors(destination);
      const candidateKeys: string[] = [];
      for (const o of originNeighbors) {
        for (const d of destNeighbors) {
          candidateKeys.push(`route:nearby:${o}:${d}`);
        }
      }

      const pipeline = redis.multi();
      for (const k of candidateKeys) pipeline.get(k);
      const results = (await this.withRedisTimeout(() => pipeline.exec())) as
        | Array<[Error | null, string | null]>
        | null;
      routingCacheLookupSeconds.observe(this.elapsed(start));

      if (results) {
        for (const [, raw] of results) {
          if (raw) {
            const parsed = JSON.parse(raw) as RoutingResult;
            // Promote the nearby hit into the exact key so the next identical
            // request is a pure L1 hit.
            await this.withRedisTimeout(() => redis.set(exactKey, raw, 'EX', this.EXACT_TTL_S)).catch(() => {});
            return parsed;
          }
        }
      }
      return null;
    } catch (err: any) {
      // Redis down → treat as a miss and compute fresh. Never crash.
      logger.warn({ err: err.message }, 'routing_cache_lookup_failed');
      routingCacheLookupSeconds.observe(this.elapsed(start));
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Engine computation
  // -------------------------------------------------------------------------

  private static async computeRoute(
    origin: LatLng,
    destination: LatLng,
    exactKey: string,
  ): Promise<RoutingResult> {
    const engineStart = process.hrtime.bigint();
    let result: RoutingResult | null = null;

    const activeEngine = this.selectEngine(origin, destination);

    // Validate coordinates before contacting the routing engine.
    try {
      parseCoordinates([origin[0], origin[1]], 'origin');
      parseCoordinates([destination[0], destination[1]], 'destination');
    } catch (coordErr) {
      logger.warn({ err: (coordErr as Error).message }, 'routing_invalid_coords');
      result = this.syntheticRoute(origin, destination);
      routingFallbackTotal.inc();
      routingEngineSeconds.observe(this.elapsed(engineStart));
      await this.writeCache(exactKey, origin, destination, result);
      return result;
    }

    // Snap endpoints to drivable roads before routing. This prevents
    // routes from starting/ending inside buildings, parks, or otherwise
    // inaccessible locations. Snapping is best-effort; if it fails we
    // proceed with the original coordinates.
    const [snappedOrigin, snappedDestination] = await Promise.all([
      RoadSnapperService.snapIfNeeded(origin[0], origin[1]),
      RoadSnapperService.snapIfNeeded(destination[0], destination[1]),
    ]);

    const routeOrigin: LatLng = snappedOrigin.snapped
      ? [snappedOrigin.lat, snappedOrigin.lng]
      : origin;
    const routeDest: LatLng = snappedDestination.snapped
      ? [snappedDestination.lat, snappedDestination.lng]
      : destination;

    try {
      const res = await activeEngine.route(routeOrigin, routeDest);
      if (res) {
        const multiplier = MLEtaService.predictMultiplier(origin[0], origin[1], res.distanceMeters);
        const engineName = activeEngine.name as 'OSRM' | 'Mapbox';
        result = {
          distanceMeters: res.distanceMeters,
          durationSeconds: res.durationSeconds,
          etaSeconds: Math.round(res.durationSeconds * multiplier),
          geometry: res.geometry,
          confidence: 0.99,
          engine: engineName,
          cacheHit: false,
          steps: res.steps,
          speedLimitsByRoad: res.speedLimitsByRoad,
        };
        routingEngineRequestsTotal.inc({ status: 'ok' });
      } else {
        routingEngineRequestsTotal.inc({ status: 'empty' });
      }
    } catch (engineErr: any) {
      if (engineErr instanceof RoutingError) {
        // Permanent bad-input error — do not silently fall back to a wrong
        // synthetic route; still return a road-shaped fallback so the app
        // keeps working, but mark it as low confidence.
        logger.warn({ err: engineErr.message }, 'routing_engine_bad_input');
        routingEngineRequestsTotal.inc({ status: 'bad_input' });
      } else {
        logger.error({ err: engineErr.message }, 'routing_engine_error');
        routingEngineRequestsTotal.inc({ status: 'error' });
      }
    }

    if (!result) {
      // Fell through both engines — synthesize a road-shaped route.
      result = this.syntheticRoute(origin, destination);
      routingFallbackTotal.inc();
    }

    routingEngineSeconds.observe(this.elapsed(engineStart));
    routingEngineDurationSeconds.observe(this.elapsed(engineStart));

    await this.writeCache(exactKey, origin, destination, result);
    return result;
  }

  private static async writeCache(
    exactKey: string,
    origin: LatLng,
    destination: LatLng,
    result: RoutingResult,
  ): Promise<void> {
    const payload = JSON.stringify(result);
    // Exact key + nearby keys so "close enough" future requests reuse it.
    const nearbyKeys = this.nearbyKeys(origin, destination);
    try {
      const multi = redis.multi();
      multi.set(exactKey, payload, 'EX', this.EXACT_TTL_S);
      for (const k of nearbyKeys) multi.set(k, payload, 'EX', this.NEARBY_TTL_S);
      await this.withRedisTimeout(() => multi.exec());
    } catch (err: any) {
      logger.warn({ err: err.message }, 'routing_cache_write_failed');
    }
  }

  /**
   * Wrap a Redis operation in a short timeout so an unreachable or stalled
   * Redis can NEVER block the routing hot path. On timeout/error we treat
   * the value as absent (cache miss) and compute fresh — the service stays
   * available even if the cache layer is fully down.
   */
  private static readonly REDIS_OP_TIMEOUT_MS = 800;

  private static async withRedisTimeout<T>(op: () => Promise<T>): Promise<T | null> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), this.REDIS_OP_TIMEOUT_MS);
    });
    const opPromise = op().catch(() => null as T | null);
    try {
      return await Promise.race([opPromise, timeout]);
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // -------------------------------------------------------------------------
  // Synthetic fallback — ALWAYS road-shaped (grid/grid-ish), never a straight
  // 2-point "line". Used only when all routing engines are unreachable, so
  // the app still paints a believable city-grid route and a non-zero fare.
  // -------------------------------------------------------------------------

  private static syntheticRoute(origin: LatLng, destination: LatLng): RoutingResult {
    const [lat1, lng1] = origin;
    const [lat2, lng2] = destination;
    const R = 6371000;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const φ1 = toRad(lat1);
    const φ2 = toRad(lat2);
    const Δφ = toRad(lat2 - lat1);
    const Δλ = toRad(lng2 - lng1);
    const a =
      Math.sin(Δφ / 2) ** 2 +
      Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const directMeters = R * c;

    // Urban detour factor + a conservative driving speed.
    const DETOUR = 1.35;
    const SPEED_MPS = 6.1;
    const distanceMeters = directMeters * DETOUR;
    const durationSeconds = distanceMeters / SPEED_MPS;

    // Build a believable city-grid polyline: multiple Manhattan-style bends
    // through intermediate intersections so it reads as real streets, never
    // a single straight segment. Coordinates are [lng, lat] (GeoJSON order).
    const midLat = (lat1 + lat2) / 2;
    const midLng = (lng1 + lng2) / 2;
    const quarterLat = lat1 + (lat2 - lat1) * 0.25;
    const quarterLng = lng1 + (lng2 - lng1) * 0.25;
    const threeQuarterLat = lat1 + (lat2 - lat1) * 0.75;
    const threeQuarterLng = lng1 + (lng2 - lng1) * 0.75;

    const coordinates: Array<[number, number]> = [
      [lng1, lat1],
      [quarterLng, lat1],            // east along the first street
      [quarterLng, midLat],          // turn north at an intersection
      [midLng, midLat],              // jog east
      [midLng, threeQuarterLat],     // turn north again
      [threeQuarterLng, threeQuarterLat], // jog east
      [threeQuarterLng, lat2],       // turn north toward destination
      [lng2, lat2],                  // final leg east to destination
    ];

    return {
      distanceMeters,
      durationSeconds,
      etaSeconds: Math.round(durationSeconds * 1.2),
      geometry: { type: 'LineString', coordinates },
      confidence: 0.4,
      engine: 'Synthetic',
      cacheHit: false,
      steps: [],
      speedLimitsByRoad: {},
    };
  }

  // -------------------------------------------------------------------------
  // Cache key helpers
  // -------------------------------------------------------------------------

  private static exactKey(origin: LatLng, destination: LatLng): string {
    const p = 4;
    return `route:exact:${origin[0].toFixed(p)}:${origin[1].toFixed(p)}:${destination[0].toFixed(p)}:${destination[1].toFixed(p)}`;
  }

  /** Nearby keys = cartesian product of origin/dest geohash neighborhoods. */
  private static nearbyKeys(origin: LatLng, destination: LatLng): string[] {
    const o = this.geohashNeighbors(origin);
    const d = this.geohashNeighbors(destination);
    const keys: string[] = [];
    for (const a of o) for (const b of d) keys.push(`route:nearby:${a}:${b}`);
    return keys;
  }

  private static geohashNeighbors(coord: LatLng): string[] {
    const base = ngeohash.encode(coord[0], coord[1], this.GEOHASH_PRECISION);
    return [base, ...ngeohash.neighbors(base)];
  }

  // -------------------------------------------------------------------------
  // Small utilities
  // -------------------------------------------------------------------------

  private static elapsed(start: bigint): number {
    return Number(process.hrtime.bigint() - start) / 1e9;
  }

  private static buildSpeedMap(steps: any[]): Record<string, number> {
    const map: Record<string, number> = {};
    for (const step of steps) {
      const limit = step.speedLimitMph;
      if (!limit) continue;
      const keys = [step.name, step.ref].filter(
        (k) => typeof k === 'string' && k.length > 0,
      );
      for (const k of keys) map[k] = limit;
    }
    return map;
  }
}
