// backend/run-tests.cjs
// Runs the routing unit tests through ts-node in CommonJS mode (no native
// TS stripping, no ESM extension requirement). Usage: node run-tests.cjs
//
// Point REDIS_URL at localhost so the test process doesn't try to resolve
// the production Render Redis host (which would spam connection errors and
// hang). The routing service degrades gracefully to cache-miss when Redis
// is unreachable, so every test still passes offline.
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
require('ts-node').register({
  transpileOnly: true,
  compilerOptions: { module: 'commonjs', esModuleInterop: true },
});
require('./src/modules/routing/__tests__/routing.unit.test.ts');

// ioredis keeps the event loop alive while retrying a dead host; force a
// clean exit once the test run finishes.
setTimeout(() => process.exit(0), 500).unref();
