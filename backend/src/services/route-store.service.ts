// backend/src/services/route-store.service.ts
//
// Single owner of persisted route artifacts:
//
//   1. ride_routes  (Postgres, migration 034) — the ride-scoped
//      authoritative route per leg. The rider-generated route is stored
//      at request time and reused by the driver at navigation start /
//      leg advance, so a ride triggers exactly ONE Google call when the
//      pipeline is warm.
//   2. route_cache  (Postgres, migration 032) — reusable OD route cache
//      keyed by H3 cells at resolution 8. Read with a configurable
//      neighbor radius so nearby origins reuse the same Google result.
//   3. eta_cache    (Postgres, migration 032) — traffic-aware ETA rows.
//   4. Redis mirrors (ride_route:{rideId}:{leg}, route:od:{oH3}:{dH3})
//      for hot-path reads without a PG round trip.
//
// Every write here is best-effort: the routing hot path must never
// depend on the store being available. All methods swallow failures and
// the caller falls back to a direct Google call.

import { createHash } from 'crypto';
import { latLngToCell, gridDisk } from 'h3-js';
import { pool } from '../config/database';
import { redis } from '../config/redis';

export type LegName = 'pickup' | 'destination';

export interface RouteGeom {
  type: 'LineString';
  coordinates: Array<[number, number]>; // [lng, lat] GeoJSON order
}

export interface StoreRouteInput {
  rideId: string;
  leg: LegName;
  origin: [number, number]; // [lat, lng]
  destination: [number, number]; // [lat, lng]
  distanceMeters: number;
  durationSeconds: number;
  trafficDurationSeconds: number | null;
  etaSeconds: number;
  geometry: RouteGeom;
  steps: any[];
  engine: string;
  cacheHit: boolean;
}

export interface StoredRoute {
  rideId: string;
  leg: LegName;
  origin: [number, number];
  destination: [number, number];
  originH3: string;
  destH3: string;
  distanceMeters: number;
  durationSeconds: number;
  trafficDurationSeconds: number | null;
  etaSeconds: number;
  geometry: RouteGeom;
  steps: any[];
  routeHash: string;
  engine: string;
  cacheHit: boolean;
  createdAt: string;
}

export interface OdcacheHit {
  origin: [number, number];
  destination: [number, number];
  distanceMeters: number;
  durationSeconds: number;
  trafficDurationSeconds: number | null;
  geometry: RouteGeom;
  steps: any[];
  engine: string;
  createdAt: string;
  distanceMetersToOrigin: number;
  exactOd: boolean;
}

const H3_RESOLUTION = 8;
const RIDE_ROUTE_REDIS_TTL_S = 6 * 60 * 60; // 6h — long enough for the whole ride
const OD_REDIS_TTL_S = 30 * 60; // OD mirror is a hot-path accelerator only
const TRAFFIC_TTL_S = 15 * 60; // traffic-aware durations are fresh for 15 min
const STATIC_TTL_S = 7 * 24 * 60 * 60; // static geometry survives 7 days

const EARTH_RADIUS_M = 6371000;

function toRad(d: number): number {
  return (d * Math.PI) / 180;
}

