// backend/src/routing/utils/road-snapper.ts
//
// Snaps GPS coordinates to the nearest drivable road node in the routing graph.
// Uses a grid-based spatial index for O(1) nearest-node lookups.

import { RoutingGraph } from '../graph/types';
import { haversineMeters } from './geometry';

const GRID_PRECISION = 4; // ~11m grid cells
const MAX_SNAP_DISTANCE_M = 500;

interface GridCell {
  nodeIndices: number[];
}

/**
 * Spatial index for fast nearest-node lookups.
 * Uses a simple grid-based approach — O(1) lookup per cell.
 */
export class SpatialIndex {
  private cells = new Map<string, GridCell>();
  private graph: RoutingGraph;

  constructor(graph: RoutingGraph) {
    this.graph = graph;
    this.buildIndex();
  }

  private buildIndex(): void {
    for (let i = 0; i < this.graph.nodeCount; i++) {
      const key = this.gridKey(this.graph.lats[i], this.graph.lngs[i]);
      let cell = this.cells.get(key);
      if (!cell) {
        cell = { nodeIndices: [] };
        this.cells.set(key, cell);
      }
      cell.nodeIndices.push(i);
    }
  }

  private gridKey(lat: number, lng: number): string {
    const latKey = Math.floor(lat * Math.pow(10, GRID_PRECISION));
    const lngKey = Math.floor(lng * Math.pow(10, GRID_PRECISION));
    return `${latKey}:${lngKey}`;
  }

  /**
   * Find the nearest graph node to the given coordinate.
   * Searches the target cell and all 8 neighbors.
   */
  findNearest(lat: number, lng: number): { nodeIndex: number; distanceMeters: number } | null {
    const centerKey = this.gridKey(lat, lng);
    const [centerLat, centerLng] = centerKey.split(':').map(Number);
    const precision = Math.pow(10, GRID_PRECISION);

    let bestNode = -1;
    let bestDist = Infinity;

    // Search target cell and 8 neighbors
    for (let dLat = -1; dLat <= 1; dLat++) {
      for (let dLng = -1; dLng <= 1; dLng++) {
        const key = `${centerLat + dLat}:${centerLng + dLng}`;
        const cell = this.cells.get(key);
        if (!cell) continue;

        for (const nodeIdx of cell.nodeIndices) {
          const dist = haversineMeters(
            [lat, lng],
            [this.graph.lats[nodeIdx], this.graph.lngs[nodeIdx]],
          );
          if (dist < bestDist) {
            bestDist = dist;
            bestNode = nodeIdx;
          }
        }
      }
    }

    if (bestNode === -1 || bestDist > MAX_SNAP_DISTANCE_M) {
      return null;
    }

    return { nodeIndex: bestNode, distanceMeters: bestDist };
  }

  /**
   * Find the k nearest nodes to the given coordinate.
   * Useful for multi-candidate snapping with bearing constraints.
   */
  findKNearest(lat: number, lng: number, k: number = 5): Array<{ nodeIndex: number; distanceMeters: number }> {
    const candidates: Array<{ nodeIndex: number; distanceMeters: number }> = [];
    const centerKey = this.gridKey(lat, lng);
    const [centerLat, centerLng] = centerKey.split(':').map(Number);

    // Search wider area for k-nearest
    for (let dLat = -2; dLat <= 2; dLat++) {
      for (let dLng = -2; dLng <= 2; dLng++) {
        const key = `${centerLat + dLat}:${centerLng + dLng}`;
        const cell = this.cells.get(key);
        if (!cell) continue;

        for (const nodeIdx of cell.nodeIndices) {
          const dist = haversineMeters(
            [lat, lng],
            [this.graph.lats[nodeIdx], this.graph.lngs[nodeIdx]],
          );
          candidates.push({ nodeIndex: nodeIdx, distanceMeters: dist });
        }
      }
    }

    candidates.sort((a, b) => a.distanceMeters - b.distanceMeters);
    return candidates.slice(0, k);
  }
}

/**
 * Snap a coordinate to the nearest node in the graph.
 * Returns the node index and snap distance.
 */
export function snapToNode(
  spatialIndex: SpatialIndex,
  lat: number,
  lng: number,
): { nodeIndex: number; distanceMeters: number } | null {
  return spatialIndex.findNearest(lat, lng);
}

/**
 * Snap to nearest edge (road segment) for more accurate positioning.
 * Finds the nearest point on the nearest edge and returns the edge endpoints.
 */
export function snapToEdge(
  graph: RoutingGraph,
  spatialIndex: SpatialIndex,
  lat: number,
  lng: number,
): {
  fromNode: number;
  toNode: number;
  snapPoint: [number, number];
  distanceMeters: number;
} | null {
  const nearest = spatialIndex.findNearest(lat, lng);
  if (!nearest) return null;

  // Find the nearest edge by checking all edges from the nearest node
  const nodeIdx = nearest.nodeIndex;
  let bestFrom = nodeIdx;
  let bestTo = -1;
  let bestDist = Infinity;
  let bestSnapPoint: [number, number] = [lat, lng];

  // Check forward edges
  for (let i = graph.forwardOffsets[nodeIdx]; i < graph.forwardOffsets[nodeIdx + 1]; i++) {
    const target = graph.forwardTargets[i];
    const result = projectPointOnSegment(
      [lat, lng],
      [graph.lats[nodeIdx], graph.lngs[nodeIdx]],
      [graph.lats[target], graph.lngs[target]],
    );
    if (result.distance < bestDist) {
      bestDist = result.distance;
      bestFrom = nodeIdx;
      bestTo = target;
      bestSnapPoint = result.point;
    }
  }

  // Check backward edges
  for (let i = graph.backwardOffsets[nodeIdx]; i < graph.backwardOffsets[nodeIdx + 1]; i++) {
    const target = graph.backwardTargets[i];
    const result = projectPointOnSegment(
      [lat, lng],
      [graph.lats[nodeIdx], graph.lngs[nodeIdx]],
      [graph.lats[target], graph.lngs[target]],
    );
    if (result.distance < bestDist) {
      bestDist = result.distance;
      bestFrom = target;
      bestTo = nodeIdx;
      bestSnapPoint = result.point;
    }
  }

  if (bestTo === -1 || bestDist > MAX_SNAP_DISTANCE_M) return null;

  return {
    fromNode: bestFrom,
    toNode: bestTo,
    snapPoint: bestSnapPoint,
    distanceMeters: bestDist,
  };
}

function projectPointOnSegment(
  point: [number, number],
  segStart: [number, number],
  segEnd: [number, number],
): { point: [number, number]; distance: number; fraction: number } {
  const [px, py] = point;
  const [ax, ay] = segStart;
  const [bx, by] = segEnd;
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;

  if (lenSq === 0) {
    return {
      point: segStart,
      distance: haversineMeters(point, segStart),
      fraction: 0,
    };
  }

  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));

  const projX = ax + t * dx;
  const projY = ay + t * dy;

  return {
    point: [projX, projY],
    distance: haversineMeters(point, [projX, projY]),
    fraction: t,
  };
}
