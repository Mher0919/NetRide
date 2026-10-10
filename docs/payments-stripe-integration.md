# NetRide Payments — Stripe Integration (Connect: separate charges & transfers)

This document is the operation + handoff guide for the payment system
implemented in this repository. It accompanies `docs/ride-financial-hardening.md`
and `docs/sponsors-specials-deliverable.md`.

---

## 1. Architecture decision

| Concern | Decision |
|---|---|
| Stripe product | **Connect — separate charges and transfers** |
| Rider charges | Platform `PaymentIntent`s (Checkout for wallet top-ups / card setup) |
| Sponsor amounts | Collected to the platform (Checkout `mode=payment`), credited to the sponsor's funded budget ledger |
| Driver payouts | Stripe **Transfers** to driver Express connected accounts (Stripe-hosted onboarding) |
| Commission policy | Unchanged — `revenue_configs` (default **60% driver / 40% platform**), fleets sub-split. Driver earnings are ALWAYS computed from the **original quoted fare** |
| No-show fallback | Saved payment method + explicit consent + off-session `PaymentIntent` (the task's documented alternative) |
| Existing rails | Rider wallet stays the primary stored-value rail; the ledger `financial_transactions`, `payouts`, `sponsor_ledger_entries` are extended, not replaced |

**Why "separate charges and transfers"?** A Special fare has two funding
sources (rider + sponsor) with the driver's payout governed by a separate
commission policy; Connect transfers let NetRide pay the driver a commission-
derived amount after collecting both parts to the platform. The platform
retains responsibility for Stripe fees, refunds and disputes — recorded as
`stripe_fee_cents` on `stripe_payments` and surfaced to admin.

**Why not authorization-capture-later for the no-show?** The existing
lifecycle settles at completion and keeps wallet-first semantics; a manual-
capture hold across the 24 h validation window would (a) hold the rider's
funds beyond the ride, and (b) be unusable for wallet-funded riders. The
saved-PM off-session flow (with explicit consent at booking) is Stripe's
standard approach for conditional post-payment charges and preserves the
existing rail.

### Booking rule (server-enforced)

A **saved payment card is required to request any ride**. The backend checks
`stripe_customers.default_payment_method_id` at `requestRide` and refuses with
`code=PAYMENT_METHOD_REQUIRED` (REST 402 / socket `paymentMethodRequired`
event). The rider app preflights the same check and redirects to the Payment
Method page. Exceptions: (a) Stripe is not configured at all — the legacy
wallet rail remains the only rail; (b) seeded `@netride.test` test accounts —
so the sandbox keeps working without real cards.

### Money model (all integer cents, server-computed)

```
original fare  F  = rider_share + sponsor_subsidy + promo + credits
driver earnings   = commission(F)                  ← invariant, never from the discounted amount
platform          = F − driver earnings − processing fees

successful special: rider pays $5, sponsor budget debits $5 → platform $10
expired special   : rider pays $5 at completion + $5 on expiry → $10, sponsor $0
```

The accepted ride's `ride_fare_breakdowns` snapshot is immutable: later
campaign/commission edits can never rewrite it.

### No rider cash-back (old model removed)

The pre-existing post-validation reward flow (REFUND to wallet / CREDITS at
110%) is **gone**. Validating the code now settles the special server-side
automatically: the sponsor's contribution is collected from the funded
budget, the redemption moves to `REWARD_COMPLETED`, and **no money is sent
back to the rider**. The $5 referral rewards are separate (`ReferralService`,
`payout_method`/`wallet_transactions` untouched) and still operate.

### Manual withdrawals — drivers and sponsors (once per week, Mondays)

The automatic weekly payout sweep is **retired** (`WeeklyPayoutsService` is
a no-op guard). Every payout is created manually:

- **Drivers** press Withdraw in the driver app (`POST /driver/wallet/request-payout`);
  the row stays PENDING and NetRide pays it out manually (admin Payouts page —
  existing mark-paid flow, or the Connect transfer action when the driver has
  an enabled Express account).
- **Sponsors/Colabs** press Withdraw in the sponsor portal (Budget & funding →
  Withdraw funds). The amount is **refunded to the sponsor's funding card**
  via Stripe refunds of their top-up charges (idempotent per withdrawal,
  recorded as `WITHDRAWAL` sponsor-ledger entries). Sponsors also manage a
  saved card from the portal (used for top-ups and as the refund destination).

**Shared weekly rule** (`modules/payments/withdrawal.service.ts`, unit-tested):
one withdrawal per calendar week; the window opens **every Monday 00:00 UTC**
— a withdrawal on any day makes the next opportunity the *following* Monday;
accounts that never withdrew are immediately eligible. Violations are refused
with `WITHDRAWAL_UNAVAILABLE` + `nextAvailableAt`, and the state is returned
in `GET /driver/wallet` (`withdrawal`) and `GET /api/sponsor/withdrawals`.

---

## 2. Backend surface

New module: `backend/src/modules/payments/`

| File | Responsibility |
|---|---|
| `stripe.client.ts` | SDK client + **test/live interlock** (`sk_live_` refused unless `STRIPE_ALLOW_LIVE=true` and `NODE_ENV=production`) |
| `stripe.gateway.ts` | Narrow gateway interface + real adapter + test injection (`setStripeGatewayForTests` throws in production) |
| `fare-breakdown.service.ts` | Authoritative, immutable fare snapshot (pure math + persistence) |
| `payments.service.ts` | Customers, Checkout sessions (card setup / wallet top-up / sponsor funding), off-session charges, refunds, webhook state application, reconciliation |
| `connect.service.ts` | Express account lifecycle, onboarding links, transfer execution, payout-readiness verification |
| `ride-settlement.service.ts` | Completion settlement, special redemption settlement (driver true-up), **expiration additional charge**, retry sweep, reconciliation endpoints |
| `webhook.service.ts` | Idempotent verified-webhook dispatch (`stripe_webhook_events` PK=event id) |
| `payments.controller.ts` / `payments.routes.ts` | Rider/driver endpoints + public Checkout return redirects |
| `admin-payments.controller.ts` / `admin-payments.routes.ts` | Admin reconciliation/exception/refund/transfer endpoints |

Endpoints:

- Rider: `GET /api/payments/config|profile|methods|history`, `POST /api/payments/setup-session|wallet/topup-session|consent`, `DELETE /api/payments/methods/:id`, `GET /api/payments/ride/:rideId/status` (owner or assigned driver only).
- Driver: `GET /api/payments/connect/status?sync=true`, `POST /api/payments/connect/onboarding`.
- Sponsor portal: `GET /api/sponsor/funding`, `POST /api/sponsor/funding/session`,
  `GET /api/sponsor/payment-method`, `POST /api/sponsor/payment-method/card-setup-session`,
  `GET /api/sponsor/withdrawals`, `POST /api/sponsor/withdrawals/request`.
- Admin: `GET /api/admin/payments/overview|settlements|events`, `POST /api/admin/payments/:id/reconcile|refund`, `POST /api/admin/payments/rides/:rideId/retry-additional-charge`, `POST /api/admin/payments/payouts/:payoutId/transfer`.
- Webhook: `POST /api/payments/webhook` (raw body, registered **before** `express.json`).

Database (migrations `051_stripe_enums.sql`, `052_stripe_payments.sql`,
`053_ride_special_consent.sql` — already applied to the dev database):
`stripe_customers`, `driver_stripe_accounts`, `stripe_payments`,
`stripe_webhook_events`, `ride_fare_breakdowns`, new columns on
`financial_transactions` (original fare, rider/sponsor components, Stripe
references), `payouts.stripe_transfer_id/status`, wallet `WALLET_TOPUP` +
`payout_method 'SPECIAL_TOPUP'`, `rides.special_terms_accepted_at`.

### Special lifecycle integration points

- `SpecialRedemptionService.attachToRideRequest` now **requires**
  `specialTermsAccepted: true` (persisted as `rides.special_terms_accepted_at`).
- `RideService.acceptTrip` snapshots the immutable breakdown
  (`RideSettlementService.snapshotOnAccept`).
- `RideService.updateTripStatus` (COMPLETED) writes the richer ledger row and
  calls `RideSettlementService.onRideCompleted` (Stripe shortfall collection +
  sponsor reservation state). Driver credit is unchanged and already computed
  from the ORIGINAL fare.
- `riderChooseReward` no longer double-pays the driver: the sponsor's $5 is
  recorded as collected (`sponsor_collected_cents`, `DISCOUNT_REDEEMED`), and
  `onSpecialRedemptionSettled` only tops the driver up to `commission(F)` when
  a *legacy* ride was settled from the discounted fare (`SPECIAL_TOPUP`).
- `expireRedemption` (the 5-minute cron) now runs the no-show fallback:
  rider is charged the remaining fare (wallet first, then saved card
  off-session), sponsor contributes $0, ledger records the additional charge.
  `sweepExpiredAdditionalCharges` retries failed/required charges (max 3) and
  `reconcileSettledRedemptions` fixes any crash window between the redemption
  transaction and the component write.

### Idempotency and race handling

- `stripe_webhook_events` PK on the Stripe event id → duplicates skipped.
- `stripe_payments.idempotency_key UNIQUE` → no double PaymentIntent.
- Every transfer uses `Stripe` idempotency keys (`payout-transfer:{id}`).
- Redemption expiry is claimed atomically (`status='WAITING_FOR_SPONSOR' →
  'EXPIRED'` conditional update); the additional charge is claimed via a
  conditional `ride_fare_breakdowns` update; repeated cron executions,
  duplicate webhooks and concurrent redemption attempts are no-ops.
- `financial_transactions` keeps its partial-unique-per-ride guard.

---

## 3. Local sandbox setup (test mode, no real money)

### 3.1 Stripe account — set up entirely from the website (no terminal needed)

Everything below happens in your browser at https://dashboard.stripe.com —
the terminal is never required for setup:

1. Create a Stripe account (or a dev org): https://dashboard.stripe.com/register
2. Developers → API keys → copy the **test** keys (`sk_test_…`, `pk_test_…`).
3. Connect → **Enable Connect / create a platform** (Express accounts; the
   integration does not need the OAuth flow, so the Client ID is optional).
4. Developers → Webhooks → **Add endpoint**
   `https://<your-backend>/api/payments/webhook` and subscribe to:
   `checkout.session.completed`, `setup_intent.succeeded`,
   `payment_intent.succeeded`, `payment_intent.payment_failed`,
   `payment_intent.canceled`, `charge.refunded`, `account.updated`,
   `transfer.created`, `transfer.failed`, `transfer.reversed`.
   Click **Reveal signing secret** → copy `whsec_…`.

> The dashboard delivers webhooks over the public internet. For a local
> backend you have two options:
> * deploy/stage the backend somewhere public (e.g. the free Render
>   instance already configured in `render.yaml`) and register that URL; or
> * use the Stripe CLI (`stripe listen --forward-to …`) **only if** you want
>   the convenience of local forwarding — the CLI is optional.
>
> The coding agent cannot create the Stripe account or provide working
> credentials. With no keys configured the app keeps working on the legacy
> wallet rail and no payment is faked.

### 3.2 Configure the backend

```bash
cd backend
copy .env.example .env        # or edit your existing .env
# .env:
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_ALLOW_LIVE=false
PUBLIC_BACKEND_URL=http://localhost:3000
SPONSOR_PORTAL_URL=http://localhost:5174
```

### 3.3 Local webhook forwarding (Stripe CLI)

```bash
stripe login
stripe listen --forward-to localhost:3000/api/payments/webhook
# → prints: Ready! Your webhook signing secret is whsec_...
# copy that secret into STRIPE_WEBHOOK_SECRET and restart the backend
```

Test events can be triggered with the CLI, e.g.:
`stripe trigger payment_intent.succeeded` — the event lands in
`stripe_webhook_events` (check the admin Payments → Webhook events tab).
Alternatively use the Dashboard → Developer → Events list in the browser.

### 3.4 Seed the test accounts

```bash
cd backend
node scripts/seed-payment-fixtures.cjs   # sponsor + 2 riders + 2 drivers (@netride.test)
node scripts/reset-payment-fixtures.cjs  # wipe them any time
node run-payments-integration.cjs        # offline money-flow tests (fake Stripe, real DB)
```

> The seeded `@netride.test` accounts are exempt from the saved-card booking
> rule so the sandbox works without cards. Real accounts must add a card
> (Payment Method page → Add payment card) before requesting any ride.

### 3.5 Run end-to-end with Stripe test mode

```bash
cd backend
npm run dev                               # backend on :3000
npm --prefix ../apps/admin_dashboard run dev
npm --prefix ../apps/sponsor_portal run dev
# rider app: flutter run -d <device>  (use the seeded test credentials)

node run-stripe-e2e.cjs                   # real test-mode Stripe flow (needs test keys)
```

### 3.6 Test cards (Stripe official — TEST values only, no real money moves)

| Scenario | Card | Expiry | CVC |
|---|---|---|---|
| Success | `4242 4242 4242 4242` | any future (e.g. `12/34`) | any (e.g. `123`) |
| Decline | `4000 0000 0000 0002` | any future | any |
| Insufficient funds | `4000 0000 0000 9995` | any future | any |
| 3DS required | `4000 0000 0000 3220` | any future | any |

These are **test** cards — the transactions run in Stripe test mode and never
move real money. Never enter real card details in test mode. Full list:
https://docs.stripe.com/testing

---

## 4. Automated tests

| Suite | Command | Coverage | Status |
|---|---|---|---|
| Unit (255 tests) | `cd backend && node run-tests.cjs` | fare breakdown math, additional-charge due, settlement states, Stripe env interlock, gateway injection guard (+ pre-existing suites) | ✅ run and green |
| Settlement integration (54 asserts) | `cd backend && node run-payments-integration.cjs` | $10 special success (rider $5 + sponsor $5, driver $6 from original fare, no double-pay), expiry (rider charged $5 once, sponsor $0), decline + retry, ordinary ride, consent/security | ✅ run and green (fake Stripe adapter, real Postgres) |
| Real Stripe sandbox E2E | `cd backend && node run-stripe-e2e.cjs` | customer, top-up session, off-session charge with test card, webhook application | ⛔ not run — requires sandbox credentials (script self-skips without `sk_test_…`) |

The fake gateway only activates via `setStripeGatewayForTests`, which throws
when `NODE_ENV=production` — a test-only adapter can never be active in
production.

---

## 5. External setup still required (no claims of completion)

1. **Stripe account + test keys** (Dashboard) — see §3.1.
2. **Connect platform activation** and (for real driver payouts) compliance
   information for your business; live-mode enablement and country coverage.
3. **Webhook endpoint registration** with `STRIPE_WEBHOOK_SECRET`.
4. **Driver onboarding**: each driver must complete Stripe-hosted onboarding
   (`POST /api/payments/connect/onboarding` → Express account link). Payout
   transfers are blocked until Stripe reports `payouts_enabled`
   (`driver_stripe_accounts` is synced from `account.updated` webhooks and
   `GET /api/payments/connect/status?sync=true`).
5. **Production activation**: set keys (live), `STRIPE_ALLOW_LIVE=true`,
   `NODE_ENV=production`, and re-verify every scenario. This must remain a
   deliberate step — the interlock refuses live keys otherwise.

---

## 6. Outstanding risks / decisions

- **Saved-card requirement**: every real rider must add a card before any
  ride request; riders without a card cannot be collected at expiry either,
  so the gate prevents uncollectable rides by construction. The existing
  wallet still funds rides; the card is the required backup rail.
- **Stripe fees** are captured where balance-transaction data is available;
  rides settled wholly by internal wallet carry no fee. Fees on legacy rows
  will be absent until reconcile runs.
- **Authorization chosen over capture-hold** (see §1): the booking rule
  guarantees a card exists, so expiry collection always has a rail; failures
  become admin-visible exceptions (`settlement_status='EXCEPTION'`).
- **Off-session authentication**: cards returning `authentication_required`
  are recorded as REQUIRED and retried by the sweep; persistent failures
  surface in the admin Payments page.
- **Multicurrency**: all money is `usd` today; the schema stores `currency`
  per row for future expansion.
- **Chargeback handling**: `charge.refunded` marks payments refunded; full
  dispute workflows (dispute evidence, loss accounting) are not automated.
- **Weekly payout sweep** is retired: payouts are manual only (driver
  Withdraw button), one per week, window opens Monday 00:00 UTC; driver
  payouts are paid out manually or via the Connect transfer action. Sponsor
  withdrawals are Stripe refunds of funding charges — cards older than
  Stripe's refund window (or disputed top-ups) surface as FAILED withdrawal
  rows retried by the sweep cron and flagged for manual admin attention.