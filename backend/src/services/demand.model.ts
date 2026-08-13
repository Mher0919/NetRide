// backend/src/services/demand.model.ts
//
// DEMAND HEATMAP — pure aggregation + scoring model (no I/O).
// ---------------------------------------------------------------------------
// Turns raw rider activity rows into a small, driver-friendly zone list.
// Every number here is derived from real activity with a time decay:
//
//   cellScore = Σ over riders in hexagon of (max over rider's events of
//               [activityWeight(type) × decayWeight(age)])
//
//     - A rider who only browsed the map once contributes little; a rider
//       who just requested a ride contributes a lot.
//     - Old signals decay toward zero via piecewise-linear buckets, so the
//       heatmap always reflects the last N minutes, never history.
//     - Cells are merged (greedy nearest-pair, weighted centroid) when the
//       zone count would exceed MAX_ZONES — a downtown cluster becomes ONE
//       hotspot instead of 40 overlapping blobs.
//
// The output is deliberately normalized: drivers receive relative scores
// (0..1) + a radius, never raw counts and never rider locations.

export type RiderActivityType =
  | 'APP_OPEN'
  | 'REQUEST_FLOW'
  | 'APP_ACTIVE'
  | 'RIDE_REQUESTED';

export interface ActivityRow {
  rider_id: string;
  trip_id: string | null;
  activity_type: RiderActivityType;
  lat: number;
  lng: number;
  cell_h3: string;
  created_at: Date | string;
}

export interface DemandZone {
  /** Cell centroid (aggregated — never a raw rider position). */
  lat: number;
  lng: number;
  /** Hotspot radius in meters (clamped to [minRadiusMeters, maxRadiusMeters]). */
  radiusM: number;
  /** Relative intensity against the busiest cell, 0..1. */
  score: number;
  /** Number of distinct riders contributing (relative signal strength). */
  riders: number;
}

export interface DemandConfig {
  windowMinutes: number;
  h3Resolution: number;
  /** Expiry minutes: [youngest, weight] — linear interpolation between. */
  decayBuckets: ReadonlyArray<readonly [number, number]>;
  activityWeights: Record<RiderActivityType, number>;
  /** Per (rider, type) cooldown seconds — one signal per cooldown window. */
  cooldowns: Record<RiderActivityType, number>;
  minRadiusMeters: number;
  maxRadiusMeters: number;
  maxZones: number;
  /** Cells scoring below this fraction of the max are dropped. */
  minZoneScore: number;
  /** Radius grows with relative score — 'quadratic' keeps low-score zones small. */
  radiusCurve: 'linear' | 'sqrt' | 'quadratic';
}

export const DEFAULT_DEMAND_CONFIG: DemandConfig = {
  windowMinutes: 60,
  h3Resolution: 7,
  // A request from 4 minutes ago is "live"; browsing from 45 min ago fades.
  decayBuckets: [
    [5, 1.0],
    [15, 0.75],
    [30, 0.45],
    [60, 0.2],
  ] as ReadonlyArray<readonly [number, number]>,
  activityWeights: {
    RIDE_REQUESTED: 1.6, // strongest: a rider actually requested
    REQUEST_FLOW: 1.15,  // opened the ride flow / picked a destination
    APP_ACTIVE: 0.7,     // on the map during a live trip
    APP_OPEN: 0.6,       // browsing the map
  },
  cooldowns: {
    RIDE_REQUESTED: 10, // per-ride events are unique — cooldown is belt+braces
    REQUEST_FLOW: 120,
    APP_ACTIVE: 180,
    APP_OPEN: 300, // 5 min — map subscibe fires every 15 s
  },
  minRadiusMeters: 250,
  maxRadiusMeters: 2600,
  maxZones: 40,
  minZoneScore: 0.06,
  radiusCurve: 'quadratic',
};

/** Cap so a burst of bogus events can never explode the payload. */
export const MAX_AGGREGATED_EVENTS = 200_000;

/** Age of an event in minutes (clamped to >= 0). */
export function eventAgeMinutes(
  createdAt: Date | string,
  now: Date = new Date()
): number {
  const t = createdAt instanceof Date ? createdAt : new Date(createdAt);
  return Math.max(0, (now.getTime() - t.getTime()) / 60_000);
}

/**
 * Piecewise-linear time decay. Returns 1.0 for events newer than the first
 * bucket, 0.0 at/after the last bucket, interpolating between buckets.
 */
export function decayWeight(
  ageMinutes: number,
  buckets: ReadonlyArray<readonly [number, number]> = DEFAULT_DEMAND_CONFIG.decayBuckets
): number {
  if (ageMinutes < 0 || buckets.length === 0) return 0;
  const first = buckets[0];
  const last = buckets[buckets.length - 1];
  if (ageMinutes <= first[0]) return first[1];
  if (ageMinutes >= last[0]) return 0;
  for (let i = 1; i < buckets.length; i++) {
    const [tPrev, wPrev] = buckets[i - 1];
    const [tNext, wNext] = buckets[i];
    if (ageMinutes <= tNext) {
      const f = (ageMinutes - tPrev) / (tNext - tPrev);
      return wPrev + f * (wNext - wPrev);
    }
  }
  return 0;
}

export interface AggregatedCell {
  cell: string;
  /** Weighted centroid of the contributing points (never raw locations). */
  lat: number;
  lng: number;
  weight: number;
  riders: number;
  /** Points that contributed, for optional debugging only. */
  pointCount: number;
}

