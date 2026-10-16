# Testing Guide

How NetRide's test suites are organized, how to run them, and how to add new
ones. Commands are run from the repo root unless stated otherwise.

## 1. Test discovery model

Backend unit tests are **explicitly registered**, not globbed. The runner
`tests/unit/backend/run-tests.cjs` requires each suite from a `SUITES` list,
which makes the exact executed set reviewable and stable. If you add a suite,
add it to that list — otherwise it silently never runs.

The runner:

1. loads `backend/.env` (so it works from any working directory),
2. pins `REDIS_URL=redis://127.0.0.1:6379` and `PORT=0` when unset,
3. puts `backend/node_modules` on `NODE_PATH` (some suites import
   `jsonwebtoken` / `bcryptjs` by bare name),
4. registers `ts-node` in transpile-only CommonJS mode,
5. requires every suite (each uses the `node:test` runner and prints a
   summary at the end).

## 2. Backend unit tests

```bash
cd backend
npm test                 # all suites — currently 366 tests
npm run test:astar       # filter: runs only suites whose path contains "astar"
```

From the repo root without npm:

```bash
node tests/unit/backend/run-tests.cjs
node tests/unit/backend/run-tests.cjs payments   # path filter
```

Layout mirrors `backend/src`: `tests/unit/backend/modules/<module>/...`,
`tests/unit/backend/services/...`, `tests/unit/backend/queue/...`,
`tests/unit/backend/routing/...`. Suites import production code through
relative paths (`../../../../../backend/src/...`).

Conventions for new unit tests:

- Use `node:test` + `node:assert/strict`.
- Keep them pure: no network, no DB, no Redis. Export pure helpers from
  production modules when behavior needs contract coverage (e.g.
  `computeCreditApplication`, `buildTerminalCancelGuardSql`).
- Name the file `<topic>.unit.test.ts`.

### Benchmarks

```bash
cd backend
npm run bench:routing    # routing pipeline + fare/cache micro-benchmarks
npm run bench:astar      # A* engine latency/memory (needs ROUTING_GRAPH_PATH for full run)
```

Both use `tests/helpers/run-ts.cjs`, which registers `ts-node` with the
backend config, so the benchmark files can live outside `backend/src`.

## 3. Integration tests

`tests/integration/backend/run-payments-integration.cjs` runs the real
settlement services against the configured Postgres with a **fake Stripe
gateway** (`setStripeGatewayForTests`). No network, no real money.

```bash
cd backend && npm run test:integration:payments
```

It self-skips when `NODE_ENV=production` or `SKIP_PAYMENTS_E2E=1`.

## 4. E2E suites

E2E harnesses drive a **running backend** over REST + Socket.IO, against the
database and Redis configured in `backend/.env`.

| Suite | Script | Prerequisites |
|---|---|---|
| Cancellation matrix (A–H) | `npm run e2e:cancellation` | Postgres + Redis; harness restarts the backend itself |
| Cancellation (rider mid-trip) | `node tests/e2e/ride-lifecycle/e2e-cancel-rider.cjs` | backend on :3000 + an active trip |
| Full stack | `npm run e2e:full` | backend on :3000 |
| Specials code flow | `npm run e2e:specials` | backend on :3000 |
| Stripe sandbox | `npm run e2e:stripe` | Stripe TEST keys + `stripe listen` webhook forwarding |
| Colab dashboard HTTP E2E | `npm run e2e:colab` | Stripe TEST keys; boots its own backend |

The cancellation harness is the most intrusive: it cancels lingering
`REQUESTED` rides, resets two test drivers' scoring, clears Redis offer keys,
and restarts the local backend. Only run it against a dedicated test database
(see `docs/TEST_DATA_POLICY.md`).

Before re-running the dual-driver scenarios manually:

```bash
cd backend && npm run e2e:reset   # cancel non-terminal rides, wipe queue/offer/trip state
```

## 5. Smoke tests

```bash
cd backend
npm run smoke:navigation   # log in rider+driver, request/accept a trip, verify route caches
npm run smoke:profile      # profile-change approval + wallet + payout flow
npm run smoke:pricing      # pricing config, market conditions, estimate snapshot round-trip
```

Smoke scripts assert and exit non-zero on failure. They expect seeded
accounts (see the fixture commands in `tests/README.md`).

## 6. Load test

```bash
node tests/fixtures/seed-loadtest-riders.cjs
k6 run tests/loadtest/ride-request.js
```

Targets the **local** docker-compose Postgres (`ridehail@localhost:5432`) and
a backend on `:3000`; riders are `loadtest.rider.<n>@test.com` / `test123456`.

## 7. Flutter unit tests

Kept in `apps/*/test/` because `flutter test` discovers that directory by
convention:

```bash
cd apps/rider_flutter  && flutter test
cd apps/driver_flutter && flutter test
```

## 8. Adding a new backend unit suite

1. Create `tests/unit/backend/<area>/<topic>.unit.test.ts` mirroring the
   production area (e.g. `tests/unit/backend/modules/ride/`).
2. Import production code with a path relative to the new file
   (`../../../../../backend/src/modules/ride/ride.service` for module-level
   suites). Note the number of `../` segments — count from the test file to
   the repo root, then append `backend/src/...`.
3. Register the file in `SUITES` inside `tests/unit/backend/run-tests.cjs`.
4. Run `cd backend && npm test` and confirm the new tests are reported.

## 9. Adding a new E2E harness

1. Pick the category folder under `tests/e2e/` (or add a new one).
2. Require dependencies through `backend/node_modules` relatively (see
   existing harnesses); load `backend/.env` explicitly and require
   `tests/helpers/test-env-guard.cjs` if the script writes data.
3. Add an `e2e:<name>` script to `backend/package.json`.
4. Document it in `tests/README.md`.

## 10. Archived diagnostics

`tests/scripts/diagnostics/` contains one-off debug/verification probes kept
for reference (hardcoded ids, manual invocation, not part of CI). They are not
registered anywhere and may need the local stack running to be useful.
