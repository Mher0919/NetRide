# Troubleshooting

## Backend unit tests

**`Cannot find module 'jsonwebtoken'` / `'bcryptjs'` when running a suite
directly.** Those packages live in `backend/node_modules` and are not
hoisted. Always run through the runner (`cd backend && npm test` or
`node tests/unit/backend/run-tests.cjs`), which sets `NODE_PATH` to
`backend/node_modules`. Do not run `ts-node` on a single suite by hand.

**`EADDRINUSE: :3000`.** The runner sets `PORT=0`, so this should not happen
from the suite. If it does, another process overrode `PORT`; the runner only
defaults the value when unset.

**Redis `ECONNREFUSED` noise during `npm test`.** Expected — the runner points
`REDIS_URL` at localhost and the routing service degrades to cache-miss. The
suite still passes; the watchdog exits the process cleanly afterwards.

**A suite I added never runs.** Registration is explicit: add the file to the
`SUITES` list in `tests/unit/backend/run-tests.cjs`.

**Test count changed from 283 to 366.** The reorganization also wired up
suites that existed but were never registered (`partner-auth`,
`promo-accounting`, `astar-routing`, and the security regression suite). No
test was removed.

## E2E / smoke

**`Refusing to run: NODE_ENV=production`.** Working as intended. E2E and seed
scripts never touch a production environment; point them at a test database.

**`login failed for …` in an E2E harness.** Seed the accounts first
(`npm run fixtures:seed-test-driver2`, payment fixtures) and confirm the
backend is running against the same database as the harness.

**`timeout waiting for newTripRequest`.** The dispatch matcher found no
eligible driver: check that the driver is online (socket `goOnline`
acknowledged), has a fresh GPS fix, and that Redis is the same instance the
backend uses.

**`backend did not become ready within 45s`.** `e2e:cancellation` starts
`backend/src/app.ts` itself; inspect the harness logs at
`%TEMP%/opencode/backend-e2e-harness.log` and `.err`. Common causes: bad
`DATABASE_URL`, port already occupied by an old backend.

**Stripe suites print `SKIPPED`.** `STRIPE_SECRET_KEY` is missing or is not a
`sk_test_…` key. That is the designed no-op; no payment code ran.

**`Cannot find module` inside a moved test script.** All moved scripts resolve
`pg`/`ioredis`/`dotenv`/`ts-node` relative to `backend/node_modules` and
`socket.io-client` relative to `apps/admin_dashboard/node_modules`. Run them
from the repo (the npm scripts do). If dependencies were reinstalled and moved,
keep those relative paths in sync.

### Payment integration suite

**Re-run fails with `duplicate key ... stripe_customers_stripe_customer_id_key`.**
The suite uses fixed fake ids (`cus_rider`, `cus_nc`, …) and only cleans up on
a successful run. A crashed run leaves them behind. Delete the leftovers for
that run's email suffix (`stripe-%-<suffix>@netride.test`,
`noconsent-%-<suffix>@netride.test`, …) and their dependent rows, or use a
fresh database. The `cleanup()` function at the bottom of
`tests/integration/backend/run-payments-integration.cjs` lists the tables.

**`Connection terminated unexpectedly` / statement timeouts mid-run.**
The configured Postgres dropped the connection or a leaked transaction is
holding locks. Check `pg_stat_activity` for `idle in transaction` sessions
left by a crashed run and terminate them, then re-run. (Observed against the
shared Supabase dev database; a local docker Postgres avoids it.)

## Flutter

**`flutter test` cannot find packages.** Run `flutter pub get` in the app
first. Tests live in `apps/*/test/` by Flutter convention and are not part of
`tests/`.

**Tests pass locally but the app package path shows oddly in output.** The
runner prints absolute paths; that is normal on Windows.

## Repository checks

**`npx tsc --noEmit` fails in `backend/`.** Known pre-existing error in the
uncommitted working-tree change to
`backend/src/modules/ride/ride.repository.ts` (`driver_info.id` is not in the
declared return type). It is unrelated to the test reorganization; the unit
suites transpile without type-checking.

**Stale references to `run-tests.cjs` / `e2e-cancellation.cjs` at the
backend root.** Those files moved into `tests/`. The npm scripts in
`backend/package.json` are the source of truth for the new paths.
