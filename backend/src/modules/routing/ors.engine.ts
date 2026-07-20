// backend/src/modules/routing/ors.engine.ts
//
// OpenRouteService (ORS) Directions API client.
//
// This is the ONLY module that talks to ORS. Every routing request in the
// system flows through RoutingService, which calls this engine — no business
// logic, no controller, no other service imports ORS directly. Swapping to a
// different provider (GraphHopper, Valhalla, Google, Mapbox, a future OSRM
// deployment) means writing a new engine that implements the same
// RouteEngine interface and swapping the single binding in RoutingService.
//
// Design properties (per the routing-redesign brief):
//   - Validates coordinates before contacting ORS (cheap, local).
//   - Reuses a single keep-alive HTTP client (no per-request sockets).
//   - Hard request timeout (ORS_TIMEOUT_MS) so the hot path never stalls.
//   - Retries ONLY on transient failures (timeouts, 429, 5xx, network/DNS).
//     Never retries 4xx (bad request / invalid coordinates).
//   - Exponential backoff between retries.
//   - Requests the compact `polyline` geometry and decodes it once, keeping
//     the wire payload small.
//   - ORS API key stays server-side; never exposed to the Flutter app.
//   - Normalizes the ORS response into the engine-agnostic LocalRoute shape
//     the rest of the pipeline consumes.

import axios, { AxiosInstance, AxiosError } from 'axios';
import http from 'http';
import https from 'https';
import polyline from '@mapbox/polyline';
import { env } from '../../config/env';
import { logger } from '../../observability/logger';
import { enrichSteps } from '../../utils/road-classifier';
import { RoutingErrors, RoutingError } from './routing.errors';

export interface LocalRoute {
  distanceMeters: number;
  durationSeconds: number;
  /** GeoJSON-style LineString coordinates in [lng, lat] order. */
  geometry: { type: 'LineString'; coordinates: Array<[number, number]> };
  steps: any[];
  speedLimitsByRoad: Record<string, number>;
}

/** Provider-agnostic engine contract. New providers implement this. */
export interface RouteEngine {
  readonly name: string;
  route(origin: [number, number], destination: [number, number]): Promise<LocalRoute | null>;
}

// Shared keep-alive agent so we reuse TCP connections to ORS across the
// process lifetime instead of opening a new socket per request.
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 100 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 100 });

const axiosClient: AxiosInstance = axios.create({
  timeout: env.ORS_TIMEOUT_MS,
  httpAgent,
  httpsAgent,
});

/** Coalesce a list of base URLs (ORS_URLS) or fall back to a single ORS_URL. */
function resolveBaseUrls(): string[] {
  if (env.ORS_URLS && env.ORS_URLS.trim().length > 0) {
    return env.ORS_URLS.split(',').map((u) => u.trim()).filter(Boolean);
  }
  return [env.ORS_URL];
}

const BASE_URLS = resolveBaseUrls();

function isValidCoord(c: unknown): c is [number, number] {
  return (
    Array.isArray(c) &&
    c.length === 2 &&
    typeof c[0] === 'number' &&
    Number.isFinite(c[0]) &&
    typeof c[1] === 'number' &&
    Number.isFinite(c[1]) &&
    c[0] >= -90 && c[0] <= 90 &&
    c[1] >= -180 && c[1] <= 180
  );
}

