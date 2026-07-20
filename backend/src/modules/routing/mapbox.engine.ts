import axios, { AxiosInstance } from 'axios';
import http from 'http';
import https from 'https';
import polyline from '@mapbox/polyline';
import { env } from '../../config/env';
import { logger } from '../../observability/logger';
import { RouteEngine, LocalRoute } from './route-engine';
import { RoutingError, RoutingErrors } from './routing.errors';

const MAPBOX_BASE = 'https://api.mapbox.com/directions/v5/mapbox';

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 100 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 100 });

const axiosClient: AxiosInstance = axios.create({
  timeout: env.MAPBOX_TIMEOUT_MS,
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
  if (typeof geometry === 'string' && geometry.length > 0) {
    const rawCoords: Array<[number, number]> = polyline.decode(geometry, 6);
    const decoded: Array<[number, number]> = rawCoords.map(
      ([lat, lng]) => [lng, lat],
    );
    if (decoded.length > 0) return { type: 'LineString', coordinates: decoded };
  }
  if (geometry && typeof geometry === 'object' && Array.isArray((geometry as any).coordinates)) {
    return { type: 'LineString', coordinates: (geometry as any).coordinates };
  }
  return { type: 'LineString', coordinates: [] };
}

function normalizeSteps(legs: any[]): any[] {
  const out: any[] = [];
  if (!Array.isArray(legs)) return out;
  for (const leg of legs) {
    const steps = Array.isArray(leg?.steps) ? leg.steps : [];
    for (const step of steps) {
      out.push({
        ...step,
        ref: step.ref ?? null,
        name: step.name ?? null,
        speed_limit: null,
        intersections: step.intersections ?? [],
        distance: step.distance,
        duration: step.duration,
        maneuver: step.maneuver ?? null,
      });
    }
  }
  return out;
}

function buildSpeedMap(legs: any[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const leg of legs) {
    const annotation = leg?.annotation;
    if (!annotation?.speed) continue;
    const steps = Array.isArray(leg?.steps) ? leg.steps : [];
    let stepIdx = 0;
    for (const step of steps) {
      const name = step.name;
      if (name && annotation.speed[stepIdx] != null) {
        const speedMs = annotation.speed[stepIdx];
        const speedMph = Math.round(speedMs * 2.237);
        map[name] = speedMph;
      }
      stepIdx++;
    }
  }
  return map;
}

export const MapboxEngine: RouteEngine = {
  name: 'Mapbox',

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

    if (!env.MAPBOX_ACCESS_TOKEN) {
      logger.error('routing_mapbox_missing_token');
      return null;
    }

    const coordinates = `${origin[1]},${origin[0]};${destination[1]},${destination[0]}`;
    const url = `${MAPBOX_BASE}/${env.MAPBOX_PROFILE}/${coordinates}`;

    try {
      const response = await axiosClient.get(url, {
        params: {
          access_token: env.MAPBOX_ACCESS_TOKEN,
          geometries: 'polyline6',
          overview: 'full',
          steps: true,
          annotations: 'duration,distance,speed',
          language: 'en',
          continue_straight: true,
        },
      });

      if (response.status !== 200 || !response.data?.routes?.length) {
        logger.warn({ status: response.status }, 'routing_mapbox_empty');
        return null;
      }

      const route = response.data.routes[0];
      const distanceMeters = route.distance;
      const durationSeconds = route.duration;

      if (!Number.isFinite(distanceMeters) || !Number.isFinite(durationSeconds)) {
        logger.warn('routing_mapbox_malformed_distance');
        return null;
      }

      const geometry = decodeGeometry(route.geometry);
      const legs = Array.isArray(route.legs) ? route.legs : [];
      const rawSteps = normalizeSteps(legs);
      const speedLimitsByRoad = buildSpeedMap(legs);

      return {
        distanceMeters,
        durationSeconds,
        geometry,
        steps: rawSteps,
        speedLimitsByRoad,
      };
    } catch (err: any) {
      if (err instanceof RoutingError) throw err;

      if (err.response) {
        const status = err.response.status;
        if (status === 401 || status === 403) {
          logger.error({ status }, 'routing_mapbox_auth_error');
          return null;
        }
        if (status === 429) {
          logger.warn({ status }, 'routing_mapbox_rate_limit');
          return null;
        }
        if (status >= 500) {
          logger.error({ status, msg: err.message }, 'routing_mapbox_server_error');
          return null;
        }
      }

      logger.error({ msg: err.message }, 'routing_mapbox_error');
      return null;
    }
  },
};
