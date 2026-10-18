# Admin Dashboard Reliability — Deliverable Summary

Covers: ride list HTTP 500s, revenue test-data exclusion, Sponsor/Partner
test-record filtering, the Status select label defect, Google Business search,
the manual business-entry workflow, and the chart dimension warning.

Everything below is implemented in the working tree and passes
`tsc --noEmit` on `backend/` and `apps/admin_dashboard/`, the admin dashboard
production build, and the backend unit suite (`cd backend && npm test`,
438 tests). The DB changes are additive (migration 20261016_*) and were applied
to the development database.

## 1. Ride list returned HTTP 500 / rendered broken

Root causes (confirmed against the live DB):

- `AdminController.toJSON` deep-cloned Prisma rows by iterating
  `Object.entries`. A `Date` has no own enumerable properties, so every
  timestamp became `{}`; a Prisma `Decimal` leaked its internal `{s,e,d}`
  representation. This broke the Rides table (invalid dates) even when the
  request returned 200.
- `getRides` passed `status`/`page`/`limit` straight into Prisma. Any value
  outside the enum (or a non-numeric page/limit) threw
  `Invalid value for argument 'status'. Expected TripStatus` → HTTP 500.
- The Completed-Rides financial summary ran inside the same `try`; a ledger
  failure turned the whole list into a 500.

Fixes:

- New `utils/json-safe.ts` (`jsonSafe`): BigInt → number, Date preserved
  (serializes to ISO), Decimal → number, arrays/objects recursed, functions
  dropped. `AdminController.toJSON` delegates to it.
- `getRides` validates the status against `ACTIVE|COMPLETED` and page/limit
  (1..100), returning `400` with a specific `code` for malformed input. The
  summary is isolated in its own try/catch (logged, list still succeeds).
- Frontend `Rides.tsx` aborts the previous request on page/status change and
  unmount (`AbortController`), ignores `ERR_CANCELED`, and drops stale
  responses via a sequence guard; polling is silent so the table never flashes
  a spinner over data already on screen. Loading / empty / error + Retry
  states are preserved.

Tests: `tests/unit/backend/utils/json-safe.unit.test.ts`.

## 2. Revenue: test rides excluded by default

- The Revenue overview and analytics had **no** test filter at all — test and
  production rides were summed together.
- The canonical ride-level rule now lives in `utils/testUser.ts`
  (`TEST_RIDE_SQL`, `rideScopeCondition`): a ride is test data when its rider
  is a test account and its driver is absent or also a test account. Same
  predicate is used by both endpoints.
- `GET /admin/revenue?scope=production|test` and
  `GET /admin/analytics?scope=production|test` (default `production`) apply the
  scope at the SQL layer. Invalid scope → 400. Responses echo `scope`.
- UI: a **Test rides** switch on the Revenue page controls both the summary
  cards and the analytics section. A `TEST DATA` chip appears wherever test
  mode is active. A response for the other scope is never rendered (the API's
  echoed `scope` gates display), so stale/cross-mode values cannot leak on a
  rapid toggle. Empty scope shows correct zeros and an empty state.

Tests: `tests/unit/backend/utils/ride-scope-sql.unit.test.ts`.

## 3. Sponsor / Partner test-record filtering

Root cause: classification was email-only. The sponsor fixtures
(`PayTest Sponsor`, `Payment Test Coffee`) carry **no email**, so they were
never classified as test and the existing switch had no effect. Partners had
the same coverage gap for rows with no linked login/contact email.

- New persistent, non-attacker-reachable `is_test` column on `sponsors` and
  `partners` (migration). The admin API never writes it.
- Sponsor predicate = `is_test` OR contact-email rule OR linked portal-user
  email rule; partner predicate = `is_test` OR login/contact email rule. One
  helper per entity drives list, badge and count.
- Historical backfill, evidence only: `business_type = 'TEST'` (fixture-only;
  rejected by the admin API) and the explicit
  `Test fixture funding (…)` ledger reason written by the payment fixture.
  Ambiguous rows are left untouched.
- Fixtures now set `is_test = TRUE`; the admin dashboard drops stale list
  responses (sequence guard) on both pages.

Verified over HTTP: default list hides all fixture sponsors (57 flagged),
`?includeTest=true` shows them with the TEST badge; partner checks pass for
both the marker and the email rule.

## 4. Status select label overlap

The native Status select always displays a selected option ("All"), but MUI
only floated the outlined label while focused. On blur the label dropped into
the field and overlapped the value. Fixed with the library's own API —
`slotProps={{ inputLabel: { shrink: true } }}` — in both Sponsors and
Partners (and for the new Price level selects). No CSS overrides.

## 5. Google Business search

- Confirmed the integration uses Places API (New) server-side
  (`places:searchText` / `places:searchNearby`) with a signed selection token;
  no key reaches the browser.