/** True for failures we should retry (transient), false for permanent ones. */
function isRetryable(status: number | undefined, err: AxiosError | Error): boolean {
  // Network / DNS / timeout failures.
  if (!status) return true;
  // 429 rate limit and 5xx server errors are transient.
  if (status === 429 || status >= 500) return true;
  // Everything else (4xx) is a permanent bad request — do NOT retry.
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Decode ORS `polyline` (precision 5) or `polyline6` (precision 6) geometry
 * to GeoJSON [lng, lat] coordinates. Falls back to parsing a GeoJSON
 * geometry if the encoded form is absent.
 */
function decodeGeometry(raw: any): { type: 'LineString'; coordinates: Array<[number, number]> } {
  if (typeof raw === 'string' && raw.length > 0) {
    try {
      // @mapbox/polyline.decode yields [lat, lng]; flip to [lng, lat].
      const rawCoords: Array<[number, number]> = polyline.decode(raw);
      const decoded: Array<[number, number]> = rawCoords.map(
        ([lat, lng]) => [lng, lat],
      );
      if (decoded.length > 0) return { type: 'LineString', coordinates: decoded };
    } catch {
      logger.warn({ len: raw.length }, 'routing_ors_polyline_decode_failed');
    }
  }
  if (raw && typeof raw === 'object' && Array.isArray((raw as any).coordinates)) {
    return raw as { type: 'LineString'; coordinates: Array<[number, number]> };
  }
  return { type: 'LineString', coordinates: [] };
}

/** Map an ORS segment/step into the shape enrichSteps expects (name/ref/...). */
function normalizeSteps(segments: any[]): any[] {
  const out: any[] = [];
  if (!Array.isArray(segments)) return out;
  for (const seg of segments) {
    const steps = Array.isArray(seg?.steps) ? seg.steps : [];
    for (const step of steps) {
      out.push({
        ...step,
        // ORS has no `ref` on steps by default; keep it null so the road
        // classifier falls back to name-based heuristics.
        ref: step.ref ?? null,
        name: step.name ?? null,
        // ORS does not populate speed_limit; mark so classifier uses the
        // road-class default.
        speed_limit: step.speed_limit ?? null,
        // ORS lane/indication data lives in `step.instruction` + `step.type`;
        // `intersections` is not provided, so lane guidance stays empty.
        intersections: step.intersections ?? [],
        distance: step.distance,
        duration: step.duration,
        maneuver: step.maneuver ?? null,
      });
    }
  }
  return out;
}

export const ORSEngine: RouteEngine = {
  name: 'ORS',

  async route(
    origin: [number, number],
    destination: [number, number],
  ): Promise<LocalRoute | null> {
    if (!isValidCoord(origin) || !isValidCoord(destination)) {
      throw new RoutingError(
        RoutingErrors.INVALID_COORDINATES,
        'Invalid coordinates supplied to routing engine',
      );
    }
    if (!env.ORS_API_KEY) {
      // Misconfiguration, not a transient error — surface loudly.
      logger.error('routing_ors_missing_api_key');
      return null;
    }

    // ORS expects [lng, lat] coordinate pairs.
    const body = {
      coordinates: [
        [origin[1], origin[0]],
        [destination[1], destination[0]],
      ],
      profile: env.ORS_PROFILE,
      format: 'json',
      geometry_format: 'polyline',
      instructions: true,
      elevation: false,
    };

    const headers = {
      Authorization: env.ORS_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    let lastErr: AxiosError | Error | null = null;
    for (let attempt = 0; attempt <= env.ORS_MAX_RETRIES; attempt++) {
      // Rotate through base URLs for simple failover.
      const baseUrl = BASE_URLS[attempt % BASE_URLS.length];
      try {
        const response = await axiosClient.post(baseUrl, body, { headers });

        if (response.status !== 200 || !response.data?.routes?.length) {
          logger.warn({ status: response.status }, 'routing_ors_empty');
          // Permanent-ish: empty result. Skip retry loop, return null.
          return null;
        }

        const route = response.data.routes[0];
        const distanceMeters = route.summary?.distance ?? route.distance;
        const durationSeconds = route.summary?.duration ?? route.duration;
        if (!Number.isFinite(distanceMeters) || !Number.isFinite(durationSeconds)) {
          logger.warn('routing_ors_malformed_distance');
          return null;
        }

        const geometry = decodeGeometry(route.geometry);
        const rawSteps = normalizeSteps(route.segments);
        const steps = enrichSteps(rawSteps);
        const speedLimitsByRoad = buildSpeedMap(steps);

        return {
          distanceMeters,
          durationSeconds,
          geometry,
          steps,
          speedLimitsByRoad,
        };
      } catch (err: any) {
        const axiosErr = err as AxiosError;
        const status = axiosErr.response?.status;
        lastErr = axiosErr;

        // Map ORS 400/404 (bad input) to a clear error without retrying.
        if (status === 400 || status === 404) {
          logger.warn({ status, msg: axiosErr.message }, 'routing_ors_bad_request');
          throw new RoutingError(
            RoutingErrors.INVALID_COORDINATES,
            'ORS rejected the request (invalid coordinates or unsupported location)',
          );
        }

        if (!isRetryable(status, axiosErr)) {
          logger.error({ status, msg: axiosErr.message }, 'routing_ors_permanent_error');
          return null;
        }

        if (attempt < env.ORS_MAX_RETRIES) {
          const backoff = Math.min(2000, 250 * 2 ** attempt);
          logger.warn(
            { attempt: attempt + 1, status, msg: axiosErr.message },
            'routing_ors_retryable',
          );
          await sleep(backoff);
        }
      }
    }

    logger.error(
      { msg: lastErr?.message, retries: env.ORS_MAX_RETRIES },
      'routing_ors_exhausted',
    );
    return null;
  },
};

function buildSpeedMap(steps: any[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const step of steps) {
    const limit = step.speedLimitMph;
    if (!limit) continue;
    const keys = [step.name, step.ref].filter(
      (k: unknown) => typeof k === 'string' && k.length > 0,
    );
    for (const k of keys) map[k] = limit;
  }
  return map;
}
