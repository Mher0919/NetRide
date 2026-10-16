# NetRide Production Edge-Case Audit

Audit date: 2026-10-13
Scope: `backend/` (Node 24 + TypeScript + Express + Socket.IO + Prisma/Postgres + Redis + BullMQ + Stripe + FCM), `apps/rider_flutter/`, `apps/driver_flutter/` (Flutter 3.x + socket_io_client + geolocator + firebase_messaging + flutter_local_notifications), `apps/admin_dashboard/` (React 19 + Vite + MUI + socket.io-client + Leaflet), `apps/sponsor_portal/`.

This document is the output of Phase 1. Implementation status is tracked in §8 and `NETRIDE_ENGINEERING_REPORT.md`.

---

## 1. Actual architecture

### 1.1 Backend
- Entry point `backend/src/app.ts` boots Express, Socket.IO (`src/gateway/socket.gateway.ts`), an in-process maintenance tick (every 2 min), BullMQ workers (`queue/`), and a runtime SQL migration runner.
- Persistence: PostgreSQL via raw `pg` pool (`config/database.ts`) plus Prisma (`prisma/schema.prisma`) in newer modules. Redis (`config/redis.ts`) holds live driver GEO positions, heartbeats, H3 cell index, offers, locks, idempotency scratch, and per-trip trajectories.
- Auth: JWT (`middleware/auth.middleware.ts`) for REST; Socket.IO middleware (`gateway/socket.middleware.ts`) resolves the active session role (RIDER/DRIVER/ADMIN).
- Ride lifecycle module: `modules/ride/{ride.routes,ride.controller,ride.service,ride.repository}.ts`. Dispatch: `services/{dispatch.service,dispatch-engine.service,driver-offer.service,matching.service,driver-eligibility.service}.ts` + `queue/jobs/*`. Locations: `modules/location/locations.service.ts`.
- Payments: Stripe (`modules/payments/*`): checkout sessions, setup intents, payment intents, wallet, Connect transfers, webhook service with a `stripe_webhook_events` claim table.
- Notifications: `services/notification.service.ts` (DB event log + socket + FCM fan-out, `event_id` unique), `services/push-notification.service.ts` (FCM, multi-device `device_tokens`).
- Admin: `modules/admin/admin.controller.ts` (+ routes) consumed by the Colab dashboard.

### 1.2 Mobile apps
- Both apps are Flutter, share the same stack, boot sequence, and a socket-per-provider model.
- Rider: `lib/providers/ride_provider.dart` owns the socket; `lib/screens/map_screen.dart` books rides; `lib/screens/trip_screen.dart` renders the active ride; `lib/services/{api,auth,notification,communication,location_reporter}.dart`.
- Driver: `lib/providers/driver_provider.dart` owns the socket; `lib/screens/availability_screen.dart` (dashboard/offer card), `lib/screens/trip_screen.dart`, `lib/screens/navigation_screen.dart`; `lib/services/{gps_tracker,navigation_service,notification_service}.dart`.
- Local persistence is `shared_preferences` only (tokens, `active_trip_id` on rider, sound/install id, route caches). There is no secure storage and no trip-intent persistence on the driver side.

### 1.3 Dashboard
- Per-page socket.io clients (LiveMonitoring, Rides, RideDetail); axios with a token interceptor; no shared socket provider, no query cache, no tests, no type-check in the build script.

---

## 2. Existing lifecycles (as-built)

