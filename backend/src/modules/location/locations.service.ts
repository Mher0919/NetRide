// backend/src/modules/location/locations.service.ts
//
// Owns the live driver location tracking + per-trip trajectory buffer
// in Redis. Exposes an in-process EventEmitter (`trajectoryEvents`)
// so downstream consumers (the speeding detector, future safety
// modules) can subscribe to the *same* trajectory stream without
// duplicating the Redis read or branching the hot path.

import { EventEmitter } from 'events';
import { latLngToCell, gridDisk } from 'h3-js';
import { redis, DRIVER_LOCATIONS_KEY, DRIVER_HEARTBEAT_PREFIX, DRIVER_H3_CELL_PREFIX, DRIVER_H3_INDEX_PREFIX } from '../../config/redis';
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

// H3 resolution for the driver-cell index. Res 6 hexagons have an average
// edge length of ~3.7 km — a good balance between index size and the number
// of cells we must touch for the 10/15/20 km dispatch rings.
const H3_MATCHING_RESOLUTION = 6;
// Average H3 hexagon edge length in km at res 6 (≈3.72 km). Used to convert a
// search radius into a gridDisk ring count.
const H3_EDGE_KM = 3.72;

/**
 * Atomically moves a driver between H3 cell sets. Reads the driver's current
 * cell, removes them from that cell's set if it changed, adds them to the new
 * cell's set, and stores the new cell mapping — all in one Lua script so two
 * concurrent location updates can never leak a stale membership.
 */
const MOVE_DRIVER_CELL_LUA = `
  local cellKey = KEYS[1]
  local cellPrefix = KEYS[2]
  local driverId = ARGV[1]
  local cell = ARGV[2]
  local prevCell = redis.call('GET', cellKey)
  if prevCell and prevCell ~= cell then
    redis.call('SREM', cellPrefix .. prevCell, driverId)
  end
  redis.call('SADD', cellPrefix .. cell, driverId)
  redis.call('SET', cellKey, cell)
  return 1
`;

/**
 * Converts a search radius (km) into a gridDisk ring count so the ring fully
 * covers the radius (plus a safety margin of one extra ring).
 */
function radiusToGridDiskRings(radiusKm: number): number {
  // Center-to-center distance between adjacent res-6 hexagons ≈ edge * sqrt(3).
  const stepKm = H3_EDGE_KM * Math.sqrt(3);
  return Math.max(1, Math.ceil(radiusKm / stepKm) + 1);
}

