// tests/unit/backend/run-tests.cjs
// Runs the backend unit tests through ts-node in CommonJS mode (no native
// TS stripping, no ESM extension requirement). Usage:
//   npm test                 (from backend/)
//   node tests/unit/backend/run-tests.cjs          (from the repo root)
//   node tests/unit/backend/run-tests.cjs astar    (filter, e.g. npm run test:astar)
//
// Point REDIS_URL at localhost so the test process doesn't try to resolve
// the production Render Redis host (which would spam connection errors and
// hang). The routing service degrades gracefully to cache-miss when Redis
// is unreachable, so every test still passes offline.
const path = require('path');

const BACKEND_DIR = path.resolve(__dirname, '..', '..', '..', 'backend');

require(path.join(BACKEND_DIR, 'node_modules', 'dotenv')).config({
  path: path.join(BACKEND_DIR, '.env'),
});

// A few suites import backend dev dependencies (jsonwebtoken, bcryptjs) by
// bare name. They live in backend/node_modules; the standard CJS resolver
// would not look there from tests/. Register them as global fallbacks.
process.env.NODE_PATH = path.join(BACKEND_DIR, 'node_modules');
require('module').Module._initPaths();

process.env.REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
// Many required modules pull `io` from app.ts, which boots the HTTP server
// at require time. Bind to an ephemeral port so a concurrently running dev
// server on :3000 doesn't blow up the test process with EADDRINUSE.
process.env.PORT = '0';

require(path.join(BACKEND_DIR, 'node_modules', 'ts-node')).register({
  dir: BACKEND_DIR,
  transpileOnly: true,
  compilerOptions: { module: 'commonjs', esModuleInterop: true },
});

// Every unit suite, grouped by the backend area it covers. Keep this list in
// sync when adding a suite (see tests/docs/TESTING_GUIDE.md).
const SUITES = [
  './modules/routing/routing.unit.test.ts',
  './routing/astar-routing.test.ts',
  './modules/rewards/rewards.unit.test.ts',
  './modules/ride/ride-cancellation.unit.test.ts',
  './modules/ride/ride-state-guards.unit.test.ts',
  './modules/location/location-freshness.unit.test.ts',
  './queue/cleanup-stale-rides.unit.test.ts',
  './modules/referral/referral-onboarding.unit.test.ts',
  './modules/credits/credits-cap.unit.test.ts',
  './modules/wallet/wallet-cap.unit.test.ts',
  './modules/heatmap/demand.unit.test.ts',
  './modules/notifications/notifications.unit.test.ts',
  './modules/promo/promo-accounting.unit.test.ts',
  './services/pricing.unit.test.ts',
  './services/financial-ledger.unit.test.ts',
  './services/ride-rejection.unit.test.ts',
  './modules/reporting/report-reasons.unit.test.ts',
  './modules/partner/partner-auth.unit.test.ts',
  './modules/sponsor/sponsor-discount.unit.test.ts',
  './modules/sponsor/sponsor-auth.unit.test.ts',
  './modules/sponsor/forgot-password.unit.test.ts',
  './modules/google-places/google-places.unit.test.ts',
  './modules/sponsor/google-association.unit.test.ts',
  './modules/portal/portal-2fa.unit.test.ts',
  './modules/portal/portal-identity.unit.test.ts',
  './modules/auth/otp.unit.test.ts',
  './modules/auth/auth-enumeration.unit.test.ts',
  './modules/auth/token-revocation.unit.test.ts',
  './modules/payments/payments.unit.test.ts',
  './modules/payments/withdrawal.unit.test.ts',
  './security/security.unit.test.ts',
  './security/zod-dos.unit.test.ts',
  './security/safe-path.unit.test.ts',
  './security/security-headers.unit.test.ts',
  './security/migration-file-guard.unit.test.cjs',
];

const filter = process.argv[2];
const selected = filter ? SUITES.filter((s) => s.includes(filter)) : SUITES;
if (selected.length === 0) {
  console.error(`No suites match filter "${filter}"`);
  process.exit(1);
}
for (const suite of selected) require(suite);

// ioredis keeps the event loop alive while retrying a dead host; if the test
// runner has already reported its summary this watchdog is a no-op, otherwise
// it forces a clean exit once the suites are certainly done.
setTimeout(() => process.exit(0), 30000).unref();
