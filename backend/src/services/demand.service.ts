// backend/src/services/demand.service.ts
//
// DEMAND HEATMAP — service layer.
// ---------------------------------------------------------------------------
// Two responsibilities:
//
// 1. RECORD — real rider activity is ingested from the socket gateway
//    (app open on map, ride-flow opened, active-trip location updates,
//    ride requested). Each signal is cooldown-limited per (rider, type)
//    via Redis, then bucketed into an H3 cell and persisted (rider_activity).
//    trip-bound events (RIDE_REQUESTED) are always unique.
//
// 2. READ — drivers fetch aggregated, time-decayed demand zones around
//    their position. The query is constrained to the H3 disk around the
//    request point, cached in Redis for DEMAND_CACHE_TTL_S, and returns
//    ONLY zone geometry (center + radius + score) — raw rider locations
//    are never exposed to drivers.
//
// 3. SWEEP — old activity rows are purged past (window + buffer) so the
//    table can't grow without bound. Called from the 5-minute cleanup job.

import { latLngToCell, cellToLatLng, gridDisk } from 'h3-js';
import { pool } from '../config/database';
import { redis } from '../config/redis';
import { logger } from '../observability/logger';
import {
  DEFAULT_DEMAND_CONFIG,
  DemandConfig,
  DemandZone,
  RiderActivityType,
  ActivityRow,
  aggregateCells,
  buildZones,
  eventAgeMinutes,
} from './demand.model';

export const DEMAND_CONFIG: DemandConfig = {
  ...DEFAULT_DEMAND_CONFIG,
  // Overridable window only — weights/decay are code constants.
  windowMinutes: DEFAULT_DEMAND_CONFIG.windowMinutes,
};

const CACHE_TTL_S = 45;
const COOLDOWN_PREFIX = 'demand:cd:';
const SWEEP_BUFFER_MINUTES = 60; // keep (window + buffer) of rows at most

export interface RecordActivityInput {
  riderId: string;
  type: RiderActivityType;
  lat: number;
  lng: number;
  tripId?: string | null;
}

function cooldownKey(riderId: string, type: string): string {
  return `${COOLDOWN_PREFIX}${riderId}:${type}`;
}

/**
 * Record a real rider activity signal. Cooldown-limited: a rider idling on
 * the map (15 s geohash subscription) can only contribute one APP_OPEN
 * signal every 5 minutes — never a flood.
 */
