import axios, { AxiosInstance } from 'axios';
import http from 'http';
import https from 'https';
import { env } from '../../config/env';
import { logger } from '../../observability/logger';
import { RouteEngine, LocalRoute } from './route-engine';
import { RoutingError, RoutingErrors } from './routing.errors';
import { googleRoutesBreaker } from '../../utils/circuit-breaker';

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

interface GoogleRoutesResponse {
  routes?: Array<{
    legs?: Array<{
      distanceMeters: number;
      duration: string;
      staticDuration: string;
      durationTraffic?: string;
      polyline?: { encodedPolyline: string };
      steps?: Array<{
        distanceMeters: number;
        staticDuration: string;
        travelMode: string;
        localizedValues?: {
          distance?: { text: string };
          duration?: { text: string };
        };
        navigationInstruction?: {
          maneuver: string;
          instructions: string;
        };
        polyline?: { encodedPolyline: string };
      }>;
    }>;
    polyline?: { encodedPolyline: string };
    localizedValues?: {
      distance?: { text: string };
      duration?: { text: string };
    };
    duration?: string;
    distanceMeters?: number;
  }>;
}

function parseDuration(duration: string): number {
  const match = duration.match(/(\d+(?:\.\d+)?)s/);
  return match ? parseFloat(match[1]) : 0;
}

function decodePolyline(encoded: string): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  let index = 0;
  const len = encoded.length;
  let lat = 0;
  let lng = 0;

  while (index < len) {
    let b: number;
    let shift = 0;
    let result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlat = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
    lat += dlat;

    shift = 0;
    result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlng = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
    lng += dlng;

    points.push([lng / 1e5, lat / 1e5]);
  }

  return points;
}

export const GoogleRoutesEngine: RouteEngine = {
  name: 'GoogleRoutes',

  async route(
    origin: [number, number],
    destination: [number, number],
  ): Promise<LocalRoute | null> {
    if (!isValidCoord(origin) || !isValidCoord(destination)) {
      throw new RoutingError(
        RoutingErrors.INVALID_COORDINATES,
        'Invalid coordinates supplied to Google Routes engine',
      );
    }

    const apiKey = env.GOOGLE_ROUTES_API_KEY || env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      logger.warn('google_routes_engine_no_api_key');
      return null;
    }

    const url = 'https://routes.googleapis.com/directions/v2:computeRoutes';

    const client: AxiosInstance = axios.create({
      timeout: 8000,
      httpAgent,
      httpsAgent,
    });

    try {
      const response = await googleRoutesBreaker.execute(() =>
        client.post<GoogleRoutesResponse>(url, {
          origin: {
            location: {
              latLng: {
                latitude: origin[0],
                longitude: origin[1],
              },
            },
          },
          destination: {
            location: {
              latLng: {
                latitude: destination[0],
                longitude: destination[1],
              },
            },
          },
          travelMode: 'DRIVE',
          routingPreference: 'TRAFFIC_AWARE',
          computeAlternativeRoutes: false,
          routeModifiers: {
            avoidTolls: false,
            avoidHighways: false,
            avoidFerries: false,
          },
          languageCode: 'en-US',
          units: 'IMPERIAL',
        }, {
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': apiKey,
            'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline,routes.legs.distanceMeters,routes.legs.duration,routes.legs.staticDuration,routes.legs.polyline.encodedPolyline,routes.legs.steps.distanceMeters,routes.legs.steps.staticDuration,routes.legs.steps.navigationInstruction,routes.legs.steps.polyline.encodedPolyline',
          },
        })
      );

      if (!response.data?.routes?.length) {
        logger.warn('google_routes_engine_no_routes');
        return null;
      }

      const apiRoute = response.data.routes[0];
      const legs = apiRoute.legs ?? [];

      const distanceMeters = apiRoute.distanceMeters ?? legs.reduce((sum, l) => sum + (l.distanceMeters ?? 0), 0);
      const durationStr = apiRoute.duration ?? legs[0]?.duration ?? '0s';
      const durationSeconds = parseDuration(durationStr);

      const polylineStr = apiRoute.polyline?.encodedPolyline ?? legs[0]?.polyline?.encodedPolyline ?? '';
      const coordinates = polylineStr ? decodePolyline(polylineStr) : [];

      const steps: any[] = [];
      const speedLimitsByRoad: Record<string, number> = {};

      for (const leg of legs) {
        for (const step of leg.steps ?? []) {
          steps.push({
            distanceMeters: step.distanceMeters ?? 0,
            duration: step.staticDuration ?? '0s',
            instruction: step.navigationInstruction?.instructions ?? '',
            maneuver: step.navigationInstruction?.maneuver ?? '',
            polyline: step.polyline?.encodedPolyline ?? '',
          });
        }
      }

      return {
        distanceMeters,
        durationSeconds,
        geometry: {
          type: 'LineString',
          coordinates,
        },
        steps,
        speedLimitsByRoad,
      };
    } catch (err: any) {
      if (err instanceof RoutingError) throw err;

      if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' || err.code === 'ENOTFOUND') {
        logger.warn({ err: err.code }, 'google_routes_engine_unreachable');
        return null;
      }

      if (err.response) {
        const status = err.response.status;
        if (status === 403) {
          logger.error('google_routes_engine_forbidden_check_api_key');
          return null;
        }
        if (status === 429) {
          logger.warn('google_routes_engine_rate_limited');
          return null;
        }
        if (status >= 500) {
          logger.error({ status, msg: err.message }, 'google_routes_engine_server_error');
          return null;
        }
        if (status === 400) {
          logger.error({
            status,
            msg: err.message,
            responseBody: err.response.data,
          }, 'google_routes_engine_bad_request');
          return null;
        }
      }

      logger.error({ msg: err.message }, 'google_routes_engine_error');
      return null;
    }
  },
};
