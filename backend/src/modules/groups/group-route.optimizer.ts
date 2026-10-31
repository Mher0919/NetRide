// backend/src/modules/groups/group-route.optimizer.ts
//
// PURE global multi-stop optimizer.
//
// Given a road-network cost matrix, the driver's starting node, the unique
// pickup stops and the fixed final destination, evaluate EVERY feasible
// pickup permutation (at most 5! = 120) and pick the one that minimizes the
// total road duration (distance breaks ties). The destination is always the
// last node.
//
// This is deliberately exhaustive instead of "nearest pickup next": a stop
// that looks close locally can make the complete journey much longer.

export interface MatrixCell {
  distanceMeters: number;
  durationSeconds: number;
}

export interface OptimizableStop {
  /** Stable stop key (deduplicated pickup key). */
  key: string;
  passengerIds: string[];
}

export interface StopOrderInput {
  /** Node ids: start must be index 0, destination the last index. */
  startId: string;
  destinationId: string;
  stops: OptimizableStop[];
  /** Matrix keyed by `${from}>${to}` (road distances/durations). */
  matrix: Map<string, MatrixCell>;
}

export interface StopOrderResult {
  orderedStopKeys: string[];
  totalDistanceMeters: number;
  totalDurationSeconds: number;
  legDurationsSeconds: number[];
  legDistancesMeters: number[];
}

export function matrixKey(from: string, to: string): string {
  return `${from}>${to}`;
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = items.slice(0, i).concat(items.slice(i + 1));
    for (const p of permutations(rest)) {
      out.push([items[i], ...p]);
    }
  }
  return out;
}

function cell(matrix: Map<string, MatrixCell>, from: string, to: string): MatrixCell | null {
  if (from === to) return { distanceMeters: 0, durationSeconds: 0 };
  const value = matrix.get(matrixKey(from, to));
  if (!value) return null;
  if (!Number.isFinite(value.distanceMeters) || !Number.isFinite(value.durationSeconds)) {
    return null;
  }
  return value;
}

/**
 * Exhaustive optimization. Returns null when the matrix cannot represent a
 * complete feasible route (the caller surfaces a routing error instead of
 * silently falling back to the join order).
 */
export function optimizeStopOrder(input: StopOrderInput): StopOrderResult | null {
  if (input.stops.length === 0) {
    const direct = cell(input.matrix, input.startId, input.destinationId);
    if (!direct) return null;
    return {
      orderedStopKeys: [],
      totalDistanceMeters: direct.distanceMeters,
      totalDurationSeconds: direct.durationSeconds,
      legDurationsSeconds: [direct.durationSeconds],
      legDistancesMeters: [direct.distanceMeters],
    };
  }

  const nodeIds = [input.startId, ...input.stops.map((s) => s.key), input.destinationId];
  for (const from of nodeIds) {
    for (const to of nodeIds) {
      if (from === to) continue;
      if (!cell(input.matrix, from, to)) return null;
    }
  }

  let best: StopOrderResult | null = null;
  for (const order of permutations(input.stops)) {
    let duration = 0;
    let distance = 0;
    const legDurations: number[] = [];
    const legDistances: number[] = [];
    let previous = input.startId;
    let feasible = true;
    for (const stop of order) {
      const leg = cell(input.matrix, previous, stop.key);
      if (!leg) {
        feasible = false;
        break;
      }
      duration += leg.durationSeconds;
      distance += leg.distanceMeters;
      legDurations.push(leg.durationSeconds);
      legDistances.push(leg.distanceMeters);
      previous = stop.key;
    }
    if (!feasible) continue;
    const finalLeg = cell(input.matrix, previous, input.destinationId);
    if (!finalLeg) continue;
    duration += finalLeg.durationSeconds;
    distance += finalLeg.distanceMeters;
    legDurations.push(finalLeg.durationSeconds);
    legDistances.push(finalLeg.distanceMeters);

    const candidate: StopOrderResult = {
      orderedStopKeys: order.map((s) => s.key),
      totalDistanceMeters: distance,
      totalDurationSeconds: duration,
      legDurationsSeconds: legDurations,
      legDistancesMeters: legDistances,
    };
    if (
      !best ||
      candidate.totalDurationSeconds < best.totalDurationSeconds ||
      (candidate.totalDurationSeconds === best.totalDurationSeconds &&
        candidate.totalDistanceMeters < best.totalDistanceMeters) ||
      (candidate.totalDurationSeconds === best.totalDurationSeconds &&
        candidate.totalDistanceMeters === best.totalDistanceMeters &&
        candidate.orderedStopKeys.join('|') < best.orderedStopKeys.join('|'))
    ) {
      best = candidate;
    }
  }
  return best;
}

/**
 * Merge stops that resolve to effectively the same physical pickup point.
 * 4 decimal places ≈ 11 m at the equator — close enough to be the same kerb,
 * while distinct addresses remain separate.
 */
export function dedupePickupStops<T extends {
  passengerId: string;
  lat: number;
  lng: number;
  placeId?: string | null;
}>(pickups: T[]): Array<T & { key: string; passengerIds: string[] }> {
  const byKey = new Map<string, T & { key: string; passengerIds: string[] }>();
  for (const p of pickups) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
    const key = p.placeId && p.placeId.trim().length > 0
      ? `place:${p.placeId.trim()}`
      : `geo:${p.lat.toFixed(4)},${p.lng.toFixed(4)}`;
    const existing = byKey.get(key);
    if (existing) {
      if (!existing.passengerIds.includes(p.passengerId)) {
        existing.passengerIds.push(p.passengerId);
      }
    } else {
      byKey.set(key, { ...p, key, passengerIds: [p.passengerId] });
    }
  }
  return Array.from(byKey.values());
}

export const _internals = { permutations };
