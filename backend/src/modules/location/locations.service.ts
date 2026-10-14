// backend/src/modules/location/locations.service.ts
//
// Owns the live driver location tracking + per-trip trajectory buffer
// in Redis. Exposes an in-process EventEmitter (`trajectoryEvents`)
// so downstream consumers (the speeding detector, future safety
// modules) can subscribe to the *same* trajectory stream without
// duplicating the Redis read or branching the hot path.

import { EventEmitter } from 'events';
import { latLngToCell, gridDisk } from 'h3-js';
import {
  redis,
  DRIVER_LOCATIONS_KEY,
  DRIVER_HEARTBEAT_PREFIX,
  DRIVER_LOCATION_RECORD_PREFIX,
  DRIVER_ONLINE_PREFIX,
  DRIVER_H3_CELL_PREFIX,
  DRIVER_H3_INDEX_PREFIX,
} from '../../config/redis';
import { env } from '../../config/env';
import { Location } from '../../types';
import * as geohash from 'ngeohash';

/**
 * A raw location observation as reported by a device. Only lat/lng are
 * mandatory; everything else may be absent on older clients.
 */
export interface LocationFix extends Location {
  /** Horizontal accuracy in meters as reported by the OS (null = unknown). */
  accuracy?: number | null;
  /** Device heading in degrees (null = unknown). */
  heading?: number | null;
  /** Device-reported speed in m/s (null = unknown). */
  speed?: number | null;
  /** True when the OS marks the fix as coming from a mock/spoofed provider. */
  mock?: boolean;
  /** Device-supplied ISO timestamp (never trusted for freshness decisions). */
  deviceAt?: string | null;
  /** Observation source label for diagnostics. */
  source?: string | null;
}

/**
 * The stored, timestamped observation. `serverAt` is the server's own
 * receive time; freshness and every safety-relevant gate must use it, never
 * a device clock.
 */
export interface DriverLocationRecord extends Location {
  serverAt: number;
  accuracy: number | null;
  heading: number | null;
  speed: number | null;
  mock: boolean;
  deviceAt: string | null;
  source: string;
}

export interface LocationFreshness {
  fresh: boolean;
  ageSeconds: number | null;
}

/**
 * Pure freshness evaluation (unit-tested): a location is fresh when the
 * server observed it no longer than `maxAgeS` ago. A missing/absent
 * timestamp is never fresh. Clock skew is one-sided: future timestamps
 * (negative age) are treated as age 0 rather than rejected.
 */