### 2.1 Ride lifecycle
- `TripStatus`: `REQUESTED → ACCEPTED → DRIVER_ARRIVING → IN_PROGRESS → COMPLETED` plus `CANCELLED`. `DRIVER_ARRIVING` exists in the enum and in `services/machine.service.ts` but **no code path ever writes it**.
- Request: `RideService.requestRide` inserts the ride + price snapshot + promo/credits/wallet in one transaction, then enqueues matching (`matchQueue`) or runs `matchingService.findAndDispatch` when `LEGACY_SYNC_MATCHING=true`. Idempotency is a unique `rides.idempotency_key`, checked before insert.
- Dispatch: `DispatchEngine.executeMatching` walks radius stages 0/1/2, creates one exclusive `DriverOffer` (Redis, `SENT`), emits `newTripRequest` to `driver:{id}`, and polls for the offer status (500 ms) until accept/decline/cancel/expiry (`DRIVER_OFFER_TIMEOUT_MS`, default 20 s).
- Accept: `RideService.acceptTrip` validates offer ownership/status, `DriverOfferService.acceptOffer` (Redis, non-atomic read-check-write), then an atomic conditional `UPDATE rides ... WHERE status='REQUESTED'`, then fan-out cleanup, navigate cache, notifications.
- Driver pre-pickup cancel: atomic release back to `REQUESTED` + `ACCEPTED_THEN_CANCELLED` exclusion + star penalty + re-match the same ride.
- Terminal cancel: `RideService._terminalCancel` performs an atomic status-guarded UPDATE; rewards/sponsor teardown; notifications.
- Complete: `RideService.updateTripStatus` (`IN_PROGRESS` → `COMPLETED`) with wallet credit, financial ledger, Stripe shortfall collection, rewards, real notifications.

### 2.2 Driver availability lifecycle
- No DB online column is authoritative. Online = Redis `driver:heartbeat:{id}` (90 s TTL) written only as a side effect of `LocationsService.updateDriverLocation`.
- Socket-local `(socket as any).isOnline` gates location writes; it resets to `false` on every (re)connect.
- `goOnline` without lat/lng stores no heartbeat at all.
- Disconnect deliberately keeps location/heartbeat until TTL expiry. Ghost sweep removes drivers with expired heartbeats.
- Presence (`presence:{role}:{id}`, 60 s TTL) decides chat/call push vs socket delivery; nothing ever refreshes it.

### 2.3 Payment lifecycle
- Booking gate: `PaymentsService.assertRiderPaymentMethod` requires a saved card (seeded test users keep wallet).
- Completion: wallet charge (idempotent ledger key `wallet-charge:{rideId}`), Stripe off-session shortfall collection, one `financial_ledger` row per completion (`ride_completion:{rideId}`), sponsor reservations.
- Webhooks: signature verified with raw body; `stripe_webhook_events` claim (`ON CONFLICT DO NOTHING`) makes duplicate delivery a no-op; handlers idempotent via status guards.

### 2.4 Foreground/background/terminated handling (current)
| Scenario | Rider | Driver |
|---|---|---|
| Backgrounded mid-request | Matching continues server-side; no notification if offer screen unseen; client state only via socket. | Location stream stops (no background mode/service); heartbeat lapses in ≤90 s; still displayed "Online". |
| Backgrounded mid-trip | Socket may survive briefly; no background location; stale UI on return. | Navigation GPS is widget-scoped; no foreground service; proximity gates can fail with "location unknown". |
| Terminated mid-trip | `active_trip_id` + `getCurrentTrip` on connect restores state (no trip screen navigation). | `getCurrentTrip` restores ACCEPTED/IN_PROGRESS (no terminal-notice replay). |
| Killed while REQUESTED | Request survives server-side; sweep cancels after 10 min. | Offer expires in 20 s and is never pushed. |
| Notifications denied | Channel creation/permission requested; push inert without Firebase config files. | Same. |

---

## 3. Location, realtime, push, retries, persistence (as-built)

- **Location**: Redis GEO `driver_locations` + H3 index; no timestamp/accuracy/source persisted; `getDriverLocation` serves indefinitely-old positions as live to proximity gates and ETAs. No mock-location detection. Heartbeat TTL (90 s) and freshness math are duplicated magic numbers.
- **Realtime**: Socket.IO with `reconnection: true`, fixed 1–15 s delays, `randomizationFactor` (client side). No ack-based mutations, no event sequence/version, no duplicate suppression beyond ad-hoc sets, no cross-process presence, no reconciliation fetch on reconnect beyond `getCurrentTrip`.
- **Push**: FCM multi-device; deterministic `event_id` dedupe for lifecycle notifications; ride offers are **socket-only** (`pushRideOffer` exists but has zero callers); invalid-token code has a typo (`messaging/registration-token-not-registerred`), and one invalid token clears **all** of a user's tokens.
- **Retries**: `ride.request` has a unique idempotency key, but the rider app never persists or reuses one; accept/decline/cancel/complete are fire-and-forget socket emits with client-side fallbacks (`completeTripConfirmed` polls local state; driver cancel has a 12 s local fallback).
- **Session restoration**: rider persists `active_trip_id`, driver persists nothing; both rely on socket `getCurrentTrip`; no REST fallback on the mobile side.

