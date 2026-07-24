// backend/src/routing/graph/graph-builder.ts
//
// Constructs a RoutingGraph from parsed OSM data. Manages node ID mapping,
// edge deduplication, and builds flat adjacency arrays.
// Weight = travel time in SECONDS (not ms) for A* time-based routing.

import { RoadClass, ROAD_CLASS_SPEEDS, RoutingGraph, AdjacencyList } from './types';

const MPH_TO_MS = 0.44704;

export interface OSMNode {
  id: bigint;
  lat: number;
  lng: number;
}

export interface OSMWay {
  id: bigint;
  nodeIds: bigint[];
  tags: Record<string, string>;
}

export function classifyRoad(highway: string): RoadClass {
  switch (highway) {
    case 'motorway':        return RoadClass.MOTORWAY;
    case 'trunk':           return RoadClass.TRUNK;
    case 'primary':         return RoadClass.PRIMARY;
    case 'secondary':       return RoadClass.SECONDARY;
    case 'tertiary':        return RoadClass.TERTIARY;
    case 'unclassified':    return RoadClass.UNCLASSIFIED;
    case 'residential':     return RoadClass.RESIDENTIAL;
    case 'service':         return RoadClass.SERVICE;
    case 'living_street':   return RoadClass.LIVING_STREET;
    default:                return RoadClass.UNKNOWN;
  }
}

export function isDrivable(highway: string): boolean {
  const drivable = new Set([
    'motorway', 'motorway_link', 'trunk', 'trunk_link',
    'primary', 'primary_link', 'secondary', 'secondary_link',
    'tertiary', 'tertiary_link', 'unclassified', 'residential',
    'service', 'living_street',
  ]);
  return drivable.has(highway);
}

export function shouldExcludeWay(tags: Record<string, string>): boolean {
  if (tags.access === 'private' || tags.access === 'no') return true;
  if (tags.motorway === 'no') return true;
  if (tags.construction) return true;
  return false;
}

