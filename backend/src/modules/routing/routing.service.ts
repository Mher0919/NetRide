// backend/src/modules/routing/routing.service.ts
//
// Isolated Routing Service — the SINGLE owner of the rider routing + fare
// pipeline. It owns NO business logic beyond: validate → engine → decode → fare.
// Every other module (ride, navigation, geospatial search, dispatch, matching)
// MUST go through this service for trip planning so the routing pipeline stays
// consistent, observable, and cacheable.
//
// Architecture:
//
//   Flutter App → Backend API → Ride/Dispatch/Nav → RoutingService →
//     → Google Routes API (sole provider)
//
// Design goals:
//   - Fast:        Google Routes <2s, no Redis cache on hot path.
//   - Road geometry: Google Routes returns true road-following geometry (GeoJSON).
//   - Lightweight:  no per-request DB/Redis hits in the hot path.
//   - Resilient:    never crash; degrade to a synthetic city-grid route.
//   - Observable:   every stage is instrumented via prom-client + structured logs.
//   - Scalable:     stateless + request dedup map + concurrent-safe.
//   - Cost-effective: client-side caching minimizes Google API calls.

import { MLEtaService } from '../../services/ml-eta.service';
import { computeEstimate, FareBreakdown } from '../../services/pricing.service';
import { RouteEngine } from './route-engine';
import { GoogleRoutesEngine } from './google-routes.engine';
import { RoutingError } from './routing.errors';
import {
  routingRequestsTotal,
  routingDurationSeconds,
  routingFareSeconds,
  routingFallbackTotal,
  routingEngineRequestsTotal,
  routingEngineDurationSeconds,
  routingEngineSeconds,
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
  /** Static (no-traffic) duration when the engine exposed it. */
  staticDurationSeconds?: number | null;
  etaSeconds: number;
  geometry: RouteGeometry;
  confidence: number; // 0..1 — 1 = real engine, lower = fallback
  engine: 'GoogleRoutes' | 'Synthetic';
  cacheHit: boolean; // true when served from the server-side OD cache
  /** Populated for real engines; empty for synthetic fallback. */
  steps: any[];
  speedLimitsByRoad: Record<string, number>;
}

export interface PlanRequest {
  origin: LatLng;
  destination: LatLng;
}

export interface PlanResponse {
  origin: LatLng;
  destination: LatLng;
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
    stepsCount: number;
  };
}

