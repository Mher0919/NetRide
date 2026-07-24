// backend/src/routing/engine/astar-engine.ts
//
// A* Routing Engine — self-hosted, in-memory, fast routing.
// Loads a pre-built RoutingGraph from disk or builds from PBF.
// Provides route, distance/ETA, snap, and cache.

import * as fs from 'fs';
import * as path from 'path';
import { RoutingGraph, RouteResult, RouteStep, RoadClass, ROAD_CLASS_SPEEDS } from '../graph/types';
import { bidirectionalAStar, AStarResult } from '../query/astar';
import { SpatialIndex, snapToNode } from '../utils/road-snapper';
import { RouteCache } from '../utils/cache';
import { encodePolyline, toGeoJSONLineString, haversineMeters, bearing } from '../utils/geometry';
import { logger } from '../../observability/logger';
import { env } from '../../config/env';

const MPH_TO_MS = 0.44704;

export class AStarEngine {
  private static instance: AStarEngine | null = null;
  private graph: RoutingGraph | null = null;
  private spatialIndex: SpatialIndex | null = null;
  private cache: RouteCache = new RouteCache();
  private loaded = false;
  private loadTimeMs = 0;

  static getInstance(): AStarEngine {
    if (!AStarEngine.instance) {
      AStarEngine.instance = new AStarEngine();
    }
    return AStarEngine.instance;
  }

  /**
   * Load a pre-built RoutingGraph from a binary file.
   */
  async loadGraph(graphPath?: string): Promise<void> {
    const start = Date.now();
    const filePath = graphPath ?? env.ROUTING_GRAPH_PATH ?? path.join(__dirname, '../../data/routing-graph.bin');

    if (!fs.existsSync(filePath)) {
      throw new Error(`Routing graph not found at ${filePath}. Run preprocessing first.`);
    }

    this.graph = AStarEngine.loadBinaryGraph(filePath);
    this.spatialIndex = new SpatialIndex(this.graph);
    this.loaded = true;
    this.loadTimeMs = Date.now() - start;

    logger.info({
      nodes: this.graph.nodeCount,
      edges: this.graph.edgeCount,
      loadTimeMs: this.loadTimeMs,
    }, 'astar_engine_loaded');
  }

  /**
   * Route between two coordinates using A* shortest path.
   */
  async route(
    origin: [number, number],
    destination: [number, number],
  ): Promise<{
    distanceMeters: number;
    durationSeconds: number;
    geometry: { type: 'LineString'; coordinates: Array<[number, number]> };
    steps: any[];
    speedLimitsByRoad: Record<string, number>;
  } | null> {
    if (!this.loaded || !this.graph || !this.spatialIndex) {
      logger.warn('astar_engine_not_loaded');
      return null;
    }

    const start = process.hrtime.bigint();

    // Check cache
    const cached = this.cache.getRoute(origin[0], origin[1], destination[0], destination[1]);
    if (cached) {
      const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
      logger.debug({ elapsedMs: elapsed.toFixed(2) }, 'astar_cache_hit');
      return this.formatResult(cached);
    }

    // Snap coordinates
    let sourceIdx = this.cache.getSnapNode(origin[0], origin[1]);
    if (sourceIdx === null) {
      const snap = snapToNode(this.spatialIndex, origin[0], origin[1]);
      if (!snap) {
        logger.warn({ lat: origin[0], lng: origin[1] }, 'astar_snap_failed_origin');
        return null;
      }
      sourceIdx = snap.nodeIndex;
      this.cache.setSnapNode(origin[0], origin[1], sourceIdx);
    }

    let targetIdx = this.cache.getSnapNode(destination[0], destination[1]);
    if (targetIdx === null) {
      const snap = snapToNode(this.spatialIndex, destination[0], destination[1]);
      if (!snap) {
        logger.warn({ lat: destination[0], lng: destination[1] }, 'astar_snap_failed_dest');
        return null;
      }
      targetIdx = snap.nodeIndex;
      this.cache.setSnapNode(destination[0], destination[1], targetIdx);
    }

    // Run A*
    const result = bidirectionalAStar(this.graph, sourceIdx, targetIdx);
    if (!result) {
      logger.warn({ source: sourceIdx, target: targetIdx }, 'astar_no_path');
      return null;
    }

    // Build geometry
    const geometry = this.buildGeometry(result.nodePath);
    const steps = this.buildSteps(result.nodePath);

    const routeResult: RouteResult = {
      distanceMeters: result.distanceMeters,
      durationMs: result.durationMs,
      geometry: geometry.coordinates as Array<[number, number]>,
      steps,
      nodePath: result.nodePath,
    };

    // Cache the result (use lat/lng coords for caching)
    this.cache.setRoute(origin[0], origin[1], destination[0], destination[1], routeResult);

    const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
    logger.debug({
      elapsedMs: elapsed.toFixed(2),
      distanceMeters: result.distanceMeters,
      durationMs: result.durationMs,
    }, 'astar_routing_complete');

    return this.formatResult(routeResult);
  }

