# Sponsorship / SPECIALS Platform — Deliverable Summary

Everything below is implemented in the working tree and passes verification
on the states claimed: `tsc --noEmit` clean on `backend/`, `apps/admin_dashboard/`
and `apps/sponsor_portal/`; the backend unit-test suite (`node run-tests.cjs`,
including the 11 new sponsor tests) passes with zero failures; both web apps
build (`npm run build`); the rider Flutter app is free of analyzer **errors**
(`flutter analyze lib` — remaining items are pre-existing info/warnings, none
in new files).

## 1. Scope delivered

Sponsor-funded ride discounts ("SPECIALS"): sponsors fund a budget, riders
discover businesses, book a ride, visit, get a one-time code validated by the
business, then collect cash back (REFUND) or +10% bonus ride credits
(CREDITS). Settlement: 60% of the sponsor-funded discount to the driver
(`SPONSOR_CREDIT` payout), 40% to NetRide. All money is integer cents and all
money decisions are server-side; clients only signal intent and render.

## 2. Database (migration 046a + 046)

- `backend/migrations/046_sponsors.sql` — `sponsors`,
  `sponsor_portal_accounts`, `sponsor_ledger_entries` (audit source for every
  budget movement), `special_redemptions` (canonical domain object with
  immutable sponsor snapshots), eligibility/geo/code indexes,
  `rides.sponsor_discount_cents`, `users.specials_intro_seen_at`, wallet
  `SPONSOR_REWARD` type, driver `payout` `SPONSOR_CREDIT` with a partial
  unique index on `ride_id` (one sponsor payout per ride), one
  `DISCOUNT_REDEEMED` ledger entry per redemption (partial unique on
  `reference_id`).
- **Migration-splitting fix discovered during apply:** Postgres error 55P04 —
  `ALTER TYPE ... ADD VALUE` values cannot be *used* in the same transaction
  that added them, and `046` uses `'SPONSOR_CREDIT'` in a partial index
  predicate. Enum only additions moved to
  `backend/migrations/046a_sponsors_enums.sql` (`user_role 'SPONSOR'`,
  `payout_method 'SPONSOR_CREDIT'`).
- **Apply order (dev DB already applied + verified):**
  - `npx ts-node src/scripts/run-migration.ts 046a_sponsors_enums.sql`
  - `npx ts-node src/scripts/run-migration.ts 046_sponsors.sql`
- `backend/prisma/schema.prisma` `UserRole` synced with `SPONSOR`.

## 3. Backend — sponsor management (admin)

`backend/src/modules/sponsor/sponsor.service.ts` + `admin-sponsor.controller.ts`
+ `admin-sponsor.routes.ts` (mounted at `/api/admin`, admin-guarded):
list/search, create (business profile + %/fixed discount + initial funding
cents), detail, update, status (ACTIVE/INACTIVE/SUSPENDED/DEPLETED with
double-confirm), budget CREDIT/DEBIT adjustments (required reason, written to
`sponsor_ledger_entries` with idempotency key), ledger view, financial history,
analytics, redemption overview, and portal-account management (create with
one-time password reveal, reset, disable). Every mutation is audit-logged.

## 4. Backend — SPECIALS lifecycle (rider)

`backend/src/modules/sponsor/specials.controller.ts` + routes (mounted at
`/api`): `GET /specials` (public geo-filtered discovery),
`GET /specials/count`, `GET /specials/:id`, `GET /specials/intro-state`,
`POST /specials/intro-seen`, `POST /specials/:id/redemption` (CREATED),
`GET /specials/redemptions/current` (resumable), 
`POST /specials/redemptions/:id/verified`, 
`POST /specials/redemptions/:id/reward` (REFUND|CREDITS, `confirmed` flag).

## 5. Backend — ride integration

- `RequestRideSchema` gained `specialRedemptionId` (UUID, optional);
  `socket.gateway.ts` passes it through.