/** Great-circle distance in km between two coordinates. */
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.sqrt(a));
}

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

    // 3. Maintain the H3 hexagonal cell index. Each online driver lives in
    // the set of their current cell; matching only queries the small ring of
    // cells around the pickup instead of scanning the global GEO set. The
    // move between cell sets is atomic (Lua) so concurrent updates never leak
    // stale memberships.
    const cell = latLngToCell(loc.lat, loc.lng, H3_MATCHING_RESOLUTION);
    pipeline.eval(
      MOVE_DRIVER_CELL_LUA,
      2,
      `${DRIVER_H3_CELL_PREFIX}${driverId}`,
      DRIVER_H3_INDEX_PREFIX,
      driverId,
      cell,
    );

    await pipeline.exec();

    // 4. Trajectory Buffering - ONLY if driver is on a trip
    // We use a separate async task to not block the main location update
    this.bufferTrajectory(driverId, loc).catch(err => {
      console.error(`[GEO] ❌ Trajectory buffering failed for driver ${driverId}:`, err.message);
    });

    // 5. Return geohash precision 6 (~1.2km x 0.6km) for socket room management
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
   * Finds nearby online drivers within a radius using the H3 hexagonal index.
   *
   * Instead of scanning the global GEO set (O(all online drivers) in the worst
   * case), it computes the rider's H3 cell, expands to a small disk of cells
   * that fully covers the radius, and unions only those cell sets — the query
   * cost scales with the number of cells in the ring, not the total fleet.
   * Filters out drivers whose heartbeats have expired using pipelined MGET.
   */
  static async findNearbyDrivers(loc: Location, radiusKm: number): Promise<{ id: string; distance: number }[]> {
    console.log(`[GEO] Searching nearby drivers. Pickup: lat=${loc.lat}, lng=${loc.lng}, radius=${radiusKm}km`);
    
    const searchRadius = Math.max(radiusKm, 0.1);

    try {
      // 1. Hexagonal candidate discovery — union the cell sets in the ring.
      const centerCell = latLngToCell(loc.lat, loc.lng, H3_MATCHING_RESOLUTION);
      const rings = radiusToGridDiskRings(searchRadius);
      const cells = gridDisk(centerCell, rings);
      const cellKeys = cells.map(c => `${DRIVER_H3_INDEX_PREFIX}${c}`);

      let candidates: string[] = await redis.sunion(...cellKeys);

      // Fallback: if the H3 index is empty (e.g. cold start / rollout before
      // the index is backfilled) fall back to the classic GEO scan so a live
      // rider request is never starved.
      if (!candidates || candidates.length === 0) {
        return this._georadiusFallback(loc, searchRadius);
      }

      candidates = [...new Set(candidates)];

      // 2. Exact straight-line distance to the pickup for each candidate.
      // Fetch each candidate's position from the GEO set (pipeline) and
      // compute haversine distance. Candidates still present in the cell set
      // but gone from the GEO set (stale index entry) return null and are
      // skipped.
      const distPipe = redis.pipeline();
      for (const id of candidates) {
        distPipe.geopos(DRIVER_LOCATIONS_KEY, id);
      }
      const posResults = (await distPipe.exec()) || [];

      const inRadius: { id: string; distance: number }[] = [];
      candidates.forEach((id, i) => {
        const res = posResults[i];
        const pos = res && !res[0] ? (res[1] as any) : null;
        if (!pos || !pos[0]) return;
        const [lng, lat] = [Number(pos[0][0]), Number(pos[0][1])];
        const distance = haversineKm(loc.lat, loc.lng, lat, lng);
        if (distance <= searchRadius) {
          inRadius.push({ id, distance });
        }
      });

      if (inRadius.length === 0) return [];

      // 3. Heartbeat freshness filter (same as before).
      const ids = inRadius.map((d) => d.id);
      const heartbeatKeys = ids.map((id: string) => `${DRIVER_HEARTBEAT_PREFIX}${id}`);
      const heartbeats = await redis.mget(...heartbeatKeys);

      const nearbyDrivers: { id: string; distance: number }[] = [];
      const staleIds: string[] = [];

      inRadius.forEach((d, i) => {
        if (heartbeats[i]) {
          nearbyDrivers.push(d);
        } else {
          staleIds.push(d.id);
        }
      });

      if (staleIds.length > 0) {
        console.log(`[GEO] Skipping ${staleIds.length} stale driver(s) (heartbeat expired): ${staleIds.join(', ')}`);
        // Don't remove from Redis here — the driver may reconnect soon.
        // Stale locations will be cleaned up by the cron worker instead.
      }

      return nearbyDrivers.sort((a, b) => a.distance - b.distance);
    } catch (error) {
      console.error(`[GEO] Error in hexagonal search:`, error);
      return [];
    }
  }

  /**
   * Classic GEORADIUS scan, kept as a fallback when the H3 index has no data.
   */
  private static async _georadiusFallback(loc: Location, radiusKm: number): Promise<{ id: string; distance: number }[]> {
    try {
      const results = await redis.georadius(
        DRIVER_LOCATIONS_KEY,
        loc.lng,
        loc.lat,
        radiusKm,
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
      }

      return nearbyDrivers;
    } catch (error) {
      console.error(`[GEO] Error in georadius fallback:`, error);
      return [];
    }
  }

  /**
   * Removes a driver from online tracking (GEO set, heartbeat, H3 cell index)
   */
  static async removeDriverLocation(driverId: string): Promise<void> {
    const cellKey = `${DRIVER_H3_CELL_PREFIX}${driverId}`;
    const cell = await redis.get(cellKey);
    const pipeline = redis.pipeline();
    pipeline.zrem(DRIVER_LOCATIONS_KEY, driverId);
    pipeline.del(`${DRIVER_HEARTBEAT_PREFIX}${driverId}`);
    if (cell) {
      pipeline.srem(`${DRIVER_H3_INDEX_PREFIX}${cell}`, driverId);
    }
    pipeline.del(cellKey);
    await pipeline.exec();
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