  /**
   * Lightweight distance/ETA without geometry.
   */
  async distanceAndETA(
    origin: [number, number],
    destination: [number, number],
  ): Promise<{ distanceMeters: number; durationSeconds: number } | null> {
    if (!this.loaded || !this.graph || !this.spatialIndex) return null;

    const cached = this.cache.getLightweight(origin[0], origin[1], destination[0], destination[1]);
    if (cached) return { distanceMeters: cached.distanceMeters, durationSeconds: cached.durationSeconds };

    const sourceIdx = this.snapNode(origin[0], origin[1]);
    const targetIdx = this.snapNode(destination[0], destination[1]);
    if (sourceIdx === null || targetIdx === null) return null;

    const result = bidirectionalAStar(this.graph, sourceIdx, targetIdx);
    if (!result) return null;

    const output = {
      distanceMeters: result.distanceMeters,
      durationSeconds: result.durationMs / 1000,
    };

    this.cache.setLightweight(origin[0], origin[1], destination[0], destination[1], output);
    return output;
  }

  snapNode(lat: number, lng: number): number | null {
    if (!this.spatialIndex || !this.loaded) {
      console.warn(`[ASTAR] snapNode: graph not loaded, cannot snap (${lat}, ${lng})`);
      return null;
    }
    const snap = snapToNode(this.spatialIndex, lat, lng);
    if (!snap) {
      console.warn(`[ASTAR] snapNode: no graph node within 500m of (${lat.toFixed(5)}, ${lng.toFixed(5)}), graph has ${this.graph?.nodeCount ?? 0} nodes`);
      return null;
    }
    if (snap.distanceMeters > 200) {
      console.log(`[ASTAR] snapNode: snapped (${lat.toFixed(5)}, ${lng.toFixed(5)}) to node ${snap.nodeIndex} but ${snap.distanceMeters.toFixed(0)}m away — may be inaccurate`);
    }
    return snap.nodeIndex;
  }

  getNodeCoords(nodeIndex: number): { lat: number; lng: number } | null {
    if (!this.graph || nodeIndex < 0 || nodeIndex >= this.graph.nodeCount) return null;
    return { lat: this.graph.lats[nodeIndex], lng: this.graph.lngs[nodeIndex] };
  }

  isReady(): boolean { return this.loaded; }

  stats() {
    return {
      loaded: this.loaded,
      nodes: this.graph?.nodeCount ?? 0,
      edges: this.graph?.edgeCount ?? 0,
      loadTimeMs: this.loadTimeMs,
      cache: this.cache.stats(),
    };
  }

  clearCache(): void { this.cache.clear(); }

  // ---------------------------------------------------------------------------
  // Geometry and step building
  // ---------------------------------------------------------------------------

  private buildGeometry(nodePath: number[]): { type: 'LineString'; coordinates: Array<[number, number]> } {
    if (!this.graph) return { type: 'LineString', coordinates: [] };
    const coords: Array<[number, number]> = nodePath.map(i => [
      this.graph!.lngs[i], this.graph!.lats[i],
    ]);
    return { type: 'LineString', coordinates: coords };
  }

