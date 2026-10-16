# NetRide Production Hardening — Engineering Report

Date: 2026-10-13
Baseline: `NETRIDE_PRODUCTION_EDGE_CASE_AUDIT.md` (Phase 1 audit, same date).
Scope of this report: everything implemented and verified after the audit.

---

## 1. Summary

The ride lifecycle is now server-authoritative, mobile recovery is deterministic, retries are
idempotent, and every failure has a visible, honest client state. The highest-risk defects from
the audit (P0 #1–#12, P1 #13–#24) are implemented; several P2 items are also addressed.
All automated suites pass (backend 283, rider 23, driver 5, dashboard typecheck + build).
Nothing was verified on a physical device in this environment — §5 lists exactly what a device QA
pass must cover.

---

## 2. What changed

### 2.1 Server-authoritative lifecycle and watchdog (audit #1, #2)

- `backend/src/modules/ride/ride-state.rules.ts` (new): pure `TerminalCancelGuard` SQL builder
  (allowlisted columns, bound values) so every system cancel re-verifies status **and age** inside
  the atomic `UPDATE` (TOCTOU fixed).
- `ride.service.ts` `cancelTripSystem` accepts a guard; a guard miss is a benign race (state
  advanced), not an error.
- `queue/jobs/cleanupStaleRides.ts` + `services/cleanup.service.ts`: scheduled rides are excluded
  from the REQUESTED sweep unless their `scheduled_at` has long passed; overdue sweeps anchor on
  `started_at` only. Ghost-driver removal now preserves drivers with a live availability lease or
  an active trip.
- Tests: `tests/unit/backend/queue/cleanup-stale-rides.unit.test.ts`,
  `tests/unit/backend/modules/ride/ride-state-guards.unit.test.ts`.

### 2.2 Availability lease, presence, and reconnect re-assert (audit #3, #4, #17, #21)

- `LocationsService` now stores a timestamped location record (`driver:loc:*`) and an explicit
  availability lease (`driver:online:*`); `goOnline` always creates the lease (even without a GPS
  fix) and acknowledges it with `driverAvailability { online, available, expiresAt }`.
- Socket gateway: lease is re-checked from Redis (not the socket-local flag) before accepting
  positions; `getDriverAvailability` reconciles; disconnect no longer relies on a reset local flag.
- Presence (`presence:*`) is refreshed every 30 s by the owning socket and deletes are
  compare-and-delete on the socket id (multi-device safe). Typo
  `registration-token-not-registerred` fixed; one invalid token now prunes only itself.
- Admin/eligibility ghost sweeps use the lease/active-trip keys.

### 2.3 Location integrity and safe trip gates (audit #6, #16)

- Every fix carries `accuracy`, `speed`, `mock`, `deviceAt`, `source`; the server stores its own
  receipt time and freshness math is a single pure function (`evaluateLocationFreshness`).
- Pickup/complete proximity gates reject stale and mock fixes; dispatch eligibility uses the
  timestamped record, not the heartbeat TTL.
- Driver app: single OS GPS stream (`GpsTracker`) for availability + navigation (duplicate
  `Geolocator` stream removed), platform-aware settings with Android foreground service and iOS
  background mode.

### 2.4 Offers: push delivery, actions, replay, expiry (audit #5)

- Ride offers are pushed on EVERY offer (presence is not evidence the app can render), carrying
  `offerId` + server expiry; FCM notification actions call the authenticated REST endpoints.
- New `POST /ride/decline` (idempotent, ownership-checked); accept/decline share
  `RideService.declineTrip`/`acceptTrip`.
- Offer payload is persisted on the offer and replayed by `getPendingOffer` when a socket
  reconnects or the driver returns through the app icon; expired offers are cleaned up, never
  replayed.
- Driver app: foreground FCM re-post with Accept/Decline actions, expiry-bounded Android
  notification, notification cancelled on accept/decline/settle; background notification action
  handler POSTs REST with the token from prefs.

### 2.5 Concurrency, idempotency, ordering (audit #7–#11, #14, #15, #22)

- `rides.updated_at` (migration 055) shipped in every payload; both mobile apps drop out-of-order
  events by version and ignore events for settled/different trips.
- Rider: one stable idempotency key per logical request (reused on retry), REST fallback when the
  socket is down, ack timeout → REST reconciliation with the same key, terminal state releases the
  trip id and settles it so it can never resurrect. `POST /ride/request` is the reconciliation
  path.
- `DRIVER_ARRIVING` is now a real server transition (`markDriverArriving`, atomic from ACCEPTED,
  only from a fresh non-mock fix inside the pickup radius) and both apps render it
  (“DRIVER HAS ARRIVED” / “AT PICKUP — WAITING FOR RIDER”) with pending CTAs.
- Admin: ride audit rows now go to `audit_events` with previous status (the old FK to `users.id`
  made every write fail); force-complete of a driverless ride is rejected with 409.
- Admin credit grants accept a client idempotency key; the dashboard sends one per submission.
- BullMQ connection now preserves Redis auth and `rediss://` TLS.

### 2.6 Mobile recovery and honest UI states

- Driver: `driverAvailability` adopted instead of a local flag; “Connecting…” / “Connection lost —
  reconnecting…” header states; missed terminal outcome surfaced once after process death;
  offer/trip action double-tap guards; background location pipeline started on go-online and
  stopped on go-offline (unless mid-trip).
- Rider: socket is initialized after every login path (OAuth, password, signup, OTP) via the auth
  notifier; foreground resync re-asks the server for the trip; cold-start restore navigates to the
  trip screen for any active state; “Try Again” retries the pending request with the same key.
- Dashboard: socket updates MERGE into REST rows (no more blanked fields), reconnect triggers a
  refetch, and Rides/RideDetail/LiveMonitoring show LIVE/RECONNECTING badges.

### 2.7 Schema / config

- `backend/migrations/055_ride_updated_at.sql` (`rides.updated_at` + index).
- `backend/migrations/056_driver_fcm_token.sql` (`drivers.fcm_token`, declared in Prisma but never
  created by the SQL runner).
- Driver `AndroidManifest.xml`: `ACCESS_BACKGROUND_LOCATION`, `FOREGROUND_SERVICE`,
  `FOREGROUND_SERVICE_LOCATION`, `WAKE_LOCK`.
- Driver `Info.plist`: `UIBackgroundModes: location`, transparent Always-location usage strings.
- Driver notification channels now cover every channel id the backend names.

---

## 3. Automated verification (actually executed)

| Suite | Command | Result |
|---|---|---|
| Backend build | `npm run build` (backend) | clean (`tsc`) |
| Backend tests | `npm test` (backend) | **283 passed, 0 failed** (includes the 3 new suites) |
| Rider analyze | `flutter analyze --no-pub` | no errors |
| Rider tests | `flutter test` | **23 passed, 0 failed** (10 new recovery tests + existing) |
| Driver analyze | `flutter analyze --no-pub` | no errors |
| Driver tests | `flutter test` | **5 passed, 0 failed** (new recovery suite) |
| Dashboard typecheck | `npx tsc --noEmit` | clean |
| Dashboard build | `npm run build` | succeeds |

New tests:
- `tests/unit/backend/modules/ride/ride-state-guards.unit.test.ts`
- `tests/unit/backend/modules/location/location-freshness.unit.test.ts`
- `tests/unit/backend/queue/cleanup-stale-rides.unit.test.ts`
- `apps/rider_flutter/test/ride_provider_recovery_test.dart` (ordering guards, terminal
  resurrection block, idempotency-key reuse, request-while-matching guard, reset semantics)
- `apps/driver_flutter/test/driver_provider_recovery_test.dart` (different-trip guard, version
  ordering, DRIVER_ARRIVING active state, terminal capture, cancellation first-class state)

---

## 4. Implemented but requiring physical-device verification

No Android/iOS device or simulator was available here, so the following are verified only by code
inspection + automation:

1. **Android foreground service**: go online → switch app → driver stays dispatchable; persistent
   notification shown; Android 13 notification permission and Android 14 FGS rules.
2. **iOS background location**: minimize/lock during an active trip; blue location indicator;
   route/ETA keep updating; behavior after “While Using” only permission.
3. **Offer notifications**: push arrives backgrounded/terminated; Accept/Decline actions resolve to
   exactly one assignment; expired offers are not actionable; notification removed after settle.
4. **Process death recovery**: kill driver app mid-trip (swipe + force-stop), reopen → trip screen
   restored with correct controls; rider killed while REQUESTED → search resumes.
5. **Battery/OS doze**: long background periods, battery saver, GPS disabled/restored.
6. **Push end-to-end**: requires `google-services.json` / `GoogleService-Info.plist` (absent from
   the repo) and FCM credentials; without them the service degrades to the documented stub.
7. **Live Activities** (iOS ride/offer lock-screen): NOT implemented — requires a widget extension
   target that does not exist in the Xcode project. Documented blocker, not silently skipped.

---

## 5. Remaining blockers / known limitations

1. **FCM configuration absent**: `google-services.json` / `GoogleService-Info.plist` are not in the
   repo, so push delivery and notification actions are inert in this environment by design.
2. **iOS Live Activities / Android ongoing offer UI**: no widget extension; offers rely on
   notification actions plus socket/UI. Documented as a platform gap.
3. **Migrations 055/056 must be applied** before deploying the new code (`npm run migrate`).
4. **`ACCESS_BACKGROUND_LOCATION` Play Store declaration** is required for the driver app release.
5. **Chat reliability** (audit P2 #28: ack reconciliation/offline retry, `detach()` on sheet close)
   is not addressed in this pass.
6. **Security/ops polish** (audit P2 #30/#31): committed `.env` files, debug signing/cleartext in
   release builds, no CSP on the dashboard static server, Sentry init-only, and partial metric
   coverage for push delivery remain.
7. **Dashboard has no test runner**; its gate is `tsc --noEmit` + `vite build`.
8. **Reconciliation tooling** (audit Phase 12: automated orphaned-ride detection) is not added;
   the watchdog covers the known impossible-state classes with guarded, audited cancels.

---

## 6. Operational notes

- Deploy order: apply migrations 055/056 → deploy backend → ship mobile builds. Old clients keep
  working (new payload fields are additive; `decline` and `getPendingOffer` are new endpoints).
- Watch these metrics after rollout: `netride_lifecycle_events_total{event=...}`
  (`stale_ride_cancelled`, `ghost_driver_removed`, `driver_arrived`),
  `netride_push_delivery_total{outcome=...}` (`stub`/`no_tokens` indicate FCM misconfiguration).
- The availability lease TTLs are configurable: `DRIVER_ONLINE_TTL_S` (120),
  `DRIVER_HEARTBEAT_TTL_S` (90), `DRIVER_LOCATION_RECORD_TTL_S` (300),
  `DRIVER_LOCATION_MAX_AGE_S` (60), `DRIVER_LOCATION_FRESHNESS_S` (60).