---

## 4. Concrete defects found (prioritized)

Severity: P0 blocks correctness/safety in production; P1 breaks the failure/interruption model; P2 polish.

### P0
1. **Watchdog cancels scheduled rides** — `queue/jobs/cleanupStaleRides.ts:36-43` sweeps `REQUESTED > 10min` without excluding `is_scheduled=true`; also `services/cleanup.service.ts:49-54` (legacy copy). Revenue-losing, silent to the rider until cancellation push.
2. **Watchdog TOCTOU cancels just-started/completed rides** — sweeps query stale ids then call `cancelTripSystem`, whose atomic UPDATE still allows `IN_PROGRESS` (`ride.service.ts:1191-1209`); no re-check of `started_at`/`accepted_at`. Class 3 also anchors on `accepted_at`, so a long-but-legitimate pre-pickup wait can be cancelled (`cleanupStaleRides.ts:98-101`).
3. **Driver loses availability on every socket reconnect** — server `(socket as any).isOnline` resets on connect (`socket.gateway.ts:287`); the app never re-emits `goOnline` (`driver_provider.dart:457-468`). A blip silently un-tracks/undispatches the driver while the UI still says "Online".
4. **`goOnline` without coordinates writes no heartbeat** — schema makes lat/lng optional (`utils/socket-validation.ts:31-34`, handler `socket.gateway.ts:337-345`); dispatch silently excludes the driver.
5. **Ride offers are not delivered outside the socket** — backgrounded/terminated drivers never learn about an offer; 20 s expiry. `pushRideOffer` never called. No accept/decline notification actions; accept is socket-only (REST `POST /ride/accept` exists, no REST decline).
6. **Stale positions are served as live** — `locations.service.ts:348-357` has no timestamp/accuracy; used for pickup/complete proximity gates (`socket.gateway.ts:640-646, 720-725`) and ETAs. Blocks legitimate completions and lets spoofed/mocked positions complete rides.
7. **Rider double-submit creates two rides** — `map_screen.dart:905-960` has no in-flight guard and never passes an idempotency key; `ride_provider.dart:488` mints a fresh UUID per call.
8. **Cold-start rider restore can strand an ACCEPTED ride with no trip UI** — only the map panel flow navigates to `/trip` (`map_screen.dart:1147-1156`); a restored `ACCEPTED` observed before the panel opens leaves the rider on Explore.
9. **Rider stale `_tripId` permanently rejects the next trip's updates** — `requestRide` doesn't clear `_tripId` (`ride_provider.dart:511-515`); `tripUpdate` drops different-id payloads (`:229-235`); terminal states leave `_tripId` set.
10. **Rider socket is never initialized after password/OTP/signup login** — `initSocket` is called only in boot, OAuth, and foreground paths (`main.dart`, `login_screen.dart:51`); `requestRide` on a null socket is silently dropped while the UI spins forever (`map_screen.dart:947`, `ride_provider.dart:479-485`).
11. **Admin ride audit writes violate a foreign key** — `admin.controller.ts:992-999,1039-1046` insert the ride UUID into `audit_logs.target_id` (FK → `users.id`), so a successful cancel/complete returns an error and no audit row is ever written.
12. **Admin force-complete without a driver** — `admin.controller.ts:1014-1037` allows completing an unassigned ride; `updateTripStatus` skips all settlement when `driver_id` is null (no wallet, no ledger, no receipt).

