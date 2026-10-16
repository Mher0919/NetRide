# Environment Setup

Everything needed to run the NetRide test suites locally.

## 1. Tooling

| Tool | Version used by this repo |
|---|---|
| Node.js | 24.x (backend + test runners) |
| npm | bundled with Node |
| Flutter | 3.41.x (rider + driver app tests) |
| Docker | for local Postgres/Redis (or use a hosted test project) |
| k6 | optional, for `tests/loadtest/ride-request.js` |

Backend dependencies must be installed before any suite runs:

```bash
cd backend && npm install
```

Flutter app dependencies:

```bash
cd apps/rider_flutter  && flutter pub get
cd apps/driver_flutter && flutter pub get
```

## 2. Services

Most suites need Postgres and Redis; unit tests do not.

```bash
docker compose up -d postgres redis     # from the repo root
```

Configuration lives in `backend/.env` (git-ignored). Copy
`backend/.env.example` and fill in the values. Test runners load this file
explicitly, so commands work from any working directory.

Key variables:

| Variable | Used for |
|---|---|
| `NODE_ENV` | production interlocks in every writing script |
| `DATABASE_URL` / `DIRECT_DATABASE_URL` | Postgres (pooled / direct); integration + E2E + fixtures |
| `REDIS_URL` | live driver state, offers, locks; E2E + smoke |
| `JWT_SECRET` | tokens for API-driven suites |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | Stripe TEST-mode E2E only |
| `GOOGLE_ROUTES_API_KEY`, `OSRM_BASE_URL`, `ROUTING_GRAPH_PATH` | routing benchmarks |

Never commit `.env`, service-role keys, live Stripe keys, or credentials.

## 3. Running the backend for E2E/smoke

`e2e:cancellation` and `e2e:colab` start the backend themselves. The other
suites expect one on `http://localhost:3000`:

```bash
cd backend && npm run dev
```

Health check: `GET http://localhost:3000/health/live`.

## 4. Seed data

```bash
cd backend
npm run fixtures:seed-test-driver2       # driver2@NetRide.dev
npm run fixtures:seed-payment            # payment fixtures (@netride.test)
node ../tests/fixtures/seed-loadtest-riders.cjs   # local docker DB only
```

E2E cancellation expects `rider@NetRide.dev`, `driver@NetRide.dev`, and
`driver2@NetRide.dev` (password `password123`) plus at least one admin
account. See `docs/TEST_DATA_POLICY.md` for the full account map.

## 5. Stripe test mode

`e2e:stripe` and `e2e:colab` require `STRIPE_SECRET_KEY=sk_test_…`; both
self-skip without it. To receive webhooks locally:

```bash
stripe listen --forward-to localhost:3000/api/payments/webhook
```

Use only Stripe's published test cards.

## 6. Platform notes (Windows/PowerShell)

- Commands in this repo are run through PowerShell 5.1. Chain with `;` and
  `if ($?) { … }` rather than `&&`.
- The unit runner pins `PORT=0` so a dev server on `:3000` never conflicts.
- Diagnostic scripts in `tests/scripts/diagnostics/` were authored on this
  machine and may contain stale hardcoded ids; treat them as archival.
