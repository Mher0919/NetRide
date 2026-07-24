// backend/src/routing/index.ts
//
// Barrel export for the A* routing engine.

export * from './graph/types';
export { GraphBuilder, classifyRoad, isDrivable } from './graph/graph-builder';

export { parsePBF } from './preprocessing/pbf-parser';

export { bidirectionalAStar } from './query/astar';

export { AStarEngine, astarEngine } from './engine/astar-engine';

export * from './utils/geometry';
export { SpatialIndex, snapToNode, snapToEdge } from './utils/road-snapper';
export { LRUCache, RouteCache } from './utils/cache';

export { default as routingApi } from './api/routing-api';