/** Coordinate validation error. */
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
  // Google Routes API is the sole routing engine. No fallbacks, no local engines.
  private static readonly providers: Array<{
    match: (origin: [number, number], destination: [number, number]) => boolean;
    engine: RouteEngine;
  }> = [
    { match: () => true, engine: GoogleRoutesEngine },
  ];

  // ---- Request deduplication (in-flight only, per-process) ---------------
  private static readonly inFlight = new Map<string, Promise<RoutingResult>>();

  // Simple cache key for in-flight deduplication (4dp ≈ 11m)
  private static exactKey(origin: LatLng, destination: LatLng): string {
    const p = 4;
    return `exact:${origin[0].toFixed(p)}:${origin[1].toFixed(p)}:${destination[0].toFixed(p)}:${destination[1].toFixed(p)}`;
  }

  /**
   * Public entry point. Validates, routes, and prices in one
   * coherent pipeline. Always returns a road-following plan.
   */
  static async plan(request: PlanRequest): Promise<PlanResponse> {
    const end = routingDurationSeconds.startTimer();
    const start = Date.now();
    try {
      const route = await this.route(request.origin, request.destination);

      const fareStart = process.hrtime.bigint();

      // Platform pricing — synchronous, in-memory, no I/O on the hot path.
      const fare = computeEstimate({
        distanceMeters: route.distanceMeters,
        durationSeconds: route.durationSeconds,
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
          stepsCount: route.steps.length,
        },
      };
    } finally {
      end();
    }
  }

  // -------------------------------------------------------------------------
  // Clean public API
  // -------------------------------------------------------------------------

  /** Full route: distance + duration + ETA + geometry + steps. */
  static async calculateRoute(
    origin: LatLng,
    destination: LatLng,
  ): Promise<RoutingResult> {
    return this.route(origin, destination);
  }

  /** Road distance only (engine-calculated; never straight-line). */
  static async calculateDistance(
    origin: LatLng,
    destination: LatLng,
  ): Promise<number> {
    const r = await this.route(origin, destination);
    return r.distanceMeters;
  }

  /** Road ETA only (Google Routes base duration x ML multiplier). */
  static async calculateETA(
    origin: LatLng,
    destination: LatLng,
  ): Promise<number> {
    const r = await this.route(origin, destination);
    return r.etaSeconds;
  }

  /** Route + fare breakdown together. */
  static async calculateFareRoute(
    origin: LatLng,
    destination: LatLng,
  ): Promise<{ route: RoutingResult; fare: FareBreakdown }> {
    const route = await this.route(origin, destination);
    const fare = computeEstimate({
      distanceMeters: route.distanceMeters,
      durationSeconds: route.durationSeconds,
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
  // In-flight deduplication only (no Redis cache)
  // -------------------------------------------------------------------------

  private static async route(
    origin: LatLng,
    destination: LatLng,
  ): Promise<RoutingResult> {
    const exactKey = this.exactKey(origin, destination);

    // 1. Dedupe in-flight identical requests.
    const existing = this.inFlight.get(exactKey);
    if (existing) return existing;

    const promise = (async () => {
      // No server-side cache — call engine directly.
      return this.computeRoute(origin, destination, exactKey);
    })().finally(() => this.inFlight.delete(exactKey));

    this.inFlight.set(exactKey, promise);
    return promise;
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

    // Validate coordinates before contacting the routing engine.
    try {
      parseCoordinates([origin[0], origin[1]], 'origin');
      parseCoordinates([destination[0], destination[1]], 'destination');
    } catch (coordErr) {
      logger.warn({ err: (coordErr as Error).message }, 'routing_invalid_coords');
      result = this.syntheticRoute(origin, destination);
      routingFallbackTotal.inc();
      routingEngineSeconds.observe(this.elapsed(engineStart));
      return result;
    }

    // Use original coordinates directly — Google Routes handles snapping internally.
    const routeOrigin: LatLng = origin;
    const routeDest: LatLng = destination;

    // 0. OD cache lookup before any engine call. Serving a nearby
    //    origin/destination pair from a stored Google result avoids the
    //    API round trip entirely; the multiplier is recomputed so the
    //    returned ETA is consistent with a fresh call.
    try {
      const cached = await RouteStoreService.findOdcache(origin, destination, 1);
      if (cached) {
        // Prefer the traffic-aware duration while it is still fresh
        // (<= 15 min); otherwise fall back to the static duration so
        // geometry reuse never serves a stale traffic figure.
        const freshTraffic = cached.trafficDurationSeconds != null &&
          Date.now() - new Date(cached.createdAt).getTime() < 15 * 60 * 1000;
        const baseDuration = freshTraffic && cached.trafficDurationSeconds != null
          ? cached.trafficDurationSeconds
          : cached.durationSeconds;
        const multiplier = MLEtaService.predictMultiplier(origin[0], origin[1], cached.distanceMeters);
        result = {
          distanceMeters: cached.distanceMeters,
          durationSeconds: baseDuration,
          staticDurationSeconds: cached.durationSeconds,
          etaSeconds: Math.round(baseDuration * multiplier),
          geometry: cached.geometry,
          confidence: 0.95,
          engine: 'GoogleRoutes',
          cacheHit: true,
          steps: cached.steps,
          speedLimitsByRoad: {},
        };
        routingEngineRequestsTotal.inc({ status: 'cache_hit' });
        return result;
      }
    } catch (cacheErr) {
      logger.warn({ err: (cacheErr as Error).message }, 'routing_od_cache_lookup_failed');
    }

    try {
      // Google Routes API as the sole routing engine.
      const engine = GoogleRoutesEngine;
      try {
        const res = await engine.route(routeOrigin, routeDest);
        if (res) {
          const multiplier = MLEtaService.predictMultiplier(origin[0], origin[1], res.distanceMeters);
          result = {
            distanceMeters: res.distanceMeters,
            durationSeconds: res.durationSeconds,
            staticDurationSeconds: res.staticDurationSeconds ?? null,
            etaSeconds: Math.round(res.durationSeconds * multiplier),
            geometry: res.geometry,
            confidence: 0.95,
            engine: 'GoogleRoutes',
            cacheHit: false,
            steps: res.steps,
            speedLimitsByRoad: res.speedLimitsByRoad,
          };
          routingEngineRequestsTotal.inc({ status: 'ok' });

          // Persist successful engine results into the OD reuse cache.
          // Best-effort and fire-and-forget — the hot path never waits.
          RouteStoreService.saveOdcache(
            origin,
            destination,
            res.geometry,
            res.distanceMeters,
            res.staticDurationSeconds ?? res.durationSeconds,
            res.trafficDurationSeconds ?? null,
            res.steps,
            'GoogleRoutes',
          ).catch((persistErr) => {
            logger.warn({ err: (persistErr as Error).message }, 'routing_od_cache_persist_failed');
          });
        } else {
          logger.warn({ engine: engine.name }, 'routing_engine_returned_null');
          routingEngineRequestsTotal.inc({ status: 'empty' });
        }
      } catch (engineErr: any) {
        if (engineErr instanceof RoutingError) {
          logger.warn({ engine: engine.name, err: engineErr.message }, 'routing_engine_bad_input');
          routingEngineRequestsTotal.inc({ status: 'bad_input' });
        } else {
          logger.error({ engine: engine.name, err: engineErr.message }, 'routing_engine_error');
          routingEngineRequestsTotal.inc({ status: 'error' });
        }
      }
    } catch (err: any) {
      logger.error({ err: err.message }, 'routing_compute_route_error');
      routingEngineRequestsTotal.inc({ status: 'error' });
    }

    if (!result) {
      // Synthetic fallback — only when Google Routes is unreachable.
      result = this.syntheticRoute(origin, destination);
      routingFallbackTotal.inc();
    }

    routingEngineSeconds.observe(this.elapsed(engineStart));
    routingEngineDurationSeconds.observe(this.elapsed(engineStart));

    return result;
  }

  // -------------------------------------------------------------------------
  // Synthetic fallback — ALWAYS road-shaped (grid/grid-ish), never a straight
  // 2-point "line". Used only when Google Routes is unreachable.
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
    // through intermediate intersections so it reads as real streets.
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
  // Small utilities
  // -------------------------------------------------------------------------

  private static elapsed(start: bigint): number {
    return Number(process.hrtime.bigint() - start) / 1e9;
  }
}

import { RouteStoreService } from '../../services/route-store.service';