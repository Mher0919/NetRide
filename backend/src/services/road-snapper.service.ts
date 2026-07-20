import axios from 'axios';
import { logger } from '../observability/logger';

const OSRM_NEAREST_BASE = 'https://router.project-osrm.org/nearest/v1/driving';

const SNAP_TIMEOUT_MS = 3000;
const MAX_SNAP_RADIUS_M = 500;

export interface SnappedPoint {
  lat: number;
  lng: number;
  distanceMeters: number;
  snapped: boolean;
}

export class RoadSnapperService {
  static async snap(lat: number, lng: number): Promise<SnappedPoint> {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return { lat, lng, distanceMeters: 0, snapped: false };
    }

    try {
      const url = `${OSRM_NEAREST_BASE}/${lng},${lat}?number=1&radiuses=${MAX_SNAP_RADIUS_M}`;
      const resp = await axios.get(url, { timeout: SNAP_TIMEOUT_MS });

      if (resp.status === 200 && resp.data?.waypoints?.length > 0) {
        const wp = resp.data.waypoints[0];
        const snappedLng = wp.location[0];
        const snappedLat = wp.location[1];
        const distanceMeters = wp.distance;

        if (Number.isFinite(snappedLat) && Number.isFinite(snappedLng)) {
          return {
            lat: snappedLat,
            lng: snappedLng,
            distanceMeters: distanceMeters ?? 0,
            snapped: distanceMeters < MAX_SNAP_RADIUS_M,
          };
        }
      }
    } catch (err: any) {
      logger.warn({ err: err.message, lat, lng }, 'snap_failed');
    }

    return { lat, lng, distanceMeters: 0, snapped: false };
  }

  static async snapIfNeeded(
    lat: number,
    lng: number,
    maxDistanceM = 50,
  ): Promise<SnappedPoint> {
    const result = await this.snap(lat, lng);
    if (result.snapped && result.distanceMeters <= maxDistanceM) {
      return result;
    }
    return { lat, lng, distanceMeters: result.distanceMeters, snapped: false };
  }
}