/**
 * Group activity rows into cells. Per rider, only their STRONGEST signal in
 * each cell counts (a rider geyser-ing events can't inflate a zone).
 */
export function aggregateCells(
  rows: ActivityRow[],
  config: DemandConfig = DEFAULT_DEMAND_CONFIG,
  now: Date = new Date()
): AggregatedCell[] {
  if (rows.length > MAX_AGGREGATED_EVENTS) {
    rows = rows.slice(rows.length - MAX_AGGREGATED_EVENTS);
  }

  // cell → riderId → best weight
  const cellRiders = new Map<string, Map<string, number>>();
  const cellPoints = new Map<string, { lat: number; lng: number; w: number }[]>();

  for (const row of rows) {
    const age = eventAgeMinutes(row.created_at, now);
    const w = decayWeight(age, config.decayBuckets);
    if (w <= 0) continue;

    const riderWeight = (config.activityWeights[row.activity_type] ?? 0) * w;
    if (riderWeight <= 0) continue;

    let riders = cellRiders.get(row.cell_h3);
    if (!riders) {
      riders = new Map();
      cellRiders.set(row.cell_h3, riders);
    }
    const existing = riders.get(row.rider_id) ?? 0;
    if (riderWeight > existing) {
      riders.set(row.rider_id, riderWeight);
    }

    let points = cellPoints.get(row.cell_h3);
    if (!points) {
      points = [];
      cellPoints.set(row.cell_h3, points);
    }
    points.push({ lat: row.lat, lng: row.lng, w: riderWeight });
  }

  const cells: AggregatedCell[] = [];
  for (const [cell, riders] of cellRiders) {
    const points = cellPoints.get(cell) ?? [];
    let weight = 0;
    for (const w of riders.values()) weight += w;

    // Weighted centroid over contributing points.
    let lat = 0;
    let lng = 0;
    let wSum = 0;
    for (const p of points) {
      lat += p.lat * p.w;
      lng += p.lng * p.w;
      wSum += p.w;
    }
    if (wSum > 0) {
      lat /= wSum;
      lng /= wSum;
    }
    cells.push({
      cell,
      lat,
      lng,
      weight,
      riders: riders.size,
      pointCount: points.length,
    });
  }
  return cells;
}

/** Greedy nearest-pair merge (weighted centroid) until count <= maxZones. */
export function mergeCells(
  cells: AggregatedCell[],
  maxZones: number
): AggregatedCell[] {
  if (cells.length <= maxZones) return cells;

  const working = cells.map((c) => ({ ...c }));
  while (working.length > maxZones) {
    let bestA = -1;
    let bestB = -1;
    let bestDist = Infinity;
    for (let i = 0; i < working.length; i++) {
      for (let j = i + 1; j < working.length; j++) {
        const d = haversineMeters(
          working[i].lat, working[i].lng,
          working[j].lat, working[j].lng,
        );
        if (d < bestDist) {
          bestDist = d;
          bestA = i;
          bestB = j;
        }
      }
    }
    if (bestA < 0) break;
    const a = working[bestA];
    const b = working[bestB];
    const total = a.weight + b.weight;
    const merged: AggregatedCell = {
      cell: `${a.cell}+${b.cell}`,
      lat: total > 0 ? (a.lat * a.weight + b.lat * b.weight) / total : a.lat,
      lng: total > 0 ? (a.lng * a.weight + b.lng * b.weight) / total : a.lng,
      weight: total,
      riders: a.riders + b.riders,
      pointCount: a.pointCount + b.pointCount,
    };
    // Remove b first (higher index) so removing a doesn't shift b.
    working.splice(bestB, 1);
    working.splice(bestA, 1, merged);
  }
  return working;
}

/**
 * Final zone list: normalized scores, clamped radii, min-score floor,
 * sorted busiest-first.
 */
export function buildZones(
  cells: AggregatedCell[],
  config: DemandConfig = DEFAULT_DEMAND_CONFIG
): DemandZone[] {
  if (cells.length === 0) return [];

  const merged = mergeCells(cells, config.maxZones);
  const maxWeight = Math.max(...merged.map((c) => c.weight));
  if (maxWeight <= 0) return [];

  const zones: DemandZone[] = [];
  for (const cell of merged) {
    const score = Math.min(1, cell.weight / maxWeight);
    if (score < config.minZoneScore) continue;

    let radiusFrac = score;
    if (config.radiusCurve === 'sqrt') {
      radiusFrac = Math.sqrt(score);
    } else if (config.radiusCurve === 'quadratic') {
      radiusFrac = score * score;
    }
    const radiusM = Math.round(
      config.minRadiusMeters +
        radiusFrac * (config.maxRadiusMeters - config.minRadiusMeters)
    );

    zones.push({
      lat: cell.lat,
      lng: cell.lng,
      radiusM: Math.min(config.maxRadiusMeters, Math.max(config.minRadiusMeters, radiusM)),
      score: Math.round(score * 1000) / 1000,
      riders: cell.riders,
    });
  }
  zones.sort((a, b) => b.score - a.score);
  return zones;
}

/** Haversine distance (meters) — also used for merge ordering. */
export function haversineMeters(
  lat1: number, lng1: number, lat2: number, lng2: number
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}