- `ride.service.ts` `requestRide`: inside the ride's own transaction,
  `SpecialRedemptionService.attachToRideRequest` runs **after**
  `RewardEngine.applyToRideRequest` (promo/credits) and applies the sponsor
  discount to the **gross** fare (order per spec §73): `FOR UPDATE` on the
  redemption + sponsor row, spendable-budget check, reservation, snapshot,
  `rides.final_payment_cents = GREATEST(0, final_payment_cents − discount)`.
  Any failure aborts the whole ride request — invalid/unavailable specials
  never create rides.
- `SpecialRedemptionService.onRideCompleted(tripId, riderId)` on COMPLETED
  (unconditional call, no-op for regular rides): issues a 6-digit code
  (HMAC-SHA256 hash storage only, 24 h TTL) → `WAITING_FOR_SPONSOR`.
- `SpecialRedemptionService.onRideCancelled(tripId)` on terminal cancellation
  (after `RewardEngine.onRideCancelled`): voided with reason `RIDE_CANCELLED`.
  Driver pre-pickup rematches keep the DB row `REQUESTED`, so the special
  survives rematch; only terminal cancels void it.
- Redis/socket: `specialRedemptionUpdate` emitted to `rider:<id>` on every
  transition (minified card payload — no plaintext codes).

## 6. Backend — wallet/credits settlement

`special-redemption.service.ts` `riderChooseReward` (idempotent — retries are
exact no-ops): from `SPONSOR_VALIDATED`, `D` = calculated discount;
`driverAllocation = round(0.60·D)` (driver `SPONSOR_CREDIT` payout, partial
unique on `ride_id`), `netrideAllocation = D − driverAllocation`, then either
`WalletService.post(…, +D, 'SPONSOR_REWARD')` (REFUND) or
`CreditsService.post(…, round(1.10·D), 'SPONSOR_REWARD', …)` (CREDITS; the
extra 0.10·D is `netride_bonus_cents`, a NetRide expense). Both share
`WalletService`/`CreditsService` semantics verified against the existing
services: internal BEGIN/COMMIT, guarded `balance_cents ≥ 0` debit, dedupe on
`idempotency_key` (`specialReward:{redemptionId}`), optional socket emit.
`WalletTxType` and `CreditTxType` unions both extended with `'SPONSOR_REWARD'`.

## 7. Backend — sponsor portal

