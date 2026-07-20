// backend/src/modules/routing/routing.service.ts
//
// Isolated Routing Service — the single owner of the rider routing + fare
// pipeline. It owns NO business logic beyond: validate → cache → engine →
// decode → fare. Every other module (ride, navigation, geospatial search)
// must go through this service for trip planning so the routing pipeline
// stays consistent, observable, and cacheable.
//
// Design goals (per the routing-redesign brief):
//   - Fast:        cache-first, OSRM in <250ms, fare in microseconds.
//   - Road geometry: OSRM/Geoapify return true road-following geometry.
//   - Lightweight:  no per-request DB hits in the hot path.
//   - Resilient:    never crash; degrade to a road-shaped synthetic route.
//   - Observable:   every stage is instrumented via prom-client.
//   - Scalable:     stateless + Redis cache + request dedup map.

import axios, { AxiosInstance } from 'axios';
import http from 'http';
import pThrottle from 'p-throttle';
import ngeohash from 'ngeohash';
import { env } from '../../config/env';
import { redis } from '../../config/redis';
import { MLEtaService } from '../../services/ml-eta.service';
import { enrichSteps } from '../../utils/road-classifier';
import { fareService, FareBreakdown } from '../../services/fare.service';
import { VehicleClass } from '../../types';
import { LocalOsrmEngine } from './local-osrm.engine';
import {
  routingRequestsTotal,
  routingDurationSeconds,
  routingCacheLookupSeconds,
  routingEngineSeconds,
  routingFareSeconds,
  routingFallbackTotal,
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
  engine: 'OSRM' | 'OSRM-Remote' | 'Synthetic';
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

export function parseCoordinates(
  raw: unknown,
  label: string,
): LatLng {
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
  // ---- Request deduplication (collision-free in-flight map) ---------------
  // Two identical OD requests in flight share one engine call + one cache
  // write. Keyed by the snapped cache key so "nearby" repeats also dedupe.
  private static readonly inFlight = new Map<string, Promise<RoutingResult>>();

  // ---- Engine readiness guard ---------------------------------------------
  private static osrmOnline = false;

  // ---- Engine throttle (protect the shared OSRM cluster) -----------------
  private static readonly throttler = pThrottle({ limit: 80, interval: 1000 });

  private static readonly httpAgent = new http.Agent({
    keepAlive: true,
    maxSockets: 100,
  });

  private static readonly axiosClient: AxiosInstance = axios.create({
    httpAgent: RoutingService.httpAgent,
    timeout: 2000,
  });

  private static readonly throttledGet = RoutingService.throttler(
    (url: string) => RoutingService.axiosClient.get(url),
  );

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
    try {
      const route = await this.routeCached(request.origin, request.destination);

      const fareStart = process.hrtime.bigint();
      const fare = fareService.computeFare({
        distanceMeters: route.distanceMeters,
        durationSeconds: route.durationSeconds,
        vehicleClass: request.vehicleClass,
      });
      routingFareSeconds.observe(Number(process.hrtime.bigint() - fareStart) / 1e9);

      routingRequestsTotal.inc({ cache: route.cacheHit ? 'hit' : 'miss', engine: route.engine.toLowerCase() });

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

    // Engine preference order (per the routing-redesign brief):
    //   1. OSRM (embedded, in-process) — the PRIMARY engine. Sub-50ms,
    //      Google-level road geometry, no network hop, no second service.
    //   2. OSRM (remote) — only if OSRM_URL is configured AND the embedded
    //      engine is unavailable (e.g. the .osrm wasn't baked yet).
    //   3. Synthetic — a road-shaped fallback used only if both OSRM paths
    //      are unreachable, so the app NEVER shows a straight line or $0.
    // Geoapify has been removed entirely from the routing hot path.
    try {
      result = await this.fetchOsrmEmbedded(origin, destination);
    } catch (osrmErr: any) {
      logger.warn({ err: osrmErr.message }, 'routing_osrm_embedded_error');
    }

    if (!result && env.OSRM_URL) {
      try {
        result = await this.fetchOsrmRemote(origin, destination);
      } catch (osrmErr: any) {
        if (this.osrmOnline) {
          logger.error({ err: osrmErr.message }, 'routing_osrm_remote_error');
          this.osrmOnline = false;
        }
      }
    }

    if (!result) {
      // Fell through both engines — synthesize a road-shaped route.
      result = this.syntheticRoute(origin, destination);
      routingFallbackTotal.inc();
    }

    routingEngineSeconds.observe(this.elapsed(engineStart));

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

    return result;
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

  /** PRIMARY: in-process OSRM over the baked SoCal road network. */
  private static async fetchOsrmEmbedded(origin: LatLng, destination: LatLng): Promise<RoutingResult | null> {
    const res = await LocalOsrmEngine.route(origin, destination);
    if (!res) return null;

    const multiplier = MLEtaService.predictMultiplier(origin[0], origin[1], res.distanceMeters);
    return {
      distanceMeters: res.distanceMeters,
      durationSeconds: res.durationSeconds,
      etaSeconds: Math.round(res.durationSeconds * multiplier),
      geometry: res.geometry,
      confidence: 0.99,
      engine: 'OSRM',
      cacheHit: false,
      steps: res.steps,
      speedLimitsByRoad: res.speedLimitsByRoad,
    };
  }

  /** SECONDARY: remote OSRM instance (OSRM_URL) when embedded is unavailable. */
  private static async fetchOsrmRemote(origin: LatLng, destination: LatLng): Promise<RoutingResult | null> {
    const url =
      `${env.OSRM_URL}/${origin[1]},${origin[0]};${destination[1]},${destination[0]}` +
      `?overview=full&geometries=geojson&steps=true&annotations=true`;
    const response = await this.throttledGet(url);
    if (response.status !== 200 || !response.data?.routes?.length) return null;

    this.osrmOnline = true;
    const route = response.data.routes[0];
    const distanceMeters = route.distance;
    const osrmDuration = route.duration;
    const multiplier = MLEtaService.predictMultiplier(origin[0], origin[1], distanceMeters);
    const rawSteps = route.legs?.[0]?.steps ?? [];
    const steps = enrichSteps(rawSteps);
    const speedLimitsByRoad = this.buildSpeedMap(steps);

    return {
      distanceMeters,
      durationSeconds: osrmDuration,
      etaSeconds: Math.round(osrmDuration * multiplier),
      geometry: route.geometry,
      confidence: 0.99,
      engine: 'OSRM-Remote',
      cacheHit: false,
      steps,
      speedLimitsByRoad,
    };
  }

  // -------------------------------------------------------------------------
  // Synthetic fallback — ALWAYS road-shaped (grid/grid-ish), never a straight
  // 2-point "line". Used only when BOTH OSRM engines are unreachable, so the
  // app still paints a believable city-grid route and a non-zero fare.
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
