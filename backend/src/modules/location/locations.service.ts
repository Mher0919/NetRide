// backend/src/modules/location/locations.service.ts
//
// Owns the live driver location tracking + per-trip trajectory buffer
// in Redis. Exposes an in-process EventEmitter (`trajectoryEvents`)
// so downstream consumers (the speeding detector, future safety
// modules) can subscribe to the *same* trajectory stream without
// duplicating the Redis read or branching the hot path.

import { EventEmitter } from 'events';
import { redis, DRIVER_LOCATIONS_KEY, DRIVER_HEARTBEAT_PREFIX } from '../../config/redis';
import { Location } from '../../types';
import * as geohash from 'ngeohash';

/**
 * In-process emitter for buffered trajectory points.
 *
 *   const { trajectoryEvents } = require('./locations.service');
 *   trajectoryEvents.on('point', ({ driverId, tripId, point }) => …);
 *
 * The payload matches what `SpeedingDetector.onTrajectoryPoint` expects
 * (lat/lng/speed_mps/t). Speed is optional — mobile clients may not
 * always report it; consumers must handle null/missing values.
 */
export interface TrajectoryPointPayload {
  driverId: string;
  tripId: string;
  point: {
    lat: number;
    lng: number;
    /** meters/second — null when the device didn't report it */
    speed_mps: number | null;
    /** ISO timestamp */
    t: string;
  };
}

export const trajectoryEvents = new EventEmitter();
// Safety detectors can run on long trips; raise the cap so we never
// hit the "MaxListenersExceeded" warning when more than 10 listeners
// attach (current consumers: SpeedingDetector + future ML pipeline).
trajectoryEvents.setMaxListeners(64);

export class LocationsService {
  /**
   * Updates a driver's real-time location in Redis
   * Also sets a heartbeat to track online status and returns the geohash for room management.
   */
  static async updateDriverLocation(driverId: string, loc: Location): Promise<string> {
    const pipeline = redis.pipeline();
    
    // 1. Update Geospatial position
    pipeline.geoadd(DRIVER_LOCATIONS_KEY, loc.lng, loc.lat, driverId);
    
    // 2. Set heartbeat with TTL (90 seconds). This is long enough to
    // survive brief socket disconnects (free-tier spin-down, network
    // blip) without making truly offline drivers invisible to matching.
    pipeline.set(`${DRIVER_HEARTBEAT_PREFIX}${driverId}`, '1', 'EX', 90);
    
    await pipeline.exec();

    // 3. Trajectory Buffering - ONLY if driver is on a trip
    // We use a separate async task to not block the main location update
    this.bufferTrajectory(driverId, loc).catch(err => {
      console.error(`[GEO] ❌ Trajectory buffering failed for driver ${driverId}:`, err.message);
    });

    // 4. Return geohash precision 6 (~1.2km x 0.6km) for socket room management
    return geohash.encode(loc.lat, loc.lng, 6);
  }