export function evaluateLocationFreshness(
  serverAt: number | null | undefined,
  nowMs: number,
  maxAgeS: number,
): LocationFreshness {
  if (serverAt == null || !isFinite(serverAt) || serverAt <= 0) {
    return { fresh: false, ageSeconds: null };
  }
  const ageMs = Math.max(0, nowMs - serverAt);
  const ageSeconds = ageMs / 1000;
  return { fresh: ageSeconds <= maxAgeS, ageSeconds };
}

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
  static async updateDriverLocation(driverId: string, loc: LocationFix): Promise<string> {
    const pipeline = redis.pipeline();
    
    // 1. Update Geospatial position
    pipeline.geoadd(DRIVER_LOCATIONS_KEY, loc.lng, loc.lat, driverId);
    
    // 2. Set heartbeat with TTL. This is long enough to survive brief
    // socket disconnects (free-tier spin-down, network blip) without making
    // truly offline drivers invisible to matching. The TTL is a single
    // configurable constant shared with the eligibility freshness math.
    pipeline.set(`${DRIVER_HEARTBEAT_PREFIX}${driverId}`, '1', 'EX', env.DRIVER_HEARTBEAT_TTL_S);

    // 2b. Persist the timestamped observation metadata (server receipt time,
    // accuracy, source, mock flag). Freshness gates read this record — the
    // GEO set alone has no age and previously let stale/spoofed fixes drive
    // pickup/complete gates and dispatch.
    const record: DriverLocationRecord = {
      lat: loc.lat,
      lng: loc.lng,
      serverAt: Date.now(),
      accuracy: typeof loc.accuracy === 'number' && isFinite(loc.accuracy) ? loc.accuracy : null,
      heading: typeof loc.heading === 'number' && isFinite(loc.heading) ? loc.heading : null,
      speed: typeof loc.speed === 'number' && isFinite(loc.speed) ? loc.speed : null,
      mock: loc.mock === true,
      deviceAt: typeof loc.deviceAt === 'string' ? loc.deviceAt : null,
      source: typeof loc.source === 'string' && loc.source.length > 0 ? loc.source : 'socket',
    };
    pipeline.set(
      `${DRIVER_LOCATION_RECORD_PREFIX}${driverId}`,
      JSON.stringify(record),
      'EX',
      env.DRIVER_LOCATION_RECORD_TTL_S,
    );

    // 2c. Renew the availability lease on every accepted position. A driver
    // whose app keeps reporting stays dispatchable; one whose app stopped
    // stops being offered new rides after the lease TTL without losing any
    // already-accepted trip.
    pipeline.set(`${DRIVER_ONLINE_PREFIX}${driverId}`, '1', 'EX', env.DRIVER_ONLINE_TTL_S);

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
   * Removes a driver from online tracking (GEO set, heartbeat, location
   * record, availability lease, H3 cell index).
   */
  static async removeDriverLocation(driverId: string): Promise<void> {
    const cellKey = `${DRIVER_H3_CELL_PREFIX}${driverId}`;
    const cell = await redis.get(cellKey);
    const pipeline = redis.pipeline();
    pipeline.zrem(DRIVER_LOCATIONS_KEY, driverId);
    pipeline.del(`${DRIVER_HEARTBEAT_PREFIX}${driverId}`);
    pipeline.del(`${DRIVER_LOCATION_RECORD_PREFIX}${driverId}`);
    pipeline.del(`${DRIVER_ONLINE_PREFIX}${driverId}`);
    if (cell) {
      pipeline.srem(`${DRIVER_H3_INDEX_PREFIX}${cell}`, driverId);
    }
    pipeline.del(cellKey);
    await pipeline.exec();
  }

  // ---- Availability lease -------------------------------------------------
  //
  // `goOnline` establishes a server-side lease independent of any position
  // fix, so availability is an explicit server state rather than a side
  // effect of location writes. It is renewed by every accepted location
  // update and expires on its own if the app stops reporting.

  static async markDriverOnline(driverId: string): Promise<number> {
    const ttl = env.DRIVER_ONLINE_TTL_S;
    await redis.set(`${DRIVER_ONLINE_PREFIX}${driverId}`, '1', 'EX', ttl);
    return Date.now() + ttl * 1000;
  }

  static async clearDriverOnline(driverId: string): Promise<void> {
    await redis.del(`${DRIVER_ONLINE_PREFIX}${driverId}`);
  }

  static async isDriverOnline(driverId: string): Promise<boolean> {
    const lease = await redis.get(`${DRIVER_ONLINE_PREFIX}${driverId}`);
    return lease !== null;
  }

  /**
   * Renews the raw heartbeat without changing the position. Used by
   * `goOnline` when the client has no fresh fix yet but a stored record
   * exists (e.g. reconnect) so the driver is not silently dropped from
   * dispatch while waiting for the first GPS sample.
   */
  static async touchHeartbeat(driverId: string): Promise<void> {
    await redis.set(`${DRIVER_HEARTBEAT_PREFIX}${driverId}`, '1', 'EX', env.DRIVER_HEARTBEAT_TTL_S);
  }

  /** Raw stored observation record (no freshness judgement). */
  static async getDriverLocationRecord(driverId: string): Promise<DriverLocationRecord | null> {
    const raw = await redis.get(`${DRIVER_LOCATION_RECORD_PREFIX}${driverId}`);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as DriverLocationRecord;
      if (!isFinite(parsed.lat) || !isFinite(parsed.lng)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * Returns the driver's last-known position with its freshness metadata.
   * `stale`/`mock` are explicit so callers can refuse to treat an obsolete
   * or spoofed coordinate as live (safety gates, ETAs, notifications).
   * Falls back to the GEO set when the record is missing (legacy entries)
   * with `serverAt: null` → always stale.
   */
  static async getDriverLocation(
    driverId: string,
  ): Promise<(DriverLocationRecord & { stale: boolean; ageSeconds: number | null }) | null> {
    const record = await LocationsService.getDriverLocationRecord(driverId);
    if (record) {
      const { fresh, ageSeconds } = evaluateLocationFreshness(
        record.serverAt,
        Date.now(),
        env.DRIVER_LOCATION_MAX_AGE_S,
      );
      return { ...record, stale: !fresh, ageSeconds };
    }
    const pos = await redis.geopos(DRIVER_LOCATIONS_KEY, driverId);
    if (pos && pos[0]) {
      return {
        lng: parseFloat(pos[0][0]),
        lat: parseFloat(pos[0][1]),
        serverAt: 0,
        accuracy: null,
        heading: null,
        speed: null,
        mock: false,
        deviceAt: null,
        source: 'geo-legacy',
        stale: true,
        ageSeconds: null,
      };
    }
    return null;
  }

  /** Freshness assessment for the stored record (dispatch eligibility). */
  static async isLocationFresh(driverId: string): Promise<boolean> {
    const record = await LocationsService.getDriverLocationRecord(driverId);
    return evaluateLocationFreshness(
      record?.serverAt,
      Date.now(),
      env.DRIVER_LOCATION_FRESHNESS_S,
    ).fresh;
  }
}