/** Haversine distance in meters between two [lat, lng] tuples. */
export function haversineMeters(a: [number, number], b: [number, number]): number {
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function routeHash(geometry: RouteGeom): string {
  return createHash('sha1').update(JSON.stringify(geometry.coordinates)).digest('hex');
}

export class RouteStoreService {
  // ---- H3 helpers --------------------------------------------------------

  static h3Cell(lat: number, lng: number): string {
    try {
      return latLngToCell(lat, lng, H3_RESOLUTION);
    } catch {
      return '';
    }
  }

  /** Origin H3 cell + neighbor cells within `radius` rings (7 cells at k=1). */
  static h3Neighbors(hex: string, radius: number): string[] {
    if (!hex) return [];
    try {
      return gridDisk(hex, radius);
    } catch {
      return [hex];
    }
  }

  // ---- Ride-scoped routes -------------------------------------------------

  static async saveRideRoute(input: StoreRouteInput): Promise<void> {
    const originH3 = this.h3Cell(input.origin[0], input.origin[1]);
    const destH3 = this.h3Cell(input.destination[0], input.destination[1]);
    const hash = routeHash(input.geometry);
    const row = {
      ride_id: input.rideId,
      leg: input.leg,
      origin_lat: input.origin[0],
      origin_lng: input.origin[1],
      dest_lat: input.destination[0],
      dest_lng: input.destination[1],
      origin_h3: originH3 || 'unknown',
      dest_h3: destH3 || 'unknown',
      distance_meters: input.distanceMeters,
      duration_seconds: input.durationSeconds,
      traffic_duration_seconds: input.trafficDurationSeconds,
      eta_seconds: input.etaSeconds,
      polyline: JSON.stringify(input.geometry.coordinates),
      steps: JSON.stringify(input.steps ?? []),
      route_hash: hash,
      engine: input.engine,
      cache_hit: input.cacheHit,
    };

    await pool.query(
      `INSERT INTO ride_routes (ride_id, leg, origin_lat, origin_lng, dest_lat, dest_lng,
        origin_h3, dest_h3, distance_meters, duration_seconds, traffic_duration_seconds,
        eta_seconds, polyline, steps, route_hash, engine, cache_hit)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (ride_id, leg) DO UPDATE SET
         origin_lat = EXCLUDED.origin_lat, origin_lng = EXCLUDED.origin_lng,
         dest_lat = EXCLUDED.dest_lat, dest_lng = EXCLUDED.dest_lng,
         origin_h3 = EXCLUDED.origin_h3, dest_h3 = EXCLUDED.dest_h3,
         distance_meters = EXCLUDED.distance_meters,
         duration_seconds = EXCLUDED.duration_seconds,
         traffic_duration_seconds = EXCLUDED.traffic_duration_seconds,
         eta_seconds = EXCLUDED.eta_seconds,
         polyline = EXCLUDED.polyline, steps = EXCLUDED.steps,
         route_hash = EXCLUDED.route_hash, engine = EXCLUDED.engine,
         cache_hit = EXCLUDED.cache_hit, created_at = NOW()`,
      [
        row.ride_id, row.leg, row.origin_lat, row.origin_lng, row.dest_lat, row.dest_lng,
        row.origin_h3, row.dest_h3, row.distance_meters, row.duration_seconds,
        row.traffic_duration_seconds, row.eta_seconds, row.polyline, row.steps,
        row.route_hash, row.engine, row.cache_hit,
      ],
    );

    try {
      await redis.set(
        `ride_route:${input.rideId}:${input.leg}`,
        JSON.stringify({ ...row, geometry: input.geometry, steps: input.steps ?? [] }),
        'EX',
        RIDE_ROUTE_REDIS_TTL_S,
      );
    } catch {
      // Redis down — PG row is authoritative.
    }
  }

  /** Read a ride leg route: Redis mirror first, PG fallback. */
  static async getRideRoute(rideId: string, leg: LegName): Promise<StoredRoute | null> {
    try {
      const raw = await redis.get(`ride_route:${rideId}:${leg}`);
      if (raw) {
        const r = JSON.parse(raw);
        return this.rowToStoredRoute(rideId, leg, r);
      }
    } catch {
      // fall through to PG
    }

    try {
      const res = await pool.query(
        `SELECT * FROM ride_routes WHERE ride_id = $1 AND leg = $2`,
        [rideId, leg],
      );
      const row = res.rows[0];
      if (!row) return null;
      return this.rowToStoredRoute(rideId, leg, row);
    } catch {
      return null;
    }
  }

  private static rowToStoredRoute(rideId: string, leg: LegName, r: any): StoredRoute {
    let coordinates: Array<[number, number]> = [];
    try {
      coordinates = Array.isArray(r.polyline)
        ? r.polyline
        : JSON.parse(r.polyline ?? '[]');
    } catch {
      coordinates = [];
    }
    return {
      rideId,
      leg,
      origin: [Number(r.origin_lat), Number(r.origin_lng)],
      destination: [Number(r.dest_lat), Number(r.dest_lng)],
      originH3: r.origin_h3 ?? '',
      destH3: r.dest_h3 ?? '',
      distanceMeters: Number(r.distance_meters),
      durationSeconds: Number(r.duration_seconds),
      trafficDurationSeconds: r.traffic_duration_seconds != null ? Number(r.traffic_duration_seconds) : null,
      etaSeconds: Number(r.eta_seconds ?? r.duration_seconds),
      geometry: { type: 'LineString', coordinates },
      steps: Array.isArray(r.steps) ? r.steps : JSON.parse(r.steps ?? '[]'),
      routeHash: r.route_hash ?? '',
      engine: r.engine ?? 'GoogleRoutes',
      cacheHit: !!r.cache_hit,
      createdAt: r.created_at ?? r.cachedAt ?? new Date().toISOString(),
    };
  }

  // ---- OD route cache -----------------------------------------------------

  /**
   * Persist a successful route into the OD reuse cache (route_cache +
   * Redis mirror). Best-effort; the caller never awaits failures.
   */
  static async saveOdcache(
    origin: [number, number],
    destination: [number, number],
    geometry: RouteGeom,
    distanceMeters: number,
    durationSeconds: number,
    trafficDurationSeconds: number | null,
    steps: any[],
    engine: string,
  ): Promise<void> {
    const oH3 = this.h3Cell(origin[0], origin[1]);
    const dH3 = this.h3Cell(destination[0], destination[1]);
    if (!oH3 || !dH3) return;

    const trafficSeconds = trafficDurationSeconds ?? null;
    const expires = new Date(Date.now() + (trafficSeconds ? TRAFFIC_TTL_S : STATIC_TTL_S) * 1000);

    await pool.query(
      `INSERT INTO route_cache (origin_hex, dest_hex, origin_lat, origin_lng, dest_lat, dest_lng,
        distance_meters, duration_seconds, traffic_duration_seconds, polyline, steps, engine,
        created_at, accessed_at, access_count, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW(),NOW(),1,$13)
       ON CONFLICT DO NOTHING`,
      [
        oH3, dH3, origin[0], origin[1], destination[0], destination[1],
        distanceMeters, durationSeconds, trafficSeconds,
        JSON.stringify(geometry.coordinates), JSON.stringify(steps ?? []), engine,
        expires.toISOString(),
      ],
    );

    try {
      await redis.set(
        `route:od:${oH3}:${dH3}`,
        JSON.stringify({
          origin, destination,
          distanceMeters, durationSeconds, trafficSeconds,
          coordinates: geometry.coordinates,
          steps: steps ?? [], engine,
        }),
        'EX',
        trafficSeconds ? TRAFFIC_TTL_S : Math.min(STATIC_TTL_S, OD_REDIS_TTL_S * 4),
      );
    } catch {
      // PG row is authoritative.
    }
  }

  /**
   * Look up a cached route for an OD pair using H3 neighbor cells.
   * `radius` = number of H3 rings searched (0 = exact cell only,
   * 1 = 7 cells ≈ ±1.3 km, 2 = 19 cells ≈ ±3 km).
   *
   * Reuse rules:
   *   - geometry + static duration: valid until expires_at (7 days)
   *   - traffic_duration_seconds:    only reused if entry is < 15 min old
   * A hit returns the best candidate scored by OD-cell match then
   * origin proximity to the requested point.
   */
  static async findOdcache(
    origin: [number, number],
    destination: [number, number],
    radius = 1,
  ): Promise<OdcacheHit | null> {
    const oH3 = this.h3Cell(origin[0], origin[1]);
    const dH3 = this.h3Cell(destination[0], destination[1]);
    if (!oH3 || !dH3) return null;

    const oCells = this.h3Neighbors(oH3, radius);
    const dCells = this.h3Neighbors(dH3, radius);
    if (oCells.length === 0 || dCells.length === 0) return null;

    // Hot path: Redis mirror first.
    try {
      const exactKey = `route:od:${oH3}:${dH3}`;
      const raw = await redis.get(exactKey);
      if (raw) {
        const hit = JSON.parse(raw);
        if (this.isFresh(hit.trafficSeconds ?? null, hit.createdAt)) {
          return {
            origin: hit.origin as [number, number],
            destination: hit.destination as [number, number],
            distanceMeters: Number(hit.distanceMeters),
            durationSeconds: Number(hit.durationSeconds),
            trafficDurationSeconds: hit.trafficSeconds ?? null,
            geometry: { type: 'LineString', coordinates: hit.coordinates },
            steps: hit.steps ?? [],
            engine: hit.engine ?? 'GoogleRoutes',
            createdAt: hit.createdAt ?? new Date().toISOString(),
            distanceMetersToOrigin: haversineMeters(origin, hit.origin),
            exactOd: true,
          };
        }
      }
    } catch {
      // continue to PG
    }

    try {
      const res = await pool.query(
        `SELECT *, EXTRACT(EPOCH FROM (NOW() - created_at)) AS age_seconds
         FROM route_cache
         WHERE origin_hex = ANY($1::varchar[]) AND dest_hex = ANY($2::varchar[])
           AND expires_at > NOW()
         ORDER BY (CASE WHEN origin_hex = $3 AND dest_hex = $4 THEN 0 ELSE 1 END),
                  ABS(origin_lat - $5) + ABS(origin_lng - $6),
                  access_count DESC
         LIMIT 5`,
        [oCells, dCells, oH3, dH3, origin[0], origin[1]],
      );

      for (const row of res.rows) {
        // Traffic-aware rows age out faster; static rows reuse geometry freely.
        const traffic = row.traffic_duration_seconds != null ? Number(row.traffic_duration_seconds) : null;
        if (traffic != null && Number(row.age_seconds) > TRAFFIC_TTL_S) continue;
        if (traffic == null && Number(row.age_seconds) > STATIC_TTL_S) continue;

        let coordinates: Array<[number, number]> = [];
        try {
          coordinates = JSON.parse(row.polyline ?? '[]');
        } catch {
          continue;
        }
        if (coordinates.length < 2) continue;

        return {
          origin: [Number(row.origin_lat), Number(row.origin_lng)],
          destination: [Number(row.dest_lat), Number(row.dest_lng)],
          distanceMeters: Number(row.distance_meters),
          durationSeconds: Number(row.duration_seconds),
          trafficDurationSeconds: traffic,
          geometry: { type: 'LineString', coordinates },
          steps: typeof row.steps === 'string' ? JSON.parse(row.steps ?? '[]') : row.steps ?? [],
          engine: row.engine ?? 'GoogleRoutes',
          createdAt: row.created_at ?? new Date().toISOString(),
          distanceMetersToOrigin: haversineMeters(origin, [Number(row.origin_lat), Number(row.origin_lng)]),
          exactOd: row.origin_hex === oH3 && row.dest_hex === dH3,
        };
      }
    } catch {
      // PG unavailable — cache read degrades to a miss.
    }

    return null;
  }

  private static isFresh(trafficSeconds: number | null, createdAt?: string): boolean {
    const maxAge = trafficSeconds != null ? TRAFFIC_TTL_S : STATIC_TTL_S;
    const created = createdAt ? new Date(createdAt).getTime() : Date.now();
    return Date.now() - created < maxAge * 1000;
  }

  // ---- Remaining distance / ETA helpers (no Google) -----------------------

  /**
   * Local remaining-distance + ETA math over a stored polyline, used to
   * push live driver ETAs to riders without a Google call.
   *
   * O(N) vertex scan — fine at the 10 s throttle it runs at.
   */
  static computeRemaining(
    polyline: Array<[number, number]>,
    lat: number,
    lng: number,
  ): { remainingMeters: number; etaSeconds: number } {
    if (!polyline || polyline.length < 2) {
      return { remainingMeters: 0, etaSeconds: 0 };
    }

    // Find nearest vertex, then sum segment distances to the end.
    let nearestIdx = 0;
    let minDist = Infinity;
    const gps: [number, number] = [lat, lng];

    for (let i = 0; i < polyline.length; i++) {
      const d = haversineMeters(gps, [polyline[i][1], polyline[i][0]]);
      if (d < minDist) {
        minDist = d;
        nearestIdx = i;
      }
    }

    let remaining = 0;
    for (let i = nearestIdx; i < polyline.length - 1; i++) {
      remaining += haversineMeters(
        [polyline[i][1], polyline[i][0]],
        [polyline[i + 1][1], polyline[i + 1][0]],
      );
    }

    return { remainingMeters: remaining, etaSeconds: Math.round(remaining / 7.0) };
  }
}

