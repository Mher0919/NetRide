// backend/src/routing/preprocessing/pbf-parser.ts
//
// Optimized OSM PBF parser for A* routing.
// Two-pass approach: first collect referenced node IDs from drivable ways,
// then read only those nodes. Skips all unnecessary data.

import * as fs from 'fs';
import * as zlib from 'zlib';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PbfReader } = require('pbf');
import { OSMNode, OSMWay } from '../graph/graph-builder';

// LA bounding box
const BBOX = { south: 33.5, west: -119.0, north: 34.5, east: -117.5 };

const DRIVABLE_HIGHWAYS = new Set([
  'motorway', 'motorway_link', 'trunk', 'trunk_link',
  'primary', 'primary_link', 'secondary', 'secondary_link',
  'tertiary', 'tertiary_link', 'unclassified', 'residential',
  'service', 'living_street',
]);

interface BlobInfo {
  type: string;
  size: number;
}

function readBlobInfo(buf: Buffer): BlobInfo {
  const pbf = new PbfReader(buf);
  const r: BlobInfo = { type: '', size: 0 };
  let f: number | false;
  while ((f = pbf.nextField()) !== false) {
    if (f === 1) r.type = pbf.readString();
    else if (f === 3) r.size = pbf.readVarint();
    else pbf.skip(f);
  }
  return r;
}

interface ParsedBlock {
  stringTable: string[];
  ways: Array<{ id: number; refs: number[]; tags: Record<string, string> }>;
  denseNodes: Map<number, { lat: number; lng: number }>;
  granularity: number;
  latOffset: number;
  lonOffset: number;
}

function parseOSMDataBlock(data: Buffer): ParsedBlock {
  const pbf = new PbfReader(data);
  const result: ParsedBlock = {
    stringTable: [],
    ways: [],
    denseNodes: new Map(),
    granularity: 100,
    latOffset: 0,
    lonOffset: 0,
  };

  let f: number | false;
  while ((f = pbf.nextField()) !== false) {
    switch (f) {
      case 1: {
        // String table
        const stPbf = new PbfReader(pbf.readBytes());
        const strings: string[] = [];
        let sf: number | false;
        while ((sf = stPbf.nextField()) !== false) {
          if (sf === 1) strings.push(stPbf.readString());
          else stPbf.skip(sf);
        }
        result.stringTable = strings;
        break;
      }
      case 2: {
        // Primitive group
        const grp = new PbfReader(pbf.readBytes());
        let gf: number | false;
        while ((gf = grp.nextField()) !== false) {
          if (gf === 1) {
            // Regular nodes — skip (we only need dense nodes)
            grp.skip(gf);
          } else if (gf === 2) {
            // Dense nodes
            const dnPbf = new PbfReader(grp.readBytes());
            let id = 0, lat = 0, lon = 0;
            let df: number | false;
            while ((df = dnPbf.nextField()) !== false) {
              switch (df) {
                case 1: id += dnPbf.readVarint(); break;
                case 2: lat += dnPbf.readSVarint(); break;
                case 3: lon += dnPbf.readSVarint(); break;
                case 4: dnPbf.skip(df); break; // dense info
                case 5: dnPbf.skip(df); break; // tags — skip
                default: dnPbf.skip(df); break;
              }
              // Emit node on id delta
              if (df === 1) {
                const finalLat = (lat + result.latOffset) / result.granularity;
                const finalLon = (lon + result.lonOffset) / result.granularity;
                result.denseNodes.set(id, { lat: finalLat, lng: finalLon });
              }
            }
          } else if (gf === 3) {
            // Way
            const wayPbf = new PbfReader(grp.readBytes());
            let wayId = 0;
            const refs: number[] = [];
            const tagPairs: Array<[number, number]> = [];
            let lastRef = 0;
            let wf: number | false;
            while ((wf = wayPbf.nextField()) !== false) {
              switch (wf) {
                case 1: wayId = wayPbf.readVarint(); break;
                case 2: refs.push(lastRef += wayPbf.readSVarint()); break;
                case 3: {
                  // Tag indices (key_idx, val_idx pairs)
                  const tagPbf = new PbfReader(wayPbf.readBytes());
                  const keys: number[] = [];
                  const vals: number[] = [];
                  let tf: number | false;
                  while ((tf = tagPbf.nextField()) !== false) {
                    if (tf === 1) keys.push(tagPbf.readVarint());
                    else if (tf === 2) vals.push(tagPbf.readVarint());
                    else tagPbf.skip(tf);
                  }
                  for (let i = 0; i < keys.length; i++) {
                    tagPairs.push([keys[i], vals[i]]);
                  }
                  break;
                }
                default: wayPbf.skip(wf); break;
              }
            }
            // Resolve tags using string table
            const tags: Record<string, string> = {};
            for (const [ki, vi] of tagPairs) {
              tags[result.stringTable[ki] ?? String(ki)] = result.stringTable[vi] ?? String(vi);
            }
            result.ways.push({ id: wayId, refs, tags });
          } else {
            grp.skip(gf);
          }
        }
        break;
      }
      case 17: result.granularity = pbf.readVarint(); break;
      case 18: result.latOffset = pbf.readSVarint(); break;
      case 19: result.lonOffset = pbf.readSVarint(); break;
      default: pbf.skip(f); break;
    }
  }
  return result;
}