export async function recordRiderActivity(
  input: RecordActivityInput
): Promise<void> {
  if (!Number.isFinite(input.lat) || !Number.isFinite(input.lng)) return;
  if (input.lat < -90 || input.lat > 90 || input.lng < -180 || input.lng > 180) return;

  try {
    const cdSeconds = DEMAND_CONFIG.cooldowns[input.type] ?? 0;
    if (cdSeconds > 0 && input.type !== 'RIDE_REQUESTED') {
      const key = cooldownKey(input.riderId, input.type);
      const fresh = await redis.set(key, '1', 'EX', cdSeconds, 'NX');
      if (!fresh) return; // still inside the cooldown window — skip
    }

    const cell = latLngToCell(input.lat, input.lng, DEMAND_CONFIG.h3Resolution);

    await pool.query(
      `INSERT INTO rider_activity (rider_id, trip_id, activity_type, lat, lng, cell_h3)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        input.riderId,
        input.tripId ?? null,
        input.type,
        input.lat,
        input.lng,
        cell,
      ]
    );

    // Invalidate the cached heatmaps that could contain this cell.
    redis.del(`demand:v1:g:${cell}`).catch(() => undefined);
  } catch (err: any) {
    // Demand recording must never break the ride lifecycle.
    logger.debug({ err: err.message, type: input.type }, '[DEMAND] record failed (non-fatal)');
  }
}

interface DemandQuery {
  zones: DemandZone[];
  generatedAt: string;
  windowMinutes: number;
  expiresAt: string;
}

/**
 * Build the demand heatmap around a point. Cache-first: identical queries
 * from nearby drivers hit the same Redis key for up to 45 s.
 */
export async function getDemandZones(
  centerLat: number,
  centerLng: number,
  radiusKm = 10
): Promise<DemandQuery | null> {
  if (!Number.isFinite(centerLat) || !Number.isFinite(centerLng)) return null;
  const safeRadius = Math.min(Math.max(radiusKm, 3), 25);
  const centerCell = latLngToCell(centerLat, centerLng, DEMAND_CONFIG.h3Resolution);

  const cacheKey = `demand:v1:c:${centerCell}:r:${safeRadius}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      return { ...parsed, cached: true } as DemandQuery & { cached?: boolean };
    }
  } catch {
    // Cache read failure → compute fresh.
  }

  // H3 disk of cells covering the requested radius. H3 res-7 hexagon edge
  // is ~1.19 km; k = ceil(radius / edge) + 1 covers it with margin.
  const k = Math.max(2, Math.ceil(safeRadius / 1.2) + 1);
  let cells: string[];
  try {
    cells = gridDisk(centerCell, k);
  } catch (err: any) {
    logger.error({ err: err.message }, '[DEMAND] gridDisk failed');
    return null;
  }
  if (cells.length > 5000) return null; // sanity cap

  const cutoff = new Date(Date.now() - DEMAND_CONFIG.windowMinutes * 60_000);
  let rows: ActivityRow[];
  try {
    const res = await pool.query(
      `SELECT rider_id, trip_id, activity_type, lat, lng, cell_h3, created_at
       FROM rider_activity
       WHERE cell_h3 = ANY($1::text[])
         AND created_at >= $2`,
      [cells, cutoff.toISOString()]
    );
    rows = res.rows as ActivityRow[];
  } catch (err: any) {
    logger.error({ err: err.message }, '[DEMAND] query failed');
    return null;
  }

  const aggregated = aggregateCells(rows, DEMAND_CONFIG);
  if (aggregated.length === 0) {
    // Still cache the empty answer briefly so the fleet doesn't hammer us.
    const empty: DemandQuery = {
      zones: [],
      generatedAt: new Date().toISOString(),
      windowMinutes: DEMAND_CONFIG.windowMinutes,
      expiresAt: new Date(Date.now() + CACHE_TTL_S * 1000).toISOString(),
    };
    redis.setex(cacheKey, CACHE_TTL_S, JSON.stringify(empty)).catch(() => undefined);
    return empty;
  }

  const zones = buildZones(aggregated, DEMAND_CONFIG)
    .slice(0, DEMAND_CONFIG.maxZones);

  const result: DemandQuery = {
    zones,
    generatedAt: new Date().toISOString(),
    windowMinutes: DEMAND_CONFIG.windowMinutes,
    expiresAt: new Date(Date.now() + CACHE_TTL_S * 1000).toISOString(),
  };
  redis.setex(cacheKey, CACHE_TTL_S, JSON.stringify(result)).catch(() => undefined);
  return result;
}

/**
 * Purge activity rows past (window + buffer). Called by the 5-minute
 * cleanup worker so the table stays cheap: retention ~= 2 hours at default
 * config, bounded far below the heatmap window.
 */
export async function sweepExpiredActivity(): Promise<number> {
  try {
    const keepMinutes = DEMAND_CONFIG.windowMinutes + SWEEP_BUFFER_MINUTES;
    const res = await pool.query(
      `DELETE FROM rider_activity
       WHERE created_at < NOW() - ($1::int || ' minutes')::interval`,
      [keepMinutes]
    );
    if (res.rowCount && res.rowCount > 0) {
      logger.info({ removed: res.rowCount }, '[DEMAND] activity sweep');
    }
    return res.rowCount ?? 0;
  } catch (err: any) {
    logger.warn({ err: err.message }, '[DEMAND] sweep failed (non-fatal)');
    return 0;
  }
}

/** Small helper: expiry already handled by window filter; exported for tests. */
export function isWithinWindow(createdAt: Date | string, now = new Date()): boolean {
  return eventAgeMinutes(createdAt, now) <= DEMAND_CONFIG.windowMinutes;
}

/** Exposed for tests + admin tooling. */
export function cellIndex(lat: number, lng: number): string {
  return latLngToCell(lat, lng, DEMAND_CONFIG.h3Resolution);
}

export function cellCentroid(cell: string): { lat: number; lng: number } {
  const [lat, lng] = cellToLatLng(cell);
  return { lat, lng };
}