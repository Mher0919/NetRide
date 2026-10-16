# NetRide Test Suite

Single home for NetRide's automated and manual test tooling: backend unit
suites, integration tests, E2E harnesses, smoke checks, fixtures, load tests,
diagnostics, and testing documentation.

The Flutter app tests stay inside the app packages (`apps/*/test/`) because
`flutter test` discovers them there by convention — see
[Flutter tests](#flutter-tests).

> **Safety:** every script in this tree that writes to Postgres/Redis refuses
> to run when `NODE_ENV=production`. Point `DATABASE_URL`,
> `DIRECT_DATABASE_URL`, and `REDIS_URL` at a dedicated test environment.
> See [docs/TEST_DATA_POLICY.md](docs/TEST_DATA_POLICY.md).

---

## Layout

| Path | Purpose |
|---|---|
| `unit/backend/` | Backend unit suites (`node:test`) + the runner + benchmarks |
| `integration/backend/` | Money-flow integration tests against real Postgres with a fake Stripe gateway |
| `e2e/` | End-to-end harnesses against a running backend (ride lifecycle, full stack, specials, payments, dashboard) |
| `smoke/backend/` | Fast production-readiness smoke scripts (navigation, profile change, platform pricing) |
| `loadtest/` | k6 load test for the ride-request lifecycle |
| `fixtures/` | Synthetic-account seeds and resets |
| `scripts/` | Operational test utilities (environment reset, schema checks, Redis cleanup) |
| `scripts/diagnostics/` | Archived one-off debug/verification probes (not part of CI) |
| `helpers/` | Shared helpers (env guard, TS runner) |
| `docs/` | Testing guides + the archived production audits |

## Quick reference

All commands run from the repo root unless noted.

### Backend unit tests (offline, fast)

```bash
cd backend && npm test            # full suite — 366 tests (node:test)
cd backend && npm run test:astar  # only the A* routing suite
```

The runner is `tests/unit/backend/run-tests.cjs`. It pins `REDIS_URL` to
localhost and `PORT=0`, so the suite passes with no Redis/HTTP server running.

### Money-flow integration tests (real Postgres, fake Stripe)

```bash
cd backend && npm run test:integration:payments
```

### Smoke tests

```bash
cd backend && npm run smoke:navigation   # requires backend on :3000, seeded accounts, local Redis
cd backend && npm run smoke:profile      # requires backend on :3000 + driver/admin accounts
cd backend && npm run smoke:pricing      # requires DB + Redis
```

### E2E suites

```bash
cd backend && npm run e2e:cancellation   # self-contained: restarts the local backend, resets DB/Redis
cd backend && npm run e2e:reset          # reset ride/queue state manually
cd backend && npm run e2e:full           # requires backend on :3000
cd backend && npm run e2e:specials       # requires backend on :3000
cd backend && npm run e2e:stripe         # requires Stripe TEST keys; self-skips otherwise
cd backend && npm run e2e:colab          # requires Stripe TEST keys; boots its own backend
```

### Fixtures

```bash
cd backend && npm run fixtures:seed-payment        # sponsor + riders + drivers (@netride.test)
cd backend && npm run fixtures:reset-payment       # delete them
cd backend && npm run fixtures:seed-test-driver2   # driver2@NetRide.dev
node tests/fixtures/seed-loadtest-riders.cjs       # 100 riders in the LOCAL docker Postgres
node tests/fixtures/verify-loadtest-riders.cjs     # mark them VERIFIED
```

### Load test

```bash
node tests/fixtures/seed-loadtest-riders.cjs
k6 run tests/loadtest/ride-request.js
```

### Benchmarks

```bash
cd backend && npm run bench:routing
cd backend && npm run bench:astar
```

### Flutter tests

Flutter's test runner discovers `test/` inside each package, so those suites
stay with their apps:

```bash
cd apps/rider_flutter  && flutter test   # 23 tests
cd apps/driver_flutter && flutter test   # 5 tests
```

### Schema smoke + diagnostics

```bash
cd backend && npm run migrations:smoke     # table/column probes (read-only)
node tests/scripts/check-supabase-schema.js
node tests/scripts/diagnostics/verify-admin.js
```

## Adding a test

1. **Backend unit:** add `tests/unit/backend/<area>/<name>.unit.test.ts`
   (mirror the backend source area) and register it in the `SUITES` list in
   `tests/unit/backend/run-tests.cjs`. Prefer pure-function tests with no I/O
   so they stay offline. See [docs/TESTING_GUIDE.md](docs/TESTING_GUIDE.md).
2. **Integration:** add to `tests/integration/backend/` and expose an npm
   script in `backend/package.json` when it becomes a standard workflow.
3. **E2E:** add the harness under the matching `tests/e2e/<category>/` folder
   and add an `e2e:*` script in `backend/package.json`.
4. **Flutter:** add a `*_test.dart` under the app's `test/` directory.

## Documentation

- [docs/TESTING_GUIDE.md](docs/TESTING_GUIDE.md) — suite-by-suite guide, how to add tests
- [docs/ENVIRONMENT_SETUP.md](docs/ENVIRONMENT_SETUP.md) — services, env vars, local setup
- [docs/TEST_DATA_POLICY.md](docs/TEST_DATA_POLICY.md) — synthetic accounts, production guards
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — common failures and fixes
- [docs/audits/](docs/audits/) — archived production edge-case audit + engineering report
