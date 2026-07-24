// backend/src/routing/query/astar.ts
//
// Bidirectional A* shortest-path algorithm on a flat adjacency graph.
// Features:
//   - Binary min-heap priority queue for O(log n) operations
//   - Haversine heuristic (admissible, consistent)
//   - Turn penalties based on angle between consecutive edges
//   - Time-of-day congestion factors
//   - Road-class speed profiles
//   - Bidirectional search for 2x speedup over unidirectional

import { RoutingGraph, ROAD_CLASS_SPEEDS } from '../graph/types';

const MPH_TO_MS = 0.44704;
const MAX_SPEED_MS = 65 * MPH_TO_MS; // ~29 m/s — motorway speed

// ---------------------------------------------------------------------------
// Binary min-heap
// ---------------------------------------------------------------------------

class MinHeap {
  private data: [number, number][] = [];

  get size(): number { return this.data.length; }

  peek(): [number, number] { return this.data[0]; }

  push(f: number, node: number): void {
    this.data.push([f, node]);
    this.bubbleUp(this.data.length - 1);
  }

  pop(): [number, number] | undefined {
    if (this.data.length === 0) return undefined;
    const top = this.data[0];
    const last = this.data.pop()!;
    if (this.data.length > 0) {
      this.data[0] = last;
      this.sinkDown(0);
    }
    return top;
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.data[p][0] <= this.data[i][0]) break;
      [this.data[p], this.data[i]] = [this.data[i], this.data[p]];
      i = p;
    }
  }

  private sinkDown(i: number): void {
    const n = this.data.length;
    while (true) {
      let min = i;
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      if (l < n && this.data[l][0] < this.data[min][0]) min = l;
      if (r < n && this.data[r][0] < this.data[min][0]) min = r;
      if (min === i) break;
      [this.data[min], this.data[i]] = [this.data[i], this.data[min]];
      i = min;
    }
  }
}

// ---------------------------------------------------------------------------
// Haversine heuristic
// ---------------------------------------------------------------------------

