// backend/src/services/speed-limit.service.ts
//
// Server-side speed-limit lookup for the driver HUD.
//
// Google Routes does not return legal speed limits, so the driver app asks
// this endpoint once a minute while navigating. The lookup is backed by the
// Google Roads API `speedLimits` endpoint (requested in MPH), cached for one
// minute per ~10 m coordinate cell so a 1 Hz HUD never floods Google.
//
// The client keeps its last known limit when this service cannot resolve one
// (no key / Roads API not enabled / transient upstream failure). We never
// invent a value.

import axios from 'axios';
import { env } from '../config/env';
import { redis } from '../config/redis';
import { logger } from '../observability/logger';

export interface SpeedLimitResult {
  speedLimitMph: number | null;
  roadName: string | null;
  source: 'google' | 'unavailable';
}

interface RoadsSpeedLimitResponse {
  speedLimits?: Array<{
    placeId?: string;
    speedLimit?: number;
    units?: string;
  }>;
  snappedPoints?: Array<{ placeId?: string; location?: { latitude: number; longitude: number } }>;
}

const CACHE_TTL_SECONDS = 60;
const ROADS_URL = 'https://roads.googleapis.com/v1/speedLimits';

function apiKey(): string | undefined {
  return env.GOOGLE_ROADS_API_KEY || env.GOOGLE_MAPS_API_KEY || env.GOOGLE_ROUTES_API_KEY;
}

function cacheKey(lat: number, lng: number): string {
  return `speed-limit:${lat.toFixed(4)}:${lng.toFixed(4)}`;
}

function validCoordinate(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

export class SpeedLimitService {
  /**
   * Resolve the legal speed limit at a coordinate. Never throws: returns
   * `{ speedLimitMph: null }` so the driver app can keep its last value.
   */
  static async lookup(lat: number, lng: number): Promise<SpeedLimitResult> {
    if (!validCoordinate(lat, lng)) {
      return { speedLimitMph: null, roadName: null, source: 'unavailable' };
    }

    const key = cacheKey(lat, lng);
    try {
      const cached = await redis.get(key);
      if (cached) {
        const parsed = JSON.parse(cached) as SpeedLimitResult;
        return parsed;
      }
    } catch {
      // Cache unavailable — continue to Google.
    }

    const keyValue = apiKey();
    if (!keyValue) {
      const result: SpeedLimitResult = {
        speedLimitMph: null,
        roadName: null,
        source: 'unavailable',
      };
      await this.cache(key, result);
      return result;
    }

    let result: SpeedLimitResult = {
      speedLimitMph: null,
      roadName: null,
      source: 'unavailable',
    };

    try {
      const response = await axios.get<RoadsSpeedLimitResponse>(ROADS_URL, {
        params: {
          path: `${lat},${lng}`,
          units: 'MPH',
          key: keyValue,
        },
        timeout: 4000,
      });

      const first = response.data?.speedLimits?.[0];
      const mph = Number(first?.speedLimit);
      if (Number.isFinite(mph) && mph > 0) {
        result = {
          speedLimitMph: Math.round(mph),
          roadName: null,
          source: 'google',
        };
      }
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 403 || status === 404 || status === 400) {
        // Roads API not enabled / no speed-limit coverage for this point.
        logger.warn({ status, msg: err?.message }, 'google_speed_limit_unavailable');
      } else {
        logger.warn({ status, msg: err?.message }, 'google_speed_limit_failed');
      }
    }

    await this.cache(key, result);
    return result;
  }

  private static async cache(key: string, value: SpeedLimitResult): Promise<void> {
    try {
      await redis.set(key, JSON.stringify(value), 'EX', CACHE_TTL_SECONDS);
    } catch {
      // Best-effort cache only.
    }
  }
}
