# Test Data Policy

Rules for the synthetic data used by NetRide tests and the guardrails that
keep test scripts away from production.

## 1. Synthetic accounts

| Account | Password | Created by | Purpose |
|---|---|---|---|
| `rider@NetRide.dev` | `password123` | seed data | default E2E rider |
| `driver@NetRide.dev` | `password123` | seed data | default E2E driver |
| `driver2@NetRide.dev` | `password123` | `tests/fixtures/seed-test-driver2.cjs` | dual-driver cancellation scenarios |
| `payment-rider-a/b@netride.test` | `password123` | `tests/fixtures/seed-payment-fixtures.cjs` | Stripe settlement flows |
| `payment-driver-a/b@netride.test` | `password123` | `tests/fixtures/seed-payment-fixtures.cjs` | Stripe settlement flows |
| `loadtest.rider.<n>@test.com` | `test123456` | `tests/fixtures/seed-loadtest-riders.cjs` | k6 load test (local DB only) |

Email markers recognized platform-wide (`backend/src/utils/testUser.ts`,
`apps/*/lib/utils/test_user.dart`): a `+test`/`+sandbox`/`+dev` plus-tag, a
local part starting with `test`/`sandbox`/`dev`, or an
`@netride.test` / `@netride.dev` domain. Accounts matching these markers are
exempt from the saved-card booking rule and are treated as test users by ride
settlement.

## 2. Hard rules

- **Never** use real government IDs, driver's licenses, selfies, or other
  real people's documents in fixtures. Verification-document flows must be
  exercised with synthetic images only.
- **Never** commit real `.env` files, service-role keys, payment
  credentials, or production tokens.
- Use Stripe's published **test cards** only (e.g. `4242 4242 4242 4242`).
  All Stripe E2E suites self-skip unless `STRIPE_SECRET_KEY` is `sk_test_…`.
- Test fixtures (`@netride.test`, `loadtest.rider.*`) must be removable with
  `npm run fixtures:reset-payment` / targeted deletes; do not attach them to
  real customers.

## 3. Production guards

Every script that writes data refuses to run when `NODE_ENV=production`:

- Shared interlock: `tests/helpers/test-env-guard.cjs` (E2E harnesses,
  reset-env, seeds, cleanup probes).
- Built-in interlocks: `seed-payment-fixtures`, `reset-payment-fixtures`,
  `run-payments-integration`, `run-stripe-e2e`, `run-colab-e2e` (which also
  requires a test-mode Stripe key).
- The load-test seeders connect to a **hardcoded local** Postgres
  (`postgresql://ridehail:secret@localhost:5432/ridehail`) and cannot target a
  remote host.

## 4. Environment warning (read before running E2E)

The API-driven E2E suites write to whatever `DATABASE_URL` /
`DIRECT_DATABASE_URL` resolve to in `backend/.env`. In this repository that
has historically been a **shared Supabase project that also serves as the dev
environment**. Before running any E2E harness:

1. Confirm `NODE_ENV` is not `production`.
2. Confirm the database behind `DATABASE_URL` is a disposable test database —
   `e2e:cancellation` cancels `REQUESTED` rides and rewrites driver scoring
   rows for two test drivers.
3. Prefer a dedicated Supabase branch / local docker database for E2E runs.

The Flutter app tests and backend unit tests do not touch the database.

## 5. Resetting state

```bash
cd backend
npm run fixtures:reset-payment    # remove @netride.test payment fixtures
npm run e2e:reset                 # cancel non-terminal rides, wipe queue/offer/trip state
node ../tests/scripts/clear-offers.cjs   # clear Redis offer/lock keys only
node ../tests/scripts/diagnostics/cleanup-e2e-rides.cjs  # historic cancellation-probe cleanup
```

## 6. CI

There is currently no CI workflow that executes these suites. `codemagic.yaml`
builds the Flutter apps; `render.yaml` deploys the backend, admin dashboard,
and sponsor portal. All paths referenced by those configs point at
`apps/*` / `backend/` and are unaffected by the `tests/` reorganization. When
adding CI, run `cd backend && npm test` plus `flutter test` per app as the
baseline gate.
