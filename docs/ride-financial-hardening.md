# Ride Financial Hardening — Deliverable Summary

Everything below is implemented in the working tree and passes `tsc --noEmit`
on both `backend/` and `apps/admin_dashboard/`, plus the backend unit-test
suite (`node run-tests.cjs`).

## 1. The bug fixed first (admin dashboard fetch failures)

Root cause (confirmed in `backend/src/modules/admin/admin.controller.ts`):
`getRides`, `getRideById` and `getUsers` returned Prisma rows straight to
`res.json`. The `rides` table carries `BIGINT` money columns
(`final_payment_cents`, `wallet_payment_cents`, `promo_discount_cents`,
`credits_applied_cents`, per migration 037/039) and `drivers` carries
`balance_cents` — Prisma yields JS `BigInt`, and Express throws
`TypeError: Do not know how to serialize a BigInt` → HTTP 500 on
**Completed Rides**, **Live Active Rides** and **Users** (any row with a
driver profile).

Fix: `AdminController.toJSON(…)` deep-converts `BigInt → number` (cents fit
JS safe integers) before every affected `res.json`.

## 2. Server-authoritative ride completion (Phase 3)

- `RideRepository.updateStatus` now performs an **atomic claim** when the
  target status is `COMPLETED`:
  `UPDATE rides SET … WHERE id = $2 AND status IN ('ACCEPTED','DRIVER_ARRIVING','IN_PROGRESS')`
  — `rowCount = 0` throws, so a concurrent double-complete (socket re-emit,
  retry after crash) can never finalize a ride twice. Both the socket path
  (`socket.gateway.ts` → `RideService.updateTripStatus`) and the test-mode
  route (`feature.routes.ts` `/complete-test`) inherit it.
- `RideService.updateTripStatus` gained explicit state-machine guards:
  terminal rides can never transition; `IN_PROGRESS` only from
  `ACCEPTED`/`DRIVER_ARRIVING`.

## 3. Financial settlement ledger (Phase 4)

- **100× overcharge bug found and fixed:** `updateTripStatus` charged riders
  `parseFloat(final_payment_cents) * 100` — but that column stores **integer
  cents** (written by `reward-engine.service.ts`). Every wallet-settled ride
  was charged 100× the due amount. Fixed via `centsValue()` (single
  conversion helper, unit-tested against the regression).
- **New table** `financial_transactions` (`backend/migrations/044_financial_ledger.sql`):
  - exactly one `RIDE_COMPLETION` row per ride — partial unique index on
    `ride_id`, plus idempotency key `ride_completion:{rideId}` with
    `ON CONFLICT DO NOTHING`
  - integer cents everywhere; `TIMESTAMPTZ` (UTC) timestamps
  - settlement states: `SETTLED` (due fully covered) / `PENDING_CAPTURE`
    (shortfall recorded in `amount_owed_cents`; revenue contributes $0 until
    settled)
  - indexes: `(driver_id, completed_at)`, `(rider_id, completed_at)`,
    `(status)`, `(status, completed_at)`
- **Write path:** the completion block in `ride.service.ts` records the
  ledger row (fare / promo / credits / tip / wallet-paid / outstanding /
  driver-60 / platform-40, sourced from the persisted revenue allocation —
  never computed client-side).
- **Backfill:** `backend/scripts/backfill-financial-ledger.ts` — idempotent,
  non-destructive, only fills rides without a ledger row, uses the same
  idempotency keys (`npx ts-node scripts/backfill-financial-ledger.ts`).
- **Admin surfaces:**
  - `GET /admin/rides?status=COMPLETED` now returns a server-computed
    `summary` (gross / driver / platform / promo / credits / tips /
    settled·pending) — the Completed Rides page banner.
  - `GET /admin/rides/:id/ledger` — per-ride settlement row + rider wallet
    movements + driver `payouts` (RIDE_CREDIT/TIP_CREDIT).

## 4. Route capture & admin ride map (Phases 5–6)

- Planned routes already persist per leg in `ride_routes` (migration 034) at
  request time; actual GPS trajectory is buffered in Redis (5 s throttle)
  and snapshotted into `rides.trajectory` at completion — captured.
- New `GET /admin/rides/:id/routes` (admin-guarded):
  - `planned`: per-leg polylines (`[lat, lng]`, GeoJSON converted server-side)
    with fallback to the `rides.route_metadata` destination mirror and
    coordinate validation/clamping on every point
  - `actual`: driven GPS polyline; `available: false` when fewer than 2 valid
    points — the frontend never labels the planned route as the driven one
