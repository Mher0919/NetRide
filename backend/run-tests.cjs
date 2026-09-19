// backend/run-tests.cjs
// Runs the routing unit tests through ts-node in CommonJS mode (no native
// TS stripping, no ESM extension requirement). Usage: node run-tests.cjs
//
// Point REDIS_URL at localhost so the test process doesn't try to resolve
// the production Render Redis host (which would spam connection errors and
// hang). The routing service degrades gracefully to cache-miss when Redis
// is unreachable, so every test still passes offline.
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
// Many required modules pull `io` from app.ts, which boots the HTTP server
// at require time. Bind to an ephemeral port so a concurrently running dev
// server on :3000 doesn't blow up the test process with EADDRINUSE.
process.env.PORT = '0';
require('ts-node').register({
  transpileOnly: true,
  compilerOptions: { module: 'commonjs', esModuleInterop: true },
});
require('./src/modules/routing/__tests__/routing.unit.test.ts');
require('./src/modules/rewards/__tests__/rewards.unit.test.ts');
require('./src/modules/ride/__tests__/ride-cancellation.unit.test.ts');
require('./src/modules/referral/__tests__/referral-onboarding.unit.test.ts');
require('./src/modules/credits/__tests__/credits-cap.unit.test.ts');
require('./src/modules/wallet/__tests__/wallet-cap.unit.test.ts');
require('./src/modules/heatmap/__tests__/demand.unit.test.ts');
require('./src/modules/notifications/__tests__/notifications.unit.test.ts');
require('./src/services/__tests__/pricing.unit.test.ts');
require('./src/services/__tests__/financial-ledger.unit.test.ts');
require('./src/services/__tests__/ride-rejection.unit.test.ts');
require('./src/modules/reporting/__tests__/report-reasons.unit.test.ts');
require('./src/modules/sponsor/__tests__/sponsor-discount.unit.test.ts');
require('./src/modules/sponsor/__tests__/sponsor-auth.unit.test.ts');
require('./src/modules/sponsor/__tests__/forgot-password.unit.test.ts');
require('./src/modules/portal/__tests__/portal-2fa.unit.test.ts');
require('./src/modules/auth/__tests__/otp.unit.test.ts');
require('./src/modules/auth/__tests__/auth-enumeration.unit.test.ts');

// ioredis keeps the event loop alive while retrying a dead host; force a
// clean exit once the test run finishes.
setTimeout(() => process.exit(0), 500).unref();
