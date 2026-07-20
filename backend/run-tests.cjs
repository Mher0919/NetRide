// backend/run-tests.cjs
// Runs the routing unit tests through ts-node in CommonJS mode (no native
// TS stripping, no ESM extension requirement). Usage: node run-tests.cjs
require('ts-node').register({
  transpileOnly: true,
  compilerOptions: { module: 'commonjs', esModuleInterop: true },
});
require('./src/modules/routing/__tests__/routing.unit.test.ts');