### P1
13. **Driver app drops foreground pushes and never handles `notificationReceived`** — no `FirebaseMessaging.onMessage` listener; no local fallback; taps are trusted verbatim (`main.dart:44-49`) and can be lost on cold start (registered before `runApp`).
14. **Terminal `tripUpdate` for a different trip clears the current trip** — driver guard only covers ACCEPTED/IN_PROGRESS (`driver_provider.dart:519-525`); `COMPLETED`/`CANCELLED` apply unconditionally.
15. **`DRIVER_ARRIVING` is unhandled by both clients** and never emitted by the server; the rider UI labels pickup as "DESTINATION" for any non-ACCEPTED status (`trip_screen.dart:437-440, 561-578`).
16. **No location metadata/freshness enforcement in proximity gates**; no mock-location signal end-to-end; `speed` is stripped by the socket schema so trajectory `speed_mps` is always null (`utils/socket-validation.ts:40-42`, `locations.service.ts:172`).
17. **Presence TTL is never refreshed** (`push-notification.service.ts:613-617`); after 60 s every connected user is "offline", causing duplicate chat pushes; a second socket's disconnect can wipe the first's presence.
18. **Driver process-death loses cancellation/completion outcomes** — no persisted intents; `currentTripNone` deliberately does nothing when `_currentTrip == null` (`driver_provider.dart:470-480`), so a ride cancelled while the app was dead is never surfaced.
19. **Dashboard trusts repository-shaped socket payloads as REST-shaped rows** — `Rides.tsx:86-109`, `RideDetail.tsx:129-135` render `ride.rider.full_name` / `pickup_address` fields that don't exist in the socket payload (`ride.repository.ts:270-324`), blanking data after live updates.
20. **Dashboard has no reconnect resync or staleness indicator** — `LiveMonitoring.tsx:71-73` doesn't refetch on reconnect; offline drivers stay on the map; no connection badge.
21. **Rider socket re-init on foreground can leak duplicate sockets** (`ride_provider.dart:803-814`) and neither app refreshes the socket auth token after JWT rotation.
22. **Payment/api idempotency gaps outside rides**: admin credit grants use a random key per call (`credits.service.ts:266`); doc-review `FOR UPDATE` runs outside a transaction (`admin.controller.ts:2265-2284`).
23. **`drivers.fcm_token` schema drift** — Prisma declares it; no SQL migration creates it; `storeFcmToken` iterates the table provisioned by SQL migrations and errors after partly writing `device_tokens` (`push-notification.service.ts:113-117`).
24. **BullMQ connection drops auth/TLS** (`queue.ts:5-8`), so a `rediss://` production Redis breaks all queues.

### P2
25. Android lacks `ACCESS_BACKGROUND_LOCATION`/`FOREGROUND_SERVICE*` and any foreground service; iOS lacks the `location` background mode. (Both apps.)
26. Duplicate GPS streams during trips (availability `bestForNavigation` + navigation `high`).
27. Driver `UserCacheRepository.driverId` getter throws before call-site null checks (`driver_provider.dart:282 et al`), producing unhandled async errors.
28. Chat ack reconciliation and offline retry are wrong/incomplete on both apps; `detach()` is never called when the chat sheet closes.
29. Notification channel IDs are referenced by the backend but only `ride`/`default` are created client-side; `onMessage`/`onBackgroundMessage` are absent on both apps; FCM is inert without `google-services.json` / `GoogleService-Info.plist` (absent from the repo).
30. `logs`/`README` expose seeded admin credentials; `.env` files are committed; release builds use debug signing/cleartext; no CSP/security headers on the dashboard static server.
31. Missing metrics for driver online/stale/ghost removals, offers sent/expired, push delivery, cleanup outcomes; `Sentry` is init-only; hot paths log raw GPS with `console.log`.

---

## 5. State model gaps to close

1. `DRIVER_ARRIVING` must become real (server-triggered on proximity; clients render it) or be removed from the machine. Chosen: make it real.
2. `isOnline` must split into: **availability lease** (intent, server-side, TTL, renewed by `goOnline`/heartbeat), **location freshness** (timestamped observation), and **socket presence** (push routing). Today all three are conflated.
3. Rides need an optimistic-concurrency signal. The `rides` table has no `updated_at`; add one and ship it in every payload so clients can drop older events.
4. Offer acceptance must be a single idempotent server operation reachable from both socket and REST, with a stable `(tripId, offerId)` identity.
5. Unknown outcomes need explicit client states (`Acceptance pending`, `Cancellation unconfirmed`, `Trip restored`) instead of optimistic assumptions.

---

## 6. Prioritized implementation plan

