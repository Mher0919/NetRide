import axios, { AxiosInstance } from 'axios';
import http from 'http';
import https from 'https';
import { env } from '../../config/env';
import { logger } from '../../observability/logger';
import { RouteEngine, LocalRoute } from './route-engine';
import { RoutingError, RoutingErrors } from './routing.errors';

const ORS_BASE = 'https://api.openrouteservice.org/v2/directions';

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 100 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 100 });

const axiosClient: AxiosInstance = axios.create({
  timeout: env.ORS_TIMEOUT_MS,
  httpAgent,
  httpsAgent,
});

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

function decodeGeometry(geometry: any): { type: 'LineString'; coordinates: Array<[number, number]> } {
  if (geometry && typeof geometry === 'object' && Array.isArray(geometry.coordinates)) {
    return { type: 'LineString', coordinates: geometry.coordinates };
  }
  return { type: 'LineString', coordinates: [] };
}

function normalizeSteps(segments: any[]): any[] {
  const out: any[] = [];
  if (!Array.isArray(segments)) return out;
  for (const segment of segments) {
    const steps = Array.isArray(segment?.steps) ? segment.steps : [];
    for (const step of steps) {
      out.push({
        distance: step.distance,
        duration: step.duration,
        name: step.name ?? '',
        ref: step.ref ?? null,
        mode: step.mode ?? 'driving',
        geometry: step.geometry ?? null,
        maneuver: step.maneuver ?? null,
        intersections: step.intersections ?? [],
        speedLimitMph: null,
      });
    }
  }
  return out;
}

function buildSpeedMap(segments: any[]): Record<string, number> {
  const map: Record<string, number> = {};
  if (!Array.isArray(segments)) return map;
  for (const segment of segments) {
    const steps = Array.isArray(segment?.steps) ? segment.steps : [];
    for (const step of steps) {
      const name = step.name;
      if (!name) continue;
      const avgMs = step.duration > 0 ? step.distance / step.duration : 0;
      map[name] = Math.round(avgMs * 2.237);
    }
  }
  return map;
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
      logger.error('routing_ors_missing_api_key');
      return null;
    }

    // ORS expects coordinates as [longitude, latitude]
    const coordinates = [
      [origin[1], origin[0]],
      [destination[1], destination[0]],
    ];

    const url = `${ORS_BASE}/driving-car/geojson`;

    try {
      const response = await axiosClient.post(url, {
        coordinates,
        instructions: true,
        geometry: true,
        geometry_simplify: false,
        elevation: false,
        extra_info: ['speedlimit'],
      }, {
        headers: {
          Authorization: env.ORS_API_KEY,
          'Content-Type': 'application/json',
          Accept: 'application/json, application/geo+json',
        },
      });

      if (response.status !== 200 || !response.data?.features?.length) {
        logger.warn({ status: response.status }, 'routing_ors_empty');
        return null;
      }

      const feature = response.data.features[0];
      const props = feature.properties;
      const geometry = feature.geometry;

      const distanceMeters = props.summary?.distance ?? 0;
      const durationSeconds = props.summary?.duration ?? 0;

      if (!Number.isFinite(distanceMeters) || !Number.isFinite(durationSeconds)) {
        logger.warn('routing_ors_malformed_distance');
        return null;
      }

      const decodedGeometry = decodeGeometry(geometry);
      const segments = Array.isArray(props.segments) ? props.segments : [];
      const rawSteps = normalizeSteps(segments);
      const speedLimitsByRoad = buildSpeedMap(segments);

      return {
        distanceMeters,
        durationSeconds,
        geometry: decodedGeometry,
        steps: rawSteps,
        speedLimitsByRoad,
      };
    } catch (err: any) {
      if (err instanceof RoutingError) throw err;

      if (err.response) {
        const status = err.response.status;
        if (status === 401 || status === 403) {
          logger.error({ status }, 'routing_ors_auth_error');
          return null;
        }
        if (status === 429) {
          logger.warn({ status }, 'routing_ors_rate_limit');
          return null;
        }
        if (status >= 500) {
          logger.error({ status, msg: err.message }, 'routing_ors_server_error');
          return null;
        }
      }

      logger.error({ msg: err.message }, 'routing_ors_error');
      return null;
    }
  },
};