  private buildSteps(nodePath: number[]): RouteStep[] {
    if (!this.graph || nodePath.length < 2) return [];
    const g = this.graph;
    const steps: RouteStep[] = [];
    let segStart = 0;
    let currentNameIdx = -1;
    let currentRoadClass = RoadClass.UNKNOWN;
    let segDistance = 0;

    for (let i = 1; i < nodePath.length; i++) {
      const from = nodePath[i - 1];
      const to = nodePath[i];
      const dist = haversineMeters(
        [g.lats[from], g.lngs[from]],
        [g.lats[to], g.lngs[to]],
      );

      // Find the edge to get its road class and name
      let edgeNameIdx = -1;
      let edgeRoadClass = RoadClass.UNKNOWN;
      for (let ei = g.forwardOffsets[from]; ei < g.forwardOffsets[from + 1]; ei++) {
        if (g.forwardTargets[ei] === to) {
          edgeNameIdx = g.forwardNameIndices[ei];
          edgeRoadClass = g.forwardRoadClasses[ei] as RoadClass;
          break;
        }
      }

      const nameChanged = edgeNameIdx !== currentNameIdx && currentNameIdx !== -1;
      const roadClassChanged = edgeRoadClass !== currentRoadClass && i > 1;

      if ((nameChanged || roadClassChanged) && segDistance > 0) {
        steps.push(this.buildStep(nodePath, segStart, i, g));
        segStart = i - 1;
        segDistance = dist;
        currentNameIdx = edgeNameIdx;
        currentRoadClass = edgeRoadClass;
      } else {
        segDistance += dist;
        currentNameIdx = edgeNameIdx;
        currentRoadClass = edgeRoadClass;
      }
    }

    if (segStart < nodePath.length - 1) {
      steps.push(this.buildStep(nodePath, segStart, nodePath.length, g));
    }

    // Add maneuver directions
    for (let i = 0; i < steps.length; i++) {
      if (i === 0) {
        steps[i].maneuver = 'straight';
      } else {
        steps[i].maneuver = this.computeManeuver(steps, i);
      }
    }

    return steps;
  }

  private buildStep(
    nodePath: number[], startIdx: number, endIdx: number, g: RoutingGraph,
  ): RouteStep {
    let distance = 0;
    const geometry: Array<[number, number]> = [];
    let nameIdx = -1;
    let roadClass = RoadClass.UNKNOWN;

    for (let i = startIdx; i < endIdx; i++) {
      const from = nodePath[i];
      const to = nodePath[i + 1];
      geometry.push([g.lats[from], g.lngs[from]]);

      distance += haversineMeters(
        [g.lats[from], g.lngs[from]],
        [g.lats[to], g.lngs[to]],
      );

      for (let ei = g.forwardOffsets[from]; ei < g.forwardOffsets[from + 1]; ei++) {
        if (g.forwardTargets[ei] === to) {
          if (nameIdx === -1) nameIdx = g.forwardNameIndices[ei];
          roadClass = g.forwardRoadClasses[ei] as RoadClass;
          break;
        }
      }
    }

    const lastNode = nodePath[endIdx - 1];
    geometry.push([g.lats[lastNode], g.lngs[lastNode]]);

    const speedMph = ROAD_CLASS_SPEEDS[roadClass] ?? 25;
    const speedMs = speedMph * MPH_TO_MS;
    const duration = (distance / speedMs) * 1000;

    return {
      distance,
      duration,
      name: nameIdx >= 0 ? g.names[nameIdx] : '',
      roadClass,
      maneuver: 'straight',
      geometry,
    };
  }

