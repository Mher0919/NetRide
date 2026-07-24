import axios, { AxiosInstance } from 'axios';
import http from 'http';
import https from 'https';
import polyline from '@mapbox/polyline';
import { env } from '../../config/env';
import { logger } from '../../observability/logger';
import { RouteEngine, LocalRoute } from './route-engine';
import { RoutingError, RoutingErrors } from './routing.errors';
import { osrmBreaker } from '../../utils/circuit-breaker';

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });

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

function decodeGeometry(encoded: string): { type: 'LineString'; coordinates: Array<[number, number]> } {
  if (!encoded || encoded.length === 0) {
    return { type: 'LineString', coordinates: [] };
  }
  const decoded = polyline.decode(encoded, 6);
  const coordinates: Array<[number, number]> = decoded.map(([lat, lng]) => [lng, lat]);
  return { type: 'LineString', coordinates };
}

export const OSEngine: RouteEngine = {
  name: 'OSRM',

  async route(
    origin: [number, number],
    destination: [number, number],
  ): Promise<LocalRoute | null> {
    if (!isValidCoord(origin) || !isValidCoord(destination)) {
      throw new RoutingError(
        RoutingErrors.INVALID_COORDINATES,
        'Invalid coordinates supplied to OSRM engine',
      );
    }

    const baseUrl = env.OSRM_BASE_URL;
    if (!baseUrl) {
      logger.warn('osrm_engine_no_base_url');
      return null;
    }

    // OSRM expects lng,lat
    const coords = `${origin[1]},${origin[0]};${destination[1]},${destination[0]}`;
    const url = `${baseUrl}/route/v1/driving/${coords}`;

    const client: AxiosInstance = axios.create({
      timeout: env.OSRM_TIMEOUT_MS ?? 5000,
      httpAgent,
      httpsAgent,
    });

    try {
      const response = await osrmBreaker.execute(() =>
        client.get(url, {
          params: {
            overview: 'full',
            geometries: 'polyline6',
            steps: 'true',
            annotations: 'true',
          },
        })
      );

      if (response.status !== 200 || !response.data?.routes?.length) {
        logger.warn({ status: response.status }, 'osrm_engine_empty');
        return null;
      }

      const route = response.data.routes[0];
      const distanceMeters = route.distance ?? 0;
      const durationSeconds = route.duration ?? 0;

      if (!Number.isFinite(distanceMeters) || !Number.isFinite(durationSeconds)) {
        logger.warn('osrm_engine_malformed_distance');
        return null;
      }

      const geometry = decodeGeometry(route.geometry);

      // Extract steps from legs
      const steps: any[] = [];
      const speedLimitsByRoad: Record<string, number> = {};
      const legs = Array.isArray(route.legs) ? route.legs : [];

      for (const leg of legs) {
        const legSteps = Array.isArray(leg.steps) ? leg.steps : [];
        for (const step of legSteps) {
          steps.push({
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

          if (step.name && step.distance > 0 && step.duration > 0) {
            const avgMs = step.distance / step.duration;
            speedLimitsByRoad[step.name] = Math.round(avgMs * 2.237);
          }
        }
      }

      return {
        distanceMeters,
        durationSeconds,
        geometry,
        steps,
        speedLimitsByRoad,
      };
    } catch (err: any) {
      if (err instanceof RoutingError) throw err;

      if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' || err.code === 'ENOTFOUND') {
        logger.warn({ err: err.code }, 'osrm_engine_unreachable');
        return null;
      }

      if (err.response) {
        const status = err.response.status;
        if (status >= 500) {
          logger.error({ status, msg: err.message }, 'osrm_engine_server_error');
          return null;
        }
      }

      logger.error({ msg: err.message }, 'osrm_engine_error');
      return null;
    }
  },
};