/**
 * Parse an OSM PBF file for A* routing graph building.
 * Two-pass approach for memory efficiency with large files.
 */
export function parsePBF(filePath: string): { nodes: OSMNode[]; ways: OSMWay[] } {
  const start = Date.now();
  const fd = fs.openSync(filePath, 'r');
  const stat = fs.statSync(filePath);
  const { logger } = require('../../observability/logger');

  // PASS 1: Collect referenced node IDs from drivable ways
  logger.info('pbf_pass1_collecting_referenced_nodes');
  const referencedNodeIds = new Set<number>();
  const wayData: Array<{ id: number; nodeIds: bigint[]; tags: Record<string, string> }> = [];
  let offset = 0;

  while (offset < stat.size) {
    if (offset + 4 > stat.size) break;
    const hBuf = Buffer.alloc(4);
    fs.readSync(fd, hBuf, 0, 4, offset); offset += 4;
    const hLen = hBuf.readUInt32BE(0);
    if (hLen === 0 || offset + hLen > stat.size) break;
    const hData = Buffer.alloc(hLen);
    fs.readSync(fd, hData, 0, hLen, offset); offset += hLen;
    const bh = readBlobInfo(hData);
    if (bh.size === 0 || offset + bh.size > stat.size) break;
    const bData = Buffer.alloc(bh.size);
    fs.readSync(fd, bData, 0, bh.size, offset); offset += bh.size;

    let decompressed: Buffer | undefined;
    const bp = new PbfReader(bData);
    let bf: number | false;
    while ((bf = bp.nextField()) !== false) {
      if (bf === 1) { decompressed = zlib.inflateSync(bp.readBytes()); break; }
      else if (bf === 3) { decompressed = bp.readBytes(); break; }
      else bp.skip(bf);
    }
    if (!decompressed) continue;

    if (bh.type === 'OSMData') {
      const block = parseOSMDataBlock(decompressed);
      for (const w of block.ways) {
        const hw = w.tags.highway;
        if (!hw || !DRIVABLE_HIGHWAYS.has(hw)) continue;
        if (w.tags.access === 'private' || w.tags.access === 'no') continue;
        if (w.tags.construction) continue;

        wayData.push({
          id: w.id,
          nodeIds: w.refs.map(r => BigInt(r)),
          tags: w.tags,
        });
        for (const nid of w.refs) referencedNodeIds.add(nid);
      }
    }
  }

  logger.info({ ways: wayData.length, refNodes: referencedNodeIds.size }, 'pbf_pass1_done');

  // PASS 2: Read only referenced nodes
  logger.info('pbf_pass2_reading_nodes');
  const nodeMap = new Map<number, { lat: number; lng: number }>();
  offset = 0;

  while (offset < stat.size) {
    if (offset + 4 > stat.size) break;
    const hBuf = Buffer.alloc(4);
    fs.readSync(fd, hBuf, 0, 4, offset); offset += 4;
    const hLen = hBuf.readUInt32BE(0);
    if (hLen === 0 || offset + hLen > stat.size) break;
    const hData = Buffer.alloc(hLen);
    fs.readSync(fd, hData, 0, hLen, offset); offset += hLen;
    const bh = readBlobInfo(hData);
    if (bh.size === 0 || offset + bh.size > stat.size) break;
    const bData = Buffer.alloc(bh.size);
    fs.readSync(fd, bData, 0, bh.size, offset); offset += bh.size;

    let decompressed: Buffer | undefined;
    const bp = new PbfReader(bData);
    let bf: number | false;
    while ((bf = bp.nextField()) !== false) {
      if (bf === 1) { decompressed = zlib.inflateSync(bp.readBytes()); break; }
      else if (bf === 3) { decompressed = bp.readBytes(); break; }
      else bp.skip(bf);
    }
    if (!decompressed) continue;

    if (bh.type === 'OSMData') {
      const block = parseOSMDataBlock(decompressed);
      for (const [id, coords] of block.denseNodes) {
        if (referencedNodeIds.has(id)) {
          nodeMap.set(id, coords);
        }
      }
    }
  }

  fs.closeSync(fd);

  const allNodes: OSMNode[] = [];
  for (const [id, coords] of nodeMap) {
    allNodes.push({ id: BigInt(id), lat: coords.lat, lng: coords.lng });
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  logger.info({ nodes: allNodes.length, ways: wayData.length, elapsedSeconds: elapsed }, 'pbf_parse_complete');

  return { nodes: allNodes, ways: wayData.map(w => ({ id: BigInt(w.id), nodeIds: w.nodeIds, tags: w.tags })) };
}