  private computeManeuver(steps: RouteStep[], idx: number): RouteStep['maneuver'] {
    if (idx <= 0 || idx >= steps.length) return 'straight';
    const prev = steps[idx - 1].geometry;
    const curr = steps[idx].geometry;
    if (prev.length < 2 || curr.length < 2) return 'straight';

    const prevBearing = bearing(prev[prev.length - 2], prev[prev.length - 1]);
    const currBearing = bearing(curr[0], curr[1]);

    let angle = currBearing - prevBearing;
    if (angle > 180) angle -= 360;
    if (angle < -180) angle += 360;
    const absAngle = Math.abs(angle);

    if (absAngle < 15) return 'straight';
    if (absAngle >= 160) return 'uturn';
    if (angle > 0) return 'right';
    return 'left';
  }

  private formatResult(result: RouteResult) {
    const geometry = toGeoJSONLineString(result.geometry as Array<[number, number]>);

    const steps = result.steps.map((step, i) => ({
      distance: step.distance,
      duration: step.duration / 1000,
      name: step.name,
      roadClass: step.roadClass,
      maneuver: step.maneuver,
      geometry: step.geometry,
      index: i,
    }));

    const speedLimitsByRoad: Record<string, number> = {};
    for (const step of steps) {
      if (step.name && step.distance > 0 && step.duration > 0) {
        const avgMs = step.distance / step.duration;
        speedLimitsByRoad[step.name] = Math.round(avgMs / MPH_TO_MS);
      }
    }

    return {
      distanceMeters: result.distanceMeters,
      durationSeconds: result.durationMs / 1000,
      geometry,
      steps,
      speedLimitsByRoad,
    };
  }

  // ---------------------------------------------------------------------------
  // Binary graph serialization / deserialization
  // ---------------------------------------------------------------------------

