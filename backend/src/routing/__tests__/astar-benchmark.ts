// backend/src/routing/__tests__/astar-benchmark.ts
//
// Performance benchmarks for the A* routing engine.
//
// Usage: npx ts-node src/routing/__tests__/astar-benchmark.ts

import { astarEngine } from '../engine/astar-engine';
import { calculateETA } from '../utils/eta';
import { LRUCache, RouteCache } from '../utils/cache';

const LA_COORDS: Array<[number, number]> = [
  [34.0522, -118.2437],
  [34.0907, -118.2740],
  [34.0195, -118.4912],
  [33.9425, -118.4081],
  [34.1478, -118.1445],
  [34.0259, -118.3965],
  [33.7701, -118.1937],
  [34.1808, -118.3090],
  [34.0561, -118.2365],
  [34.1017, -118.3426],
];

async function benchmarkRoutingLatency(): Promise<void> {
  console.log('\n=== Routing Latency Benchmark ===\n');
  const iterations = 1000;
  const latencies: number[] = [];
  const pairs: Array<[[number, number], [number, number]]> = [];
  for (let i = 0; i < iterations; i++) {
    const a = LA_COORDS[Math.floor(Math.random() * LA_COORDS.length)];
    const b = LA_COORDS[Math.floor(Math.random() * LA_COORDS.length)];
    pairs.push([a, b]);
  }
  const start = Date.now();
  for (const [origin, dest] of pairs) {
    const reqStart = process.hrtime.bigint();
    await astarEngine.route(origin, dest);
    latencies.push(Number(process.hrtime.bigint() - reqStart) / 1e6);
  }
  const totalTime = Date.now() - start;
  latencies.sort((a, b) => a - b);
  console.log(`Iterations: ${iterations}`);
  console.log(`Routes/sec: ${(iterations / totalTime * 1000).toFixed(0)}`);
  console.log(`P50: ${latencies[Math.floor(latencies.length * 0.5)].toFixed(2)}ms`);
  console.log(`P95: ${latencies[Math.floor(latencies.length * 0.95)].toFixed(2)}ms`);
  console.log(`P99: ${latencies[Math.floor(latencies.length * 0.99)].toFixed(2)}ms`);
}

async function benchmarkETACalculation(): Promise<void> {
  console.log('\n=== ETA Calculation Benchmark ===\n');
  const iterations = 100000;
  const start = Date.now();
  for (let i = 0; i < iterations; i++) {
    calculateETA({
      distanceMeters: 1000 + Math.random() * 10000,
      roadClass: Math.floor(Math.random() * 10) as any,
      timeOfDay: Math.floor(Math.random() * 24),
      turnCount: Math.floor(Math.random() * 5),
    });
  }
  console.log(`Avg per calc: ${((Date.now() - start) / iterations * 1000).toFixed(1)}us`);
}

function benchmarkMemoryUsage(): void {
  console.log('\n=== Memory Usage ===\n');
  const mem = process.memoryUsage();
  console.log(`RSS: ${(mem.rss / 1024 / 1024).toFixed(1)} MB`);
  console.log(`Heap Used: ${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB`);
  const stats = astarEngine.stats();
  if (stats.loaded) {
    console.log(`Graph: ${stats.nodes} nodes, ${stats.edges} edges`);
  }
}

async function main() {
  console.log('A* Routing Engine Benchmark Suite');
  console.log('==================================');
  try {
    await benchmarkETACalculation();
    benchmarkMemoryUsage();
    if (astarEngine.isReady()) {
      await benchmarkRoutingLatency();
    } else {
      console.log('\nA* engine not loaded — set ROUTING_GRAPH_PATH to a valid graph file.');
    }
  } catch (err: any) {
    console.error('Benchmark failed:', err.message);
  }
}

main();