`sponsor-auth.service.ts` (JWT `sponsor_token`, 12-h expiry, bcrypt login,
first-login forced password change), `sponsor-portal.controller.ts` + routes
(mounted at `/api`, sponsor-scoped — a portal account only ever sees its own
sponsor's redemptions/customers/settings): login, change-password, dashboard
(stats + validate), validations list, validate-code (server-side double
confirm; exact hash match, TTL + attempt caps, one-time), cancel (reason
codes + double confirm, releases reserved budget), customers, settings
(contact fields only; discount read-only).

## 8. Backend — notifications + expiry cron

- `special-notifications.ts`: `special_reward_ready` (the ONLY delivery of the
  plaintext code — in-app + FCM payload, never stored/logged), 
  `special_reward_credited`, `special_refunded`.
- `backend/src/app.ts`: `specialsRoutes`, `sponsorPortalRoutes`,
  `adminSponsorRoutes` mounted; cron
  `SpecialRedemptionService.expireStaleRedemptions()` every 5 minutes
  (`EXPIRED` terminal + reservation release), alongside the existing 2-minute
  cleanup.

## 9. Tests (backend)

`backend/src/modules/sponsor/__tests__/sponsor-discount.unit.test.ts`
(registered in `run-tests.cjs`, **11 tests, all pass**):
- `computeSponsorDiscount`: percentage of fare; capped by
  `max_discount_percent`; never exceeds the fare; fixed amount clamped to
  fare; garbage input never goes negative
- `discountLabelFor`: human-readable label
- settlement: 60% driver / 40% NetRide + 10% credit bonus; rider reward never
  exceeds sponsor-funded discount
- budget invariant mirroring the real SQL semantics (reservation moves
  spendable→reserved without touching remaining; conservation at rest;
  expire/reversal release restores; spendable never negative)
- `centsValue`: BIGINT-as-string money parsing

Full suite run: zero failures. `npx tsc --noEmit` in `backend/`: clean.

## 10. Admin dashboard (web)

- `src/api/admin.ts`: fully typed sponsor functions (no `any`): `listSponsors`,
  `createSponsor`, `getSponsor`, `updateSponsor`, `setSponsorStatus`,
  `adjustSponsorBudget`, `getSponsorLedger`, `getSponsorFinancialHistory`,
  `getSponsorAnalytics`, `listSponsorRedemptions`, `createSponsorPortalAccount`,
  `resetSponsorPortalPassword`, `disableSponsorPortalAccount`.
- `src/pages/Sponsors.tsx`: table (search + status filter), create dialog
  (business profile + discount + initial funding), detail drawer with tabs —
  Overview (budget cards + discount, adjust budget), Ledger, Settlements
  (60/40 financial history), Analytics (8 stat cards), Portal Account (create
  → password shown once, reset, disable); budget adjust dialog (CREDIT/DEBIT +
  required reason); double-confirmed status changes; snackbar feedback.
- Route `/sponsors` + sidebar "Sponsors" (StorefrontIcon) wired.
- `npx tsc --noEmit` clean; `npm run build` ✓; lint clean on the new/changed
  files (remaining `263 problems` are pre-existing legacy debt elsewhere).

## 11. Sponsor portal (new standalone web app)

`apps/sponsor_portal/` (Vite 8 + React 19 + MUI v9 + react-router 7, dev port
5174, own lockfile — the repo root is not an npm workspace):
- `src/api/index.ts` axios client (sponsor_token interceptor, 401 → /login);
  `src/api/sponsor.ts` typed API; `src/context/AuthContext.tsx` (lazy
  localStorage restore, no sync setState-in-effect);
- Pages: `Login` (must-change-password redirect), `ChangePassword` (8+ chars,
  invalidates session → login), `Dashboard` (business header, stats cards,
  validate-code dialog with double confirm), `Validations` (status tab chips,
  table with rider/discount/expiry/status, validate + double-confirmed cancel
  with reason codes), `Customers`, `Settings` (contact-only patch);
- `MainLayout` drawer + app-bar avatar menu with logout; `App.tsx` routes.
- `npx tsc --noEmit` clean; `npm run build` ✓ (chunk-size warning only);
  `npx eslint .` clean (0 problems) — including the prior
  `react-hooks/set-state-in-effect` and `no-explicit-any` debt.

## 12. Rider Flutter app

- `lib/models/special_models.dart`: `SponsorSpecial`, `SpecialRedemption`
  (lifecycle-aware `isActive`).
- `lib/services/specials_service.dart`: all rider endpoints incl.
  `recoverCode()` — re-reads the one-time code from the in-app notification
  history (`GET /api/notifications` carries the `data` block) when the push
  tap was missed.
- `lib/providers/specials_provider.dart`: discovery list, count badge, intro
  gate, resumable current redemption; subscribes to the new RideProvider
  socket relay (`specialRedemptionUpdate`) + notification ping so the active
  card re-renders live; `canAttachToRide` gates checkout attachment.
- `lib/providers/ride_provider.dart`: `specialRedemptionUpdates` broadcast
  stream wired to the socket; `requestRide` emits `specialRedemptionId`
  (already in place).
- Screens: `SpecialsScreen` (4th bottom tab "Specials" with count badge,
  intro card, active-redemption banner, discovery list), `SpecialDetailScreen`
  ("Visit and save" → CREATED), `SpecialRedemptionScreen` (full lifecycle:
  CREATED prompt → RIDE_PENDING → big **code** display + "I got verified" →
  REFUND/CREDITS reward choice with confirm dialog → REWARD_COMPLETED /
  CANCELLED / EXPIRED states; code recovered from push args or history).
- `map_screen.dart`: `_confirmRide` attaches a CREATED redemption from the
  provider; checkout shows a "SPECIAL at …" chip above the confirm button.
- Notification taps: `special_reward_ready` opens the redemption card with the
  code from the payload.
- `flutter analyze lib`: **0 errors** in the new files (only pre-existing
  info/warnings across the app remain).

## 13. Env vars

No new env vars required — reuses `JWT_SECRET`, `DATABASE_URL` and the
existing `WalletService`/`CreditsService`/`payout` machinery.
`run-tests.cjs` already pins `REDIS_URL`/`PORT` for offline runs.

## 14. Manual verification steps (dev database — already done here)

1. Apply migrations: `npx ts-node src/scripts/run-migration.ts
   046a_sponsors_enums.sql` then `… 046_sponsors.sql` (applied ✓; re-run is a
   no-op — `IF NOT EXISTS` throughout).
2. Seed a sponsor (applied ✓): Blue Bottle Coffee — Downtown, 20% up to 25%,
   $15,000.00 = 1,500,000 cents, ACTIVE + eligible; `GET /api/specials`
   returns it.
3. `node run-tests.cjs` → sponsor block 11/11; full suite 0 failures.
4. Admin `/sponsors` (admin dashboard, `npm run dev`): create sponsor →
   portal account create shows the one-time password; budget adjust CREDIT
   appears in the Ledger; analytics tiles populate.
5. Rider app: Specials tab (badge = 1) → sponsor card → "Visit and save" →
   checkout "SPECIAL at …" chip → confirm ride → ride completes → code push →
   show code → sponsor portal Validate → rider chooses reward → wallet /
   credits reflect it; driver payout shows `SPONSOR_CREDIT`.

## 15. Known limitations / deferred

- Sponsor portal + admin builds pass; only the rider app remains exercised on
  a physical device/emulator for the full ride flow (no emulator run in this
  session).
- Driver Flutter earnings surface does not yet render `SPONSOR_CREDIT`
  payouts distinctly (booked correctly server-side; display follow-up).
- The global redemption list endpoint (`listSponsorRedemptions`) exists but
  has no dedicated admin UI page yet (per-sponsor views cover it).
- `recoverCode()` leans on the last 50 notifications; a very old unclaimed
  code still shows the "check your notification" hint.
- Partial unique indexes don't exist on `wallet_transactions`/credits for
  sponsor rewards; idempotency is enforced via `idempotency_key` as with the
  existing wallet/credits services.

## 16. File inventory (new/changed)

- Backend: `app.ts`, `socket-validation.ts`, `socket.gateway.ts`,
  `ride.service.ts`, `wallet.service.ts`, `credits.service.ts`,
  `modules/sponsor/*` (services, controllers, routes, notifications,
  `__tests__/sponsor-discount.unit.test.ts`), `migrations/046a_*.sql`,
  `migrations/046_sponsors.sql`, `prisma/schema.prisma`, `run-tests.cjs`.
- Admin: `pages/Sponsors.tsx`, `api/admin.ts`, `components/MainLayout.tsx`,
  `App.tsx`.
- Portal: `apps/sponsor_portal/**` (new app).
- Rider: `models/special_models.dart`, `services/specials_service.dart`,
  `providers/specials_provider.dart`, `providers/ride_provider.dart`,
  `screens/{specials,special_detail,special_redemption}_screen.dart`,
  `screens/map_screen.dart`, `screens/main_wrapper.dart`, `main.dart`.

## 17. Verification status

| Check | Result |
|---|---|
| `backend` `tsc --noEmit` | clean |
| `backend` `node run-tests.cjs` | 0 failures (sponsor 11/11) |
| `admin_dashboard` tsc + build | clean / ✓ built |
| `sponsor_portal` tsc + lint + build | clean / 0 problems / ✓ built |
| `rider_flutter` `flutter analyze` | no errors in new files |
| Migration 046a + 046 applied (dev) | ✓ |
| Dev sponsor seeded & eligible | ✓ |