  static saveBinaryGraph(graph: RoutingGraph, outputPath: string): void {
    const parts: Buffer[] = [];
    const writeUint32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); parts.push(b); };
    const writeFloat64 = (v: number) => { const b = Buffer.alloc(8); b.writeDoubleLE(v); parts.push(b); };
    const writeBigInt64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(v); parts.push(b); };
    const writeString = (s: string) => {
      const encoded = Buffer.from(s, 'utf8');
      writeUint32(encoded.length);
      parts.push(encoded);
    };
    const writeAdj = (offsets: Uint32Array, targets: Int32Array, weights: Float64Array,
      distances: Float64Array, flags: Uint8Array, roadClasses: Uint8Array,
      wayIds: BigInt64Array, nameIndices: Int32Array, ec: number, nc: number) => {
      for (let i = 0; i <= nc; i++) writeUint32(offsets[i]);
      for (let i = 0; i < ec; i++) { const b = Buffer.alloc(4); b.writeInt32LE(targets[i]); parts.push(b); }
      for (let i = 0; i < ec; i++) writeFloat64(weights[i]);
      for (let i = 0; i < ec; i++) writeFloat64(distances[i]);
      for (let i = 0; i < ec; i++) { parts.push(Buffer.from([flags[i]])); }
      for (let i = 0; i < ec; i++) { parts.push(Buffer.from([roadClasses[i]])); }
      for (let i = 0; i < ec; i++) writeBigInt64(wayIds[i]);
      for (let i = 0; i < ec; i++) { const b = Buffer.alloc(4); b.writeInt32LE(nameIndices[i]); parts.push(b); }
    };

    writeUint32(graph.nodeCount);
    writeUint32(graph.edgeCount);

    for (let i = 0; i < graph.nodeCount; i++) {
      writeFloat64(graph.lats[i]);
      writeFloat64(graph.lngs[i]);
      writeBigInt64(graph.nodeIds[i]);
    }

    writeAdj(graph.forwardOffsets, graph.forwardTargets, graph.forwardWeights, graph.forwardDistances,
      graph.forwardFlags, graph.forwardRoadClasses, graph.forwardWayIds, graph.forwardNameIndices,
      graph.edgeCount, graph.nodeCount);
    writeAdj(graph.backwardOffsets, graph.backwardTargets, graph.backwardWeights, graph.backwardDistances,
      graph.backwardFlags, graph.backwardRoadClasses, graph.backwardWayIds, graph.backwardNameIndices,
      graph.edgeCount, graph.nodeCount);

    writeUint32(graph.names.length);
    for (const name of graph.names) writeString(name);

    const buf = Buffer.concat(parts);
    fs.writeFileSync(outputPath, buf);
    logger.info({ path: outputPath, sizeMB: (buf.length / 1024 / 1024).toFixed(1) }, 'routing_graph_saved');
  }

  static loadBinaryGraph(graphPath: string): RoutingGraph {
    const start = Date.now();
    const buffer = fs.readFileSync(graphPath);
    let offset = 0;

    const readUint32 = () => { const v = buffer.readUInt32LE(offset); offset += 4; return v; };
    const readFloat64 = () => { const v = buffer.readDoubleLE(offset); offset += 8; return v; };
    const readBigInt64 = () => { const v = buffer.readBigInt64LE(offset); offset += 8; return v; };
    const readInt32 = () => { const v = buffer.readInt32LE(offset); offset += 4; return v; };
    const readUint8 = () => { const v = buffer.readUInt8(offset); offset += 1; return v; };
    const readString = () => {
      const len = readUint32();
      const str = buffer.toString('utf8', offset, offset + len);
      offset += len;
      return str;
    };

    const nodeCount = readUint32();
    const edgeCount = readUint32();

    const lats = new Float64Array(nodeCount);
    const lngs = new Float64Array(nodeCount);
    const nodeIds = new BigInt64Array(nodeCount);

    for (let i = 0; i < nodeCount; i++) {
      lats[i] = readFloat64();
      lngs[i] = readFloat64();
      nodeIds[i] = readBigInt64();
    }

    const readAdj = (ec: number) => {
      const offsets = new Uint32Array(nodeCount + 1);
      for (let i = 0; i <= nodeCount; i++) offsets[i] = readUint32();
      const targets = new Int32Array(ec);
      for (let i = 0; i < ec; i++) targets[i] = readInt32();
      const weights = new Float64Array(ec);
      for (let i = 0; i < ec; i++) weights[i] = readFloat64();
      const distances = new Float64Array(ec);
      for (let i = 0; i < ec; i++) distances[i] = readFloat64();
      const flags = new Uint8Array(ec);
      for (let i = 0; i < ec; i++) flags[i] = readUint8();
      const roadClasses = new Uint8Array(ec);
      for (let i = 0; i < ec; i++) roadClasses[i] = readUint8();
      const wayIds = new BigInt64Array(ec);
      for (let i = 0; i < ec; i++) wayIds[i] = readBigInt64();
      const nameIndices = new Int32Array(ec);
      for (let i = 0; i < ec; i++) nameIndices[i] = readInt32();
      return { offsets, targets, weights, distances, flags, roadClasses, wayIds, nameIndices };
    };

    const fwd = readAdj(edgeCount);
    const bwd = readAdj(edgeCount);

    const nameCount = readUint32();
    const names: string[] = [];
    for (let i = 0; i < nameCount; i++) names.push(readString());

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    logger.info({ nodeCount, edgeCount, elapsedSeconds: elapsed }, 'routing_graph_loaded');

    return {
      nodeCount, edgeCount,
      lats, lngs, nodeIds, names,
      forwardTargets: fwd.targets, forwardWeights: fwd.weights, forwardDistances: fwd.distances,
      forwardFlags: fwd.flags, forwardRoadClasses: fwd.roadClasses,
      forwardWayIds: fwd.wayIds, forwardNameIndices: fwd.nameIndices, forwardOffsets: fwd.offsets,
      backwardTargets: bwd.targets, backwardWeights: bwd.weights, backwardDistances: bwd.distances,
      backwardFlags: bwd.flags, backwardRoadClasses: bwd.roadClasses,
      backwardWayIds: bwd.wayIds, backwardNameIndices: bwd.nameIndices, backwardOffsets: bwd.offsets,
    };
  }
}

export const astarEngine = AStarEngine.getInstance();
