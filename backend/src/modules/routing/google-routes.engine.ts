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
    staticDuration?: string;
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

export interface GoogleRouteMatrix {
  /** distances[originIndex][destinationIndex] in meters (-1 = no route). */
  distances: number[][];
  /** durations[originIndex][destinationIndex] in seconds (0 = no route). */
  durations: number[][];
}

export interface WaypointRoute {
  distanceMeters: number;
  durationSeconds: number;
  staticDurationSeconds: number;
  geometry: { type: 'LineString'; coordinates: Array<[number, number]> };
  steps: any[];
  legs: Array<{ distanceMeters: number; durationSeconds: number }>;
}

type LatLngTuple = [number, number];

function waypoint(location: LatLngTuple) {
  return { location: { latLng: { latitude: location[0], longitude: location[1] } } };
}

function validLocations(locations: LatLngTuple[]): boolean {
  return locations.length > 0 && locations.every(isValidCoord);
}

/**
 * Google Routes distance matrix (computeRouteMatrix). One API call for the
 * complete N×N cost matrix used by the exhaustive group optimizer.
 */
export async function googleRoutesMatrix(
  origins: LatLngTuple[],
  destinations: LatLngTuple[],
): Promise<GoogleRouteMatrix | null> {
  if (!validLocations(origins) || !validLocations(destinations)) {
    throw new RoutingError(
      RoutingErrors.INVALID_COORDINATES,
      'Invalid coordinates supplied to Google Routes matrix',
    );
  }
  const apiKey = env.GOOGLE_ROUTES_API_KEY || env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    logger.warn('google_routes_matrix_no_api_key');
    return null;
  }
  const client: AxiosInstance = axios.create({ timeout: 8000, httpAgent, httpsAgent });
  try {
    const response = await googleRoutesBreaker.execute(() =>
      client.post(
        'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix',
        {
          origins: origins.map((o) => ({ waypoint: waypoint(o) })),
          destinations: destinations.map((d) => ({ waypoint: waypoint(d) })),
          travelMode: 'DRIVE',
          routingPreference: 'TRAFFIC_AWARE',
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': apiKey,
            'X-Goog-FieldMask': 'originIndex,destinationIndex,duration,distanceMeters,condition,status',
          },
        },
      ),
    );
    const elements = Array.isArray(response.data) ? response.data : [];
    if (elements.length === 0) return null;
    const distances = origins.map(() => destinations.map(() => -1));
    const durations = origins.map(() => destinations.map(() => 0));
    for (const element of elements) {
      const oi = Number(element?.originIndex);
      const di = Number(element?.destinationIndex);
      if (!Number.isInteger(oi) || !Number.isInteger(di)) continue;
      if (oi < 0 || di < 0 || oi >= origins.length || di >= destinations.length) continue;
      const condition = element?.condition;
      const statusOk = !element?.status || element.status.code === undefined || element.status.code === 0;
      if (condition && condition !== 'ROUTE_EXISTS') continue;
      if (!statusOk) continue;
      distances[oi][di] = Number(element?.distanceMeters ?? -1);
      durations[oi][di] = parseDuration(String(element?.duration ?? '')).valueOf();
    }
    return { distances, durations };
  } catch (err: any) {
    if (err instanceof RoutingError) throw err;
    if (err.response) {
      logger.warn({ status: err.response.status, msg: err.message }, 'google_routes_matrix_failed');
    } else {
      logger.warn({ msg: err.message }, 'google_routes_matrix_error');
    }
    return null;
  }
}

/**
 * A single Google route through an ordered list of intermediate stops. Used
 * after the optimizer chooses the authoritative pickup order: this gives one
 * continuous polyline plus per-leg metrics.
 */
export async function googleRoutesWithWaypoints(
  origin: LatLngTuple,
  waypoints: LatLngTuple[],
  destination: LatLngTuple,
): Promise<WaypointRoute | null> {
  if (!isValidCoord(origin) || !isValidCoord(destination) || !validLocations(waypoints)) {
    throw new RoutingError(
      RoutingErrors.INVALID_COORDINATES,
      'Invalid coordinates supplied to Google Routes waypoint route',
    );
  }
  const apiKey = env.GOOGLE_ROUTES_API_KEY || env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return null;

  const client: AxiosInstance = axios.create({ timeout: 10000, httpAgent, httpsAgent });
  try {
    const response = await googleRoutesBreaker.execute(() =>
      client.post<GoogleRoutesResponse>(
        'https://routes.googleapis.com/directions/v2:computeRoutes',
        {
          origin: waypoint(origin),
          destination: waypoint(destination),
          intermediates: waypoints.map((w) => waypoint(w)),
          travelMode: 'DRIVE',
          routingPreference: 'TRAFFIC_AWARE',
          computeAlternativeRoutes: false,
          languageCode: 'en-US',
          units: 'IMPERIAL',
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': apiKey,
            'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.staticDuration,routes.polyline.encodedPolyline,routes.legs.distanceMeters,routes.legs.duration,routes.legs.staticDuration,routes.legs.polyline.encodedPolyline,routes.legs.steps.distanceMeters,routes.legs.steps.staticDuration,routes.legs.steps.navigationInstruction,routes.legs.steps.polyline.encodedPolyline',
          },
        },
      ),
    );
    const apiRoute = response.data?.routes?.[0];
    if (!apiRoute) return null;
    const legs = apiRoute.legs ?? [];
    const distanceMeters = apiRoute.distanceMeters ?? legs.reduce((s, l) => s + (l.distanceMeters ?? 0), 0);
    const durationSeconds = parseDuration(apiRoute.duration ?? legs[0]?.duration ?? '0s');
    const staticDurationSeconds = parseDuration(
      apiRoute.staticDuration ??
        String(legs.reduce((s, l) => s + parseDuration(l.staticDuration ?? '0s'), 0)) + 's',
    );
    const polylineStr = apiRoute.polyline?.encodedPolyline ?? '';
    const coordinates = polylineStr ? decodePolyline(polylineStr) : [];
    const steps: any[] = [];
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
      staticDurationSeconds,
      geometry: { type: 'LineString', coordinates },
      steps,
      legs: legs.map((l) => ({
        distanceMeters: l.distanceMeters ?? 0,
        durationSeconds: parseDuration(l.duration ?? '0s'),
      })),
    };
  } catch (err: any) {
    if (err instanceof RoutingError) throw err;
    logger.warn({ msg: err.message }, 'google_routes_waypoints_failed');
    return null;
  }
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
            'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.staticDuration,routes.polyline.encodedPolyline,routes.legs.distanceMeters,routes.legs.duration,routes.legs.staticDuration,routes.legs.polyline.encodedPolyline,routes.legs.steps.distanceMeters,routes.legs.steps.staticDuration,routes.legs.steps.navigationInstruction,routes.legs.steps.polyline.encodedPolyline',
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

      // Static (no-traffic) duration — the stable value that can be
      // cached for 7 days. Falls back to summing the legs' static
      // durations, then to the traffic-aware duration.
      const staticStr =
        apiRoute.staticDuration ??
        (legs.length > 0 ? legs.map((l) => parseDuration(l.staticDuration ?? '0s')).reduce((a, b) => a + b, 0).toString() + 's' : null);
      const staticDurationSeconds = staticStr != null ? parseDuration(staticStr) : durationSeconds;

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
        staticDurationSeconds,
        trafficDurationSeconds: durationSeconds,
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