function haversine(a: number, b: number, c: number, d: number): number {
  const R = 6371000;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(c - a);
  const dLng = toRad(d - b);
  const x = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a)) * Math.cos(toRad(c)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

// ---------------------------------------------------------------------------
// Bearing calculation
// ---------------------------------------------------------------------------

function computeBearing(
  lat1: number, lng1: number, lat2: number, lng2: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lng2 - lng1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// ---------------------------------------------------------------------------
// Turn penalty: angle-based (seconds)
// ---------------------------------------------------------------------------

function turnPenalty(
  graph: RoutingGraph,
  prevNode: number, fromEdgeIdx: number,
  currNode: number, toEdgeIdx: number,
  isForward: boolean,
): number {
  if (prevNode === -1) return 0;

  // Compute the angle between the incoming and outgoing edge segments
  const offsets = isForward ? graph.forwardOffsets : graph.backwardOffsets;
  const targets = isForward ? graph.forwardTargets : graph.backwardTargets;
  const lats = graph.lats;
  const lngs = graph.lngs;

  // Incoming bearing: prevNode → currNode
  const inBearing = computeBearing(
    lats[prevNode], lngs[prevNode], lats[currNode], lngs[currNode],
  );

  // Outgoing bearing: currNode → nextNode
  const nextNode = targets[toEdgeIdx];
  const outBearing = computeBearing(
    lats[currNode], lngs[currNode], lats[nextNode], lngs[nextNode],
  );

  // Signed turn angle
  let angle = outBearing - inBearing;
  if (angle > 180) angle -= 360;
  if (angle < -180) angle += 360;
  const absAngle = Math.abs(angle);

  // Straight: 0-15°, Slight: 15-45°, Moderate: 45-135°, U-turn: 135-180°
  if (absAngle < 15) return 0;         // straight
  if (absAngle < 45) return 2;         // slight turn
  if (absAngle < 135) return 5;        // moderate left/right
  return 20;                            // u-turn
}

// ---------------------------------------------------------------------------
// Congestion factor (time of day)
// ---------------------------------------------------------------------------

function congestionFactor(): number {
  const now = new Date();
  const hour = now.getHours();
  const dow = now.getDay();
  const isWeekend = dow === 0 || dow === 6;

  if (isWeekend) {
    if (hour >= 10 && hour <= 16) return 0.85;
    if (hour >= 17 && hour <= 21) return 0.75;
    return 1.0;
  }
  if (hour >= 7 && hour <= 9) return 0.55;
  if (hour >= 10 && hour <= 11) return 0.80;
  if (hour >= 12 && hour <= 13) return 0.70;
  if (hour >= 14 && hour <= 15) return 0.75;
  if (hour >= 16 && hour <= 18) return 0.50;
  if (hour >= 19 && hour <= 20) return 0.70;
  if (hour >= 21 || hour <= 6) return 1.0;
  return 0.80;
}

// ---------------------------------------------------------------------------
// A* result
// ---------------------------------------------------------------------------

export interface AStarResult {
  distanceMeters: number;
  durationMs: number;
  nodePath: number[];
  totalTurnPenalty: number;
}

// ---------------------------------------------------------------------------
// Bidirectional A* search
// ---------------------------------------------------------------------------

export function bidirectionalAStar(
  graph: RoutingGraph,
  source: number,
  target: number,
): AStarResult | null {
  if (source === target) {
    return { distanceMeters: 0, durationMs: 0, nodePath: [source], totalTurnPenalty: 0 };
  }

  const n = graph.nodeCount;
  const congestion = congestionFactor();

  // Forward search arrays
  const fwdG = new Float64Array(n).fill(Infinity);
  const fwdParent = new Int32Array(n).fill(-1);
  const fwdParentEdge = new Int32Array(n).fill(-1);
  const fwdClosed = new Uint8Array(n);

  // Backward search arrays
  const bwdG = new Float64Array(n).fill(Infinity);
  const bwdParent = new Int32Array(n).fill(-1);
  const bwdParentEdge = new Int32Array(n).fill(-1);
  const bwdClosed = new Uint8Array(n);

  // Best meeting point
  let bestDist = Infinity;
  let bestNode = -1;

  // Heuristic for forward search: haversine / max speed
  const hFwd = (node: number) =>
    haversine(graph.lats[node], graph.lngs[node], graph.lats[target], graph.lngs[target]) / MAX_SPEED_MS;

  // Heuristic for backward search: haversine / max speed
  const hBwd = (node: number) =>
    haversine(graph.lats[node], graph.lngs[node], graph.lats[source], graph.lngs[source]) / MAX_SPEED_MS;

  const openFwd = new MinHeap();
  const openBwd = new MinHeap();

  fwdG[source] = 0;
  openFwd.push(hFwd(source), source);

  bwdG[target] = 0;
  openBwd.push(hBwd(target), target);

  let iterations = 0;
  const maxIterations = n * 2;

  while (openFwd.size > 0 || openBwd.size > 0) {
    iterations++;
    if (iterations > maxIterations) break;

    // Check termination: if both open sets are empty or best found
    const fwdMin = openFwd.size > 0 ? openFwd.peek()[0] : Infinity;
    const bwdMin = openBwd.size > 0 ? openBwd.peek()[0] : Infinity;
    if (fwdMin + bwdMin >= bestDist) break;

    // Expand forward
    if (openFwd.size > 0) {
      const [fFwd, u] = openFwd.pop()!;
      if (fwdClosed[u]) continue;
      fwdClosed[u] = 1;

      // Update meeting point
      if (bwdClosed[u]) {
        const total = fwdG[u] + bwdG[u];
        if (total < bestDist) {
          bestDist = total;
          bestNode = u;
        }
      }

      // Expand forward edges
      for (let ei = graph.forwardOffsets[u]; ei < graph.forwardOffsets[u + 1]; ei++) {
        const v = graph.forwardTargets[ei];
        if (fwdClosed[v]) continue;

        const edgeWeight = graph.forwardWeights[ei] / congestion;
        const tPenalty = turnPenalty(graph, fwdParent[u], fwdParentEdge[u], u, ei, true);
        const tentativeG = fwdG[u] + edgeWeight + tPenalty;

        if (tentativeG < fwdG[v]) {
          fwdG[v] = tentativeG;
          fwdParent[v] = u;
          fwdParentEdge[v] = ei;
          openFwd.push(tentativeG + hFwd(v), v);
        }
      }
    }

    // Expand backward
    if (openBwd.size > 0) {
      const [fBwd, u] = openBwd.pop()!;
      if (bwdClosed[u]) continue;
      bwdClosed[u] = 1;

      // Update meeting point
      if (fwdClosed[u]) {
        const total = fwdG[u] + bwdG[u];
        if (total < bestDist) {
          bestDist = total;
          bestNode = u;
        }
      }

      // Expand backward edges
      for (let ei = graph.backwardOffsets[u]; ei < graph.backwardOffsets[u + 1]; ei++) {
        const v = graph.backwardTargets[ei];
        if (bwdClosed[v]) continue;

        const edgeWeight = graph.backwardWeights[ei] / congestion;
        const tPenalty = turnPenalty(graph, bwdParent[u], bwdParentEdge[u], u, ei, false);
        const tentativeG = bwdG[u] + edgeWeight + tPenalty;

        if (tentativeG < bwdG[v]) {
          bwdG[v] = tentativeG;
          bwdParent[v] = u;
          bwdParentEdge[v] = ei;
          openBwd.push(tentativeG + hBwd(v), v);
        }
      }
    }
  }

  if (bestNode === -1) return null;

  // Reconstruct path
  const path: number[] = [];

  // Forward path: source → bestNode
  let cur = bestNode;
  const fwdPath: number[] = [];
  while (cur !== source) {
    fwdPath.push(cur);
    cur = fwdParent[cur];
  }
  fwdPath.push(source);
  fwdPath.reverse();

  // Backward path: bestNode → target
  cur = bestNode;
  const bwdPath: number[] = [];
  while (cur !== target) {
    bwdPath.push(cur);
    cur = bwdParent[cur];
  }
  bwdPath.push(target);

  path.push(...fwdPath);
  if (bwdPath.length > 1) path.push(...bwdPath.slice(1));

  // Compute total distance
  let totalDistance = 0;
  for (let i = 1; i < path.length; i++) {
    totalDistance += haversine(
      graph.lats[path[i - 1]], graph.lngs[path[i - 1]],
      graph.lats[path[i]], graph.lngs[path[i]],
    );
  }

  return {
    distanceMeters: totalDistance,
    durationMs: bestDist * 1000,
    nodePath: path,
    totalTurnPenalty: 0,
  };
}
