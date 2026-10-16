// tests/helpers/run-ts.cjs
// Generic runner for the standalone TypeScript scripts under tests/
// (benchmarks, smoke scripts). Registers ts-node with the backend's config
// and requires the target file, so test tooling does not live inside the
// backend source tree.
//
// Usage (from backend/):
//   npm run bench:routing
//   npm run bench:astar
//   npm run smoke:profile
// Or directly from the repo root:
//   node tests/helpers/run-ts.cjs unit/backend/modules/routing/benchmark.routing.ts
const path = require('path');

const BACKEND_DIR = path.resolve(__dirname, '..', '..', 'backend');
const target = process.argv[2];

if (!target) {
  console.error('usage: node tests/helpers/run-ts.cjs <file relative to tests/>');
  process.exit(2);
}

require(path.join(BACKEND_DIR, 'node_modules', 'dotenv')).config({
  path: path.join(BACKEND_DIR, '.env'),
});

// Backend dev dependencies (axios, pg, …) live in backend/node_modules.
process.env.NODE_PATH = path.join(BACKEND_DIR, 'node_modules');
require('module').Module._initPaths();

process.env.REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
process.env.PORT = process.env.PORT || '0';

require(path.join(BACKEND_DIR, 'node_modules', 'ts-node')).register({
  dir: BACKEND_DIR,
  transpileOnly: true,
  compilerOptions: { module: 'commonjs', esModuleInterop: true },
});

require(path.resolve(__dirname, '..', target));