- Trajectory input validation added in `LocationsService.bufferTrajectory`
  (NaN/Infinity/out-of-range lat/lng dropped before storage).
- `RideDetail.tsx` now renders **planned (blue, dashed) vs actual (orange,
  solid)** with a legend, and a "Actual route unavailable" chip; the
  Financial Settlement card shows the per-ride ledger status, split and any
  amount owed.

## 5. Driver earnings on Manage User (Phase 7)

- `GET /admin/users/:id/earnings?range=7d|30d|90d|all&period=day|week|month&page&limit`
  — ledger-backed (SETTLED only): lifetime + range totals (earnings, tips,
  after-trip tip credits from `payouts` TIP_CREDIT), server-bucketed UTC time
  series, and paginated completed-rides detail.
- `EarningsPanel` component on the driver Manage User page: cards, period
  toggle, chart, completed-rides table with pagination, explicit
  loading/error/empty states.

## 6. Analytics & regions (Phases 8–9)

- `GET /admin/analytics?range&bucket=day|week|month&region=<code>` —
  SETTLED-ledger totals + UTC-bucketed series + per-ride averages
  (avg fare / avg platform). All aggregation server-side; the documented
  convention: **buckets are UTC, display formatting is client-side**.
- New `regions` table + `region_contains()` haversine helper
  (`backend/migrations/045_regions.sql`). Regions are geofences (center +
  radius); ride attribution happens at query time from the pickup point (no
  ride-row writes).
- `GET /admin/regions`, `POST /admin/regions` (validated server-side,
  audit-logged). Revenue page gains a ledger-driven analytics panel with
  range/bucket/region controls and a region manager.

## 7. Security

All new endpoints sit under `admin.routes.ts`, which is wrapped in
`authMiddleware` + `adminMiddleware` (JWT + `role === 'ADMIN'`) — admin-only
by construction. All queries are parameterized; region input validated
server-side; no secrets introduced.

## 8. Tests

`backend/src/services/__tests__/financial-ledger.unit.test.ts` (registered in
`run-tests.cjs`, 5 tests, `node:test`):
- `centsValue`: BIGINT-as-string cents are **not** multiplied by 100 (guards
  the 100× regression), handles BigInt/number/null/garbage
- `settlementStatusFor`: fully covered → SETTLED; any shortfall →
  PENDING_CAPTURE
- `grossAmountCents`: gross composition

## 9. Env vars

None added. Reuse existing `DATABASE_URL` etc.; `run-tests.cjs` already pins
`REDIS_URL`/`PORT` for offline test runs.

## 10. Manual verification steps

1. `npm run db:migrate` equivalent for `migrations/044_financial_ledger.sql`
   and `045_regions.sql` (apply via existing migration tooling).
2. `npx ts-node scripts/backfill-financial-ledger.ts` — expect N inserted,
   re-run shows 0.
3. Start backend + admin dashboard. Open /admin/rides?status=COMPLETED and
   ACTIVE — both load (previously 500); completed tab shows the summary
   banner and fare column.
4. Open a completed ride → map shows planned (dashed blue) + actual GPS
   (orange); settlement card shows SETTLED with split. A ride with no GPS
   samples shows "Actual route unavailable".
5. Open a driver's Manage User page → Earnings panel: lifetime, tips, chart
   by Daily/Weekly/Monthly, completed rides table.
6. Revenue page → analytics panel: switch range/bucket, filter by region,
   add a region, re-filter.
7. Duplicate-completion check: hit the socket `completeTrip` twice → second
   attempt errors ("Ride cannot be completed from its current state"); one
   ledger row, one wallet charge, one driver credit.

## 11. Known limitations (documented conventions)

- Post-completion tips (`TIP_CREDIT` payouts) are credited to the driver but
  are not folded back into the ledger row recorded at completion; they are
  reported separately (`afterTripTipCents`) in the earnings API.
- `PENDING_CAPTURE` rows are surfaced but there is no retry/capture loop
  yet — reconciliation is manual (admin sees the outstanding amount).
- Completed rides created before the backfill runs will not appear in
  ledger-driven analytics; run the backfill once after deploying.
- Analytics buckets are UTC by convention; no business-timezone conversion
  is applied server-side.
- Region attribution is geofence-by-pickup only (no ride-row region column);
  a ride may match multiple regions.