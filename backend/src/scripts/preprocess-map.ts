// backend/src/scripts/preprocess-map.ts
//
// Preprocessing script for building A* routing graphs from OSM PBF files.
// Usage: npx ts-node src/scripts/preprocess-map.ts <pbf-path> [output-path]

import * as path from 'path';
import { GraphBuilder } from '../routing/graph/graph-builder';
import { parsePBF } from '../routing/preprocessing/pbf-parser';
import { AStarEngine } from '../routing/engine/astar-engine';
import { logger } from '../observability/logger';

async function main() {
  const pbfPath = process.argv[2];
  const outputPath = process.argv[3] ?? path.join(__dirname, '../../data/routing-graph.bin');

  if (!pbfPath) {
    console.error('Usage: npx ts-node src/scripts/preprocess-map.ts <pbf-path> [output-path]');
    console.error('');
    console.error('Example:');
    console.error('  npx ts-node src/scripts/preprocess-map.ts ./data/LosAngeles.osm.pbf');
    process.exit(1);
  }

  const absolutePbfPath = path.resolve(pbfPath);
  const absoluteOutputPath = path.resolve(outputPath);

  logger.info({ pbfPath: absolutePbfPath, outputPath: absoluteOutputPath }, 'preprocess_start');

  const start = Date.now();

  // Step 1: Parse PBF
  logger.info('step1_parse_pbf');
  const { nodes, ways } = parsePBF(absolutePbfPath);
  logger.info({ nodes: nodes.length, ways: ways.length }, 'pbf_parsed');

  // Step 2: Build graph
  logger.info('step2_build_graph');
  const builder = new GraphBuilder();
  for (const way of ways) {
    builder.addWay(way);
  }
  for (const node of nodes) {
    builder.addNode(node.id, node.lat, node.lng);
  }
  const graph = builder.build();
  logger.info({ nodes: graph.nodeCount, edges: graph.edgeCount }, 'graph_built');

  // Step 3: Save to disk
  logger.info('step3_save_graph');
  const dir = path.dirname(absoluteOutputPath);
  const fs = require('fs');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  AStarEngine.saveBinaryGraph(graph, absoluteOutputPath);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const sizeMB = (fs.statSync(absoluteOutputPath).size / 1024 / 1024).toFixed(1);

  console.log(`\nPreprocessing complete!`);
  console.log(`  Nodes: ${graph.nodeCount.toLocaleString()}`);
  console.log(`  Edges: ${graph.edgeCount.toLocaleString()}`);
  console.log(`  Output: ${absoluteOutputPath} (${sizeMB} MB)`);
  console.log(`  Time: ${elapsed}s`);
  console.log(`\nTo use this graph, set ROUTING_GRAPH_PATH in your .env:`);
  console.log(`  ROUTING_GRAPH_PATH=${absoluteOutputPath}`);
}

main().catch((err) => {
  logger.error({ err: err.message }, 'preprocess_failed');
  process.exit(1);
});