function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function speedForRoad(roadClass: RoadClass, maxspeed?: string): number {
  if (maxspeed) {
    const parsed = parseInt(maxspeed, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return ROAD_CLASS_SPEEDS[roadClass] ?? 25;
}

export class GraphBuilder {
  private nodeIdMap = new Map<bigint, number>();
  private lats: number[] = [];
  private lngs: number[] = [];
  private osmNodeIds: bigint[] = [];
  private forwardEdges: Array<{
    from: number; to: number; distance: number; weight: number;
    flags: number; roadClass: RoadClass; wayId: bigint; nameIdx: number;
  }> = [];
  private names: string[] = [];
  private nameIdxMap = new Map<string, number>();
  private nextNodeId = 0;

  addNode(id: bigint, lat: number, lng: number): number {
    let idx = this.nodeIdMap.get(id);
    if (idx !== undefined) return idx;
    idx = this.nextNodeId++;
    this.nodeIdMap.set(id, idx);
    this.lats.push(lat);
    this.lngs.push(lng);
    this.osmNodeIds.push(id);
    return idx;
  }

  addWay(way: OSMWay): void {
    const tags = way.tags;
    const highway = tags.highway;
    if (!highway || !isDrivable(highway) || shouldExcludeWay(tags)) return;

    const roadClass = classifyRoad(highway);
    const speedMph = speedForRoad(roadClass, tags.maxspeed);
    const speedMs = speedMph * MPH_TO_MS;
    const name = tags.name ?? '';
    const nameIdx = this.getOrAddName(name);

    const isOneway = tags.oneway === 'yes' || tags.oneway === '1' ||
      (highway === 'motorway' && tags.oneway !== 'no') ||
      (highway === 'motorway_link' && tags.oneway !== 'no');

    const isRoundabout = tags.roundabout === 'yes';
    const nodeIds = way.nodeIds;

    for (let i = 0; i < nodeIds.length - 1; i++) {
      const fromOsmId = nodeIds[i];
      const toOsmId = nodeIds[i + 1];
      const fromIdx = this.addNode(fromOsmId, 0, 0);
      const toIdx = this.addNode(toOsmId, 0, 0);

      let flags = 0;
      if (roadClass === RoadClass.MOTORWAY) flags |= EdgeFlagsBit.MOTORWAY;
      if (tags.toll === 'yes') flags |= EdgeFlagsBit.TOLL;
      if (isRoundabout) flags |= EdgeFlagsBit.ROUNDABOUT;
      if (tags.bridge === 'yes') flags |= EdgeFlagsBit.BRIDGE;
      if (tags.tunnel === 'yes') flags |= EdgeFlagsBit.TUNNEL;

      const edgeData = {
        fromIdx, toIdx, distance: 0, weight: 0,
        flags, roadClass, wayId: way.id, nameIdx,
      };

      this.forwardEdges.push({
        from: edgeData.fromIdx, to: edgeData.toIdx,
        distance: 0, weight: 0,
        flags: edgeData.flags, roadClass: edgeData.roadClass,
        wayId: edgeData.wayId, nameIdx: edgeData.nameIdx,
      });

      if (!isOneway) {
        this.forwardEdges.push({
          from: edgeData.toIdx, to: edgeData.fromIdx,
          distance: 0, weight: 0,
          flags: edgeData.flags, roadClass: edgeData.roadClass,
          wayId: edgeData.wayId, nameIdx: edgeData.nameIdx,
        });
      }
    }
  }

  private getOrAddName(name: string): number {
    if (!name) return -1;
    let idx = this.nameIdxMap.get(name);
    if (idx !== undefined) return idx;
    idx = this.names.length;
    this.names.push(name);
    this.nameIdxMap.set(name, idx);
    return idx;
  }

  build(): RoutingGraph {
    const n = this.lats.length;

    const nodeLats = new Float64Array(n);
    const nodeLngs = new Float64Array(n);
    const nodeIds = new BigInt64Array(n);
    for (let i = 0; i < n; i++) {
      nodeLats[i] = this.lats[i];
      nodeLngs[i] = this.lngs[i];
      nodeIds[i] = this.osmNodeIds[i];
    }

    // Compute distances and weights now that all nodes have coordinates
    for (const e of this.forwardEdges) {
      e.distance = haversineDistance(
        this.lats[e.from], this.lngs[e.from],
        this.lats[e.to], this.lngs[e.to],
      );
      if (e.distance < 1 || !Number.isFinite(e.distance)) {
        e.distance = 0;
        e.weight = 0;
        continue;
      }
      const speedMs = (ROAD_CLASS_SPEEDS[e.roadClass] ?? 25) * MPH_TO_MS;
      e.weight = e.distance / speedMs;
    }

    // Filter out zero-weight edges
    const validEdges = this.forwardEdges.filter(e => e.weight > 0);

    const forward = this.buildAdjacency(n, validEdges);
    const backwardEdges = validEdges.map(e => ({
      from: e.to, to: e.from, distance: e.distance, weight: e.weight,
      flags: e.flags, roadClass: e.roadClass, wayId: e.wayId, nameIdx: e.nameIdx,
    }));
    const backward = this.buildAdjacency(n, backwardEdges);

    return {
      nodeCount: n,
      edgeCount: validEdges.length,
      lats: nodeLats, lngs: nodeLngs, nodeIds,
      forwardTargets: forward.targets, forwardWeights: forward.weights,
      forwardDistances: forward.distances, forwardFlags: forward.flags,
      forwardRoadClasses: forward.roadClasses, forwardWayIds: forward.wayIds,
      forwardNameIndices: forward.nameIndices, forwardOffsets: forward.offsets,
      backwardTargets: backward.targets, backwardWeights: backward.weights,
      backwardDistances: backward.distances, backwardFlags: backward.flags,
      backwardRoadClasses: backward.roadClasses, backwardWayIds: backward.wayIds,
      backwardNameIndices: backward.nameIndices, backwardOffsets: backward.offsets,
      names: this.names,
    };
  }

  private buildAdjacency(n: number, edges: Array<{
    from: number; to: number; distance: number; weight: number;
    flags: number; roadClass: RoadClass; wayId: bigint; nameIdx: number;
  }>): AdjacencyList {
    const counts = new Uint32Array(n);
    for (const e of edges) counts[e.from]++;

    const offsets = new Uint32Array(n + 1);
    let total = 0;
    for (let i = 0; i < n; i++) {
      offsets[i] = total;
      total += counts[i];
    }
    offsets[n] = total;

    const targets = new Int32Array(total);
    const weights = new Float64Array(total);
    const distances = new Float64Array(total);
    const flags = new Uint8Array(total);
    const roadClasses = new Uint8Array(total);
    const wayIds = new BigInt64Array(total);
    const nameIndices = new Int32Array(total);

    const pos = new Uint32Array(n);
    for (const e of edges) {
      const slot = offsets[e.from] + pos[e.from]++;
      targets[slot] = e.to;
      weights[slot] = e.weight;
      distances[slot] = e.distance;
      flags[slot] = e.flags;
      roadClasses[slot] = e.roadClass;
      wayIds[slot] = e.wayId;
      nameIndices[slot] = e.nameIdx;
    }

    return { targets, weights, distances, flags, roadClasses, wayIds, nameIndices, offsets };
  }

  getNodeCount(): number { return this.lats.length; }
  getEdgeCount(): number { return this.forwardEdges.length; }
}

const enum EdgeFlagsBit {
  ONE_WAY = 1 << 0,
  MOTORWAY = 1 << 1,
  TOLL = 1 << 2,
  ROUNDABOUT = 1 << 4,
  BRIDGE = 1 << 5,
  TUNNEL = 1 << 6,
}