- Live diagnosis: Google returns `403 PERMISSION_DENIED` for the configured
  key — the environment only sets `GOOGLE_ROUTES_API_KEY`, which does not have
  Places API (New) enabled. The service now logs a one-time fallback-key
  warning and returns the actionable `GOOGLE_PLACES_NOT_AUTHORIZED` code and
  message (no key material in logs or responses).
- Search no longer requires a map pin: the dashboard sends a typed
  `location` string and the backend folds it into the text query
  (`buildTextQuery`), while coordinates are used as a location **bias**.
  Debouncing, in-flight de-duplication, Redis caching, cancellation and
  no-results/error states are in place.
- Live success is **unverified** until a Places-enabled key is configured
  (see Remaining actions). Pure query/location logic is unit-tested with
  `buildTextQuery`.

## 6. Manual business-entry workflow ("Add Manually")

- New `Add Manually` action opens the sponsor dialog in manual mode (no Google
  link required). Create and edit dialogs now include:
  - `BusinessImageUpload`: logo (≤ 2 MB) + gallery (≤ 5 MB each, max 8) with
    previews, remove/replace, upload states.
  - `StarRatingInput`: clickable stars synced with a 0–5 numeric input, plus a
    rating count. Labelled as administrator-entered — explicitly not a
    Google rating.
  - Price level select (`$`…`$$$$`).
- Backend: `sponsors.admin_rating / admin_rating_count / price_level /
  photo_urls` (migration), validated in the admin controller (rating 0–5,
  non-negative integer count, price-level allowlist, photo count, image
  references only to public NetRide storage files). Upload endpoint
  `POST /admin/sponsors/uploads/image` and `DELETE .../uploads/image`.
- Security: images are validated by **content** (magic bytes) as well as
  declared MIME, sized, stored through the existing `StorageService` (public
  branding bucket, unique UUID keys, `/api/files/:id` references — never
  base64 in business rows). SVG and other active content are rejected.
  Replaced images are deleted only after the new record is persisted; deleting
  an in-use image is refused (409); cancelled create dialogs clean up their
  uploads.
- Works with no Google access; verified end-to-end (25/25 checks), including
  create, reopen, edit, image cleanup, and validation rejections.

## 7. Chart dimension warning

`Dashboard`'s `ResponsiveContainer` used `height="100%"`, so Recharts warned
`width(-1) and height(-1)` before layout. It now uses a numeric height chosen
per breakpoint (`useMediaQuery`) while keeping the responsive wrapper;
RevenueAnalytics and EarningsPanel already used numeric heights. Charts render
correctly across loading, empty, filtered and resized states.

## Files changed (high level)

- `backend/src/utils/json-safe.ts` (new), `utils/testUser.ts`,
  `security/image-content.ts` (new)
- `backend/src/modules/admin/admin.controller.ts`
- `backend/src/services/pricing.service.ts`
- `backend/src/modules/sponsor/{sponsor.service,admin-sponsor.controller,admin-sponsor.routes}.ts`
- `backend/src/modules/partner/partner.service.ts`
- `backend/src/modules/google-places/{google-places.service,google-places.controller}.ts`
- `backend/prisma/schema.prisma`
- `backend/migrations/20261016_sponsor_profile_and_test_markers.sql`,
  `20261016_sponsor_fixture_ledger_backfill.sql`
- `apps/admin_dashboard/src/{api/admin.ts,pages/Rides.tsx,pages/Revenue.tsx,pages/Sponsors.tsx,pages/Partners.tsx,pages/Dashboard.tsx}`
- `apps/admin_dashboard/src/components/{RevenueAnalytics,GoogleBusinessSelector,BusinessImageUpload,StarRatingInput}.tsx`
- `tests/unit/backend/{utils/json-safe,utils/ride-scope-sql,security/image-content,modules/google-places,modules/sponsor/business-profile}`
- Fixtures: `tests/integration/backend/run-payments-integration.cjs`,
  `tests/fixtures/seed-payment-fixtures.cjs`,
  `tests/e2e/dashboard-workflows/run-colab-e2e.cjs`,
  `tests/e2e/payments/run-stripe-e2e.cjs`

## Remaining actions / unverified items

1. **Google Places live search**: set `GOOGLE_PLACES_API_KEY` to a key with
   "Places API (New)" enabled and no application (referer) restrictions on the
   backend service; then re-run the Sponsor Google-search flow. Until then the
   UI shows the actionable authorization message (verified behaviour).
2. **Migrations**: apply the two `20261016_*` migrations in each environment
   (`cd backend && node scripts/run-migrations.cjs`). Idempotent and additive.
3. **Historical ledger gross**: some pre-existing `financial_transactions`
   rows store `gross_amount_cents = 0` while carrying driver/platform shares
   (old fixture/backfill writes). Analytics faithfully reports the ledger, so
   those historical rows show $0 gross. New completions populate gross
   correctly; no historical rewrite was performed.
4. **Live UI smoke**: the browser interaction (select label float, chart
   dimensions, image previews) is covered by typecheck/build and the component
   logic, but was not exercised in a real browser in this environment.
