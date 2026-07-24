// backend/src/routing/graph/types.ts
//
// Core graph data structures for the A* routing engine.
// Uses flat typed arrays for memory-efficient, cache-friendly access.
// All coordinates are in [lat, lng] order.

export enum RoadClass {
  MOTORWAY = 0,
  TRUNK = 1,
  PRIMARY = 2,
  SECONDARY = 3,
  TERTIARY = 4,
  UNCLASSIFIED = 5,
  RESIDENTIAL = 6,
  SERVICE = 7,
  LIVING_STREET = 8,
  UNKNOWN = 9,
}

/** Speed limits by road class (mph). */
export const ROAD_CLASS_SPEEDS: Record<RoadClass, number> = {
  [RoadClass.MOTORWAY]: 65,
  [RoadClass.TRUNK]: 55,
  [RoadClass.PRIMARY]: 45,
  [RoadClass.SECONDARY]: 35,
  [RoadClass.TERTIARY]: 30,
  [RoadClass.UNCLASSIFIED]: 25,
  [RoadClass.RESIDENTIAL]: 20,
  [RoadClass.SERVICE]: 15,
  [RoadClass.LIVING_STREET]: 10,
  [RoadClass.UNKNOWN]: 25,
};

/** Edge flag bits for road properties. */
export const enum EdgeFlags {
  NONE = 0,
  ONE_WAY = 1 << 0,
  MOTORWAY = 1 << 1,
  TOLL = 1 << 2,
  FERRY = 1 << 3,
  ROUNDABOUT = 1 << 4,
  BRIDGE = 1 << 5,
  TUNNEL = 1 << 6,
}

export interface Edge {
  target: number;
  weight: number;
  distance: number;
  flags: number;
  roadClass: RoadClass;
  osmWayId: number;
  nameIdx: number;
}

/** Flat adjacency storage: for node i, edges are in [offsets[i], offsets[i+1]). */
export interface AdjacencyList {
  targets: Int32Array;
  weights: Float64Array;
  distances: Float64Array;
  flags: Uint8Array;
  roadClasses: Uint8Array;
  wayIds: BigInt64Array;
  nameIndices: Int32Array;
  offsets: Uint32Array;
}

/** Complete routing graph stored in memory. */
export interface RoutingGraph {
  nodeCount: number;
  edgeCount: number;
  lats: Float64Array;
  lngs: Float64Array;
  nodeIds: BigInt64Array;

  forwardOffsets: Uint32Array;
  forwardTargets: Int32Array;
  forwardWeights: Float64Array;
  forwardDistances: Float64Array;
  forwardFlags: Uint8Array;
  forwardRoadClasses: Uint8Array;
  forwardWayIds: BigInt64Array;
  forwardNameIndices: Int32Array;

  backwardOffsets: Uint32Array;
  backwardTargets: Int32Array;
  backwardWeights: Float64Array;
  backwardDistances: Float64Array;
  backwardFlags: Uint8Array;
  backwardRoadClasses: Uint8Array;
  backwardWayIds: BigInt64Array;
  backwardNameIndices: Int32Array;

  names: string[];
}

/** Route step for turn-by-turn navigation. */
export interface RouteStep {
  distance: number;
  duration: number;
  name: string;
  roadClass: RoadClass;
  maneuver: 'straight' | 'left' | 'right' | 'uturn' | 'roundabout' | 'exit';
  geometry: Array<[number, number]>;
}

/** Complete route result from A* search. */
export interface RouteResult {
  distanceMeters: number;
  durationMs: number;
  geometry: Array<[number, number]>;
  steps: RouteStep[];
  nodePath: number[];
}