| # | Item | Severity | Components | Tests |
|---|---|---|---|---|
| 1 | Watchdog: exclude scheduled rides; atomic age/status re-guard | P0 | `queue/jobs/cleanupStaleRides.ts`, `ride.service.ts` | unit predicates + SQL contract |
| 2 | Availability lease + reconnect re-assert + acked goOnline | P0 | gateway, locations, eligibility, both providers | unit lease/freshness + provider tests |
| 3 | Location metadata, freshness gates, mock/GPS-quality signal | P0 | locations, gateway, both apps | unit freshness; device manual |
| 4 | Offer push + REST accept/decline parity + notification actions | P0 | dispatch engine, push service, `feature.routes`, driver app | contract + manual |
| 5 | `DRIVER_ARRIVING` transition + client handling | P1 | ride.service, socket gateway, both providers/screens | state-machine + provider tests |
| 6 | Rider request idempotency, ack/timeout/retry, cold-start navigation | P0 | rider provider/map/main | provider tests |
| 7 | Driver terminal-event guards + missed-terminal notice on reconnect | P1 | driver provider, gateway `currentTripNone` | provider tests |
| 8 | Admin audit FK fix + force-complete guard | P0 | `admin.controller.ts` | unit test |
| 9 | Dashboard reconciliation on socket events + staleness UI | P1 | `Rides.tsx`, `RideDetail.tsx`, `LiveMonitoring.tsx` | build/typecheck |
| 10 | Presence refresh + FCM token typo/fan-out fixes | P1 | push service, gateway | unit |
| 11 | `rides.updated_at` migration + payload version + client ordering | P1 | schema, migration, repository, providers | unit |
| 12 | Background location: geolocator foreground service (Android) + background mode (iOS) on active-trip streams | P0 | both apps' Android/iOS config + services | device manual |
| 13 | Remove duplicate GPS streams; single navigation reporter | P2 | driver availability/trip/navigation | manual |
| 14 | Chat reliability + notification channel coverage | P2 | both apps | unit/device |

Dependencies: 11 before 7/9 ordering work; 2 before 4 (presence gating); 5 before client status UI.

---

## 7. Test strategy

- Backend: `node:test` suites registered in `tests/unit/backend/run-tests.cjs` (no Jest). New suites are pure-function/predicate/contract tests that run offline.
- Flutter: `flutter_test` unit tests for provider state machines, request idempotency, location reporter, and notification routing decisions. Widget/device verification is listed explicitly in the engineering report where a simulator/device was unavailable.
- Dashboard: `vite build` + `tsc --noEmit` as the automated gate (no test runner exists).

---

## 8. Implementation status

Tracked in `NETRIDE_ENGINEERING_REPORT.md` (what changed, what was verified automatically, what requires physical-device verification, remaining blockers).

Status as of 2026-10-13 (see the report for detail and verification evidence):

- P0 #1/#2 watchdog correctness — **done** (`ride-state.rules.ts`, guarded atomic cancel, scheduled-ride exclusion, unit-tested).
- P0 #3/#4 availability lease + reconnect re-assert + acked `goOnline` — **done** (driver lease `driver:online:*`, `driverAvailability` ack, honest UI states).
- P0 #5/#6 location metadata/freshness + offer push + REST accept/decline — **done** (`driver:loc:*` records, stale/mock gates, `pushRideOffer` on every offer, `POST /ride/decline`, notification actions, `getPendingOffer` replay).
- P0 #7/#8/#9/#10 rider request safety + recovery — **done** (stable idempotency key + REST fallback + ack reconcile, terminal `_tripId` release + settled-id guard, cold-start trip navigation from the map, socket re-init after every login path).
- P0 #11/#12 admin audit FK + force-complete guard — **done** (`audit_events`, driverless completion rejected).
- P1 #13/#18 driver foreground push + missed terminal outcome — **done** (onMessage local re-post, missed-terminal notice).
- P1 #14/#15 version ordering + `DRIVER_ARRIVING` — **done** (rides.updated_at shipped/consumed; clients render arriving/arrived).
- P1 #16/#17 presence refresh + FCM token fixes — **done**.
- P1 #19/#20 dashboard reconciliation/staleness — **done** (merge-not-replace, reconnect resync, LIVE/RECONNECTING badges).
- P1 #21 rider socket lifecycle — **done** (login-path init + foreground resync).
- P1 #22/#23/#24 — **done** (admin credit idempotency key, FCM column migration, BullMQ TLS/auth).
- P0 #12 background location (Android foreground service + iOS background mode) — **implemented; device verification pending** (see report §4).
- P2 #25–#31 — partly done (channels, single GPS stream, ghost/stale metrics); chat reliability, Play/security hardening remain (see report §5).