  /**
   * Internal helper to buffer trajectory points in Redis.
   *
   * Side effect: emits `point` on `trajectoryEvents` after the
   * throttle/buffer work so the speeding detector (and any future
   * safety module) can subscribe without re-reading the buffer.
   */
  private static async bufferTrajectory(driverId: string, loc: Location) {
    // Check if driver has an active trip (Cached in Redis ideally, but let's use a key for now)
    const tripId = await redis.get(`driver:${driverId}:active_trip`);
    if (!tripId) return;

    // Route-data validation: reject garbage coordinates before they ever
    // reach the trajectory (a bad point would corrupt the polyline, the
    // final snapshot and the admin map). NaN/Infinity or out-of-range
    // lat/lng points are dropped silently.
    const valid =
      isFinite(loc.lat) && isFinite(loc.lng) &&
      loc.lat >= -90 && loc.lat <= 90 &&
      loc.lng >= -180 && loc.lng <= 180;
    if (!valid) return;

    const trajectoryKey = `trip:${tripId}:trajectory`;

    // Throttling: only save if last point was > 5 seconds ago or > 20 meters away
    // For simplicity, let's just do a 5-second throttle using a Redis key
    const throttleKey = `driver:${driverId}:trajectory_throttle`;
    const isThrottled = await redis.get(throttleKey);

    const timestamp = new Date().toISOString();
    const payload: TrajectoryPointPayload['point'] = {
      lat: loc.lat,
      lng: loc.lng,
      speed_mps: typeof (loc as any).speed === 'number' ? (loc as any).speed : null,
      t: timestamp,
    };

    if (!isThrottled) {
      const point = JSON.stringify(payload);

      await redis.pipeline()
        .rpush(trajectoryKey, point)
        .expire(trajectoryKey, 86400) // 24h safety TTL
        .set(throttleKey, '1', 'EX', 5) // 5 seconds throttle
        .exec();

      // Fire-and-forget; the detector swallows its own errors.
      trajectoryEvents.emit('point', {
        driverId,
        tripId,
        point: payload,
      } as TrajectoryPointPayload);
    }
  }

  static async getTrajectory(tripId: string): Promise<any[]> {
    const points = await redis.lrange(`trip:${tripId}:trajectory`, 0, -1);
    return points.map(p => JSON.parse(p));
  }

  static async clearTrajectory(tripId: string): Promise<void> {
    await redis.del(`trip:${tripId}:trajectory`);
  }

  /**
   * Finds nearby online drivers within a radius
   * Filters out drivers whose heartbeats have expired using pipelined MGET.
   */
  static async findNearbyDrivers(loc: Location, radiusKm: number): Promise<{ id: string; distance: number }[]> {
    console.log(`[GEO] Searching nearby drivers. Pickup: lat=${loc.lat}, lng=${loc.lng}, radius=${radiusKm}km`);
    
    const searchRadius = Math.max(radiusKm, 0.1);

    try {
      const results = await redis.georadius(
        DRIVER_LOCATIONS_KEY,
        loc.lng,
        loc.lat,
        searchRadius,
        'km',
        'WITHDIST',
        'ASC'
      );

      if (!results || results.length === 0) return [];

      const ids = (results as any[]).map(([id]: [string, string]) => id);
      const heartbeatKeys = ids.map((id: string) => `${DRIVER_HEARTBEAT_PREFIX}${id}`);
      const heartbeats = await redis.mget(...heartbeatKeys);

      const nearbyDrivers: { id: string; distance: number }[] = [];
      const staleIds: string[] = [];

      (results as any[]).forEach(([id, distance]: [string, string], i: number) => {
        if (heartbeats[i]) {
          nearbyDrivers.push({ id, distance: parseFloat(distance) });
        } else {
          staleIds.push(id);
        }
      });

      if (staleIds.length > 0) {
        console.log(`[GEO] Skipping ${staleIds.length} stale driver(s) (heartbeat expired): ${staleIds.join(', ')}`);
        // Don't remove from Redis here — the driver may reconnect soon.
        // Stale locations will be cleaned up by the cron worker instead.
      }

      return nearbyDrivers;
    } catch (error) {
      console.error(`[GEO] Error in georadius:`, error);
      return [];
    }
  }

  /**
   * Removes a driver from online tracking
   */
  static async removeDriverLocation(driverId: string): Promise<void> {
    await redis.pipeline()
      .zrem(DRIVER_LOCATIONS_KEY, driverId)
      .del(`${DRIVER_HEARTBEAT_PREFIX}${driverId}`)
      .exec();
  }

  static async getDriverLocation(driverId: string): Promise<Location | null> {
    const pos = await redis.geopos(DRIVER_LOCATIONS_KEY, driverId);
    if (pos && pos[0]) {
      return {
        lng: parseFloat(pos[0][0]),
        lat: parseFloat(pos[0][1]),
      };
    }
    return null;
  }
}