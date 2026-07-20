import axios, { AxiosInstance } from 'axios';
import http from 'http';
import https from 'https';
import { env } from '../../config/env';
import { logger } from '../../observability/logger';
import { RouteEngine, LocalRoute } from './route-engine';
import { RoutingError, RoutingErrors } from './routing.errors';

const MIN_VALID_COORDS = 2;

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 100 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 100 });

function client(baseURL: string, timeoutMs: number): AxiosInstance {
  return axios.create({
    baseURL,
    timeout: timeoutMs,
    httpAgent,
    httpsAgent,
  });
}

function isValidCoord(c: unknown): c is [number, number] {
  return (
    Array.isArray(c) &&
    c.length === MIN_VALID_COORDS &&
    typeof c[0] === 'number' &&
    Number.isFinite(c[0]) &&
    typeof c[1] === 'number' &&
    Number.isFinite(c[1]) &&
    c[0] >= -90 && c[0] <= 90 &&
    c[1] >= -180 && c[1] <= 180
  );
}

function buildSpeedMap(
  legs: Array<{ steps: any[]; annotation?: { speed?: number[] } }>,
): Record<string, number> {
  const map: Record<string, number> = {};
  if (!Array.isArray(legs)) return map;
  for (const leg of legs) {
    const steps = Array.isArray(leg?.steps) ? leg.steps : [];
    const annot = leg?.annotation;
    const speeds = Array.isArray(annot?.speed) ? annot.speed : [];
    if (speeds.length === 0) {
      for (const step of steps) {
        const name = step.name ?? '';
        if (!name) continue;
        const avgMs = step.duration > 0 ? step.distance / step.duration : 0;
        map[name] = Math.round(avgMs * 2.237);
      }
      continue;
    }
    let segIdx = 0;
    for (const step of steps) {
      const name = step.name ?? '';
      if (!name) continue;
      const stepSegments = step.annotation?.nodes?.length
        ? step.annotation.nodes.length - 1
        : Math.max(1, Math.round(speeds.length / steps.length));
      let sum = 0;
      let count = 0;
      for (let i = 0; i < stepSegments && segIdx < speeds.length; i++, segIdx++) {
        sum += speeds[segIdx];
        count++;
      }
      if (count > 0) {
        map[name] = Math.round((sum / count) * 2.237);
      }
    }
  }
  return map;
}

function normalizeSteps(legs: any[]): any[] {
  const out: any[] = [];
  if (!Array.isArray(legs)) return out;
  for (const leg of legs) {
    const steps = Array.isArray(leg?.steps) ? leg.steps : [];
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

export const OSRMEngine: RouteEngine = {
  name: 'OSRM',

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

    const baseURL = env.OSRM_BASE_URL;
    const ax = client(baseURL!, env.OSRM_TIMEOUT_MS);

    const coords = `${origin[1]},${origin[0]};${destination[1]},${destination[0]}`;
    const url = `/route/v1/driving/${coords}`;

    try {
      const response = await ax.get(url, {
        params: {
          alternatives: false,
          steps: true,
          geometries: 'geojson',
          overview: 'full',
          annotations: 'true',
        },
      });

      if (response.status !== 200 || !response.data?.routes?.length) {
        logger.warn({ status: response.status }, 'routing_osrm_empty');
        return null;
      }

      if (response.data.code !== 'Ok') {
        logger.warn({ code: response.data.code, message: response.data.message }, 'routing_osrm_error_code');
        return null;
      }

      const route = response.data.routes[0];
      const distanceMeters = route.distance;
      const durationSeconds = route.duration;

      if (!Number.isFinite(distanceMeters) || !Number.isFinite(durationSeconds)) {
        logger.warn('routing_osrm_malformed');
        return null;
      }

      const geometry = route.geometry as { type: 'LineString'; coordinates: Array<[number, number]> };
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

      if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET') {
        logger.error('routing_osrm_unavailable');
        return null;
      }

      if (err.response) {
        const status = err.response.status;
        if (status >= 500) {
          logger.error({ status }, 'routing_osrm_server_error');
          return null;
        }
      }

      logger.error({ msg: err.message, code: err.code }, 'routing_osrm_error');
      return null;
    }
  },
};
