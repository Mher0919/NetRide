# NetRide Database Access, RLS and Authorization Audit

Date: 2026-10-28
Scope: production database catalogs, the trusted backend access paths, Supabase Storage, Socket.IO realtime, and the repository migrations/configuration.
Database inspected: Supabase-managed PostgreSQL 17.6, PostGIS 3.3.7, extensions in `public`/`extensions`, Supabase Storage schema, roles `anon`, `authenticated`, `service_role`, `postgres`, `supabase_storage_admin`.
No secret values (passwords, keys, tokens, object paths) are reproduced in this report.

---

## A. Executive summary

The application does **not** use Supabase PostgREST as a data API. It uses the GoTrue service only for OAuth verification, issues its own HS256 JWTs from the Node backend, and performs all relational reads/writes through the `postgres` database connection. The Flutter apps do ship the Supabase URL and anon key (client-side by design) and use Supabase Auth; they do not query tables, Storage or Realtime directly.

The most important findings were:

1. **Supabase Storage was directly writable/readable by `anon` and `authenticated`.** Eight permissive policies on `storage.objects` only checked `bucket_id = 'uploads'`. Anyone with the client-shipped anon key could list, upload, overwrite and delete objects. This was confirmed by role simulation and by the Storage API returning object listings. The policies have been removed; effective listing is now zero rows.
2. **Nine private-classified files (including referenced licence front/back and registration images) were still in the public `uploads` bucket.** The 057 data move had not been run. Before hardening, the Storage API listed objects and a private-classified object's direct public URL returned HTTP 200. Listing is now closed, but a **known public URL is still downloadable** until the new signed-URL backend is deployed, the bucket is made private, and the objects are moved to `secure-documents`. This remains the highest residual risk.
3. **`spatial_ref_sys` is not a vulnerability.** It is the extension-owned PostGIS EPSG reference table (8,500 static rows, owner `supabase_admin`, PUBLIC SELECT only, no write grants). `anon`/`authenticated` cannot reach the `public` schema. Enabling/forcing RLS would not add protection and would risk coordinate-transform/extensions behaviour. It is a documented exception; no structural change was made.
4. **The public-schema RLS policies from migrations 016/020/024/025 were dead but dangerous.** They assume Supabase Auth (`auth.uid()`), while NetRide users are custom JWT subjects. Had a grant ever been restored, the `users`/`drivers` UPDATE policies would have allowed self-service role/verification escalation because RLS cannot restrict columns. All direct-client policies were removed and the direct Data API denial was codified in a migration.
5. **Several application access paths were corrected**: admin trusted-device JWTs are no longer accepted as session credentials; private-file access re-checks the live role/active state; riders can no longer read the full driver record through favorites; a rider can no longer cancel another ride's dispatch offer before the ownership check; routing admin endpoints now use revocation-aware middleware; suspended partners are blocked; password hashes/FCM tokens are no longer returned in profile mutation responses.

Confirmed high-severity issues that remain are called out in section F. The production database hardening migration (`20261028_direct_api_lockdown.sql`) **was applied**; the bucket-privacy migration (`20261028_private_uploads_bucket.sql`) is **deliberately not applied** because it must follow deployment of the signed-URL backend to avoid breaking public profile images.

---

## B. Complete access-control inventory

### B.1 Environment and trust boundaries

| Item | Observed value |
|---|---|
| Database platform/version | Supabase-managed PostgreSQL 17.6, `postgres` database |
| Extension | PostGIS 3.3.7 (`public`), pgcrypto, pg_trgm, btree_gist, uuid-ossp, supabase_vault |
| Schemas | `public`, `auth`, `storage`, `extensions`, `vault`, `realtime`, `graphql`, `graphql_public` |
| Schemas reachable by Data API roles | `public`: no (no USAGE for anon/authenticated); `storage`: USAGE still granted, but RLS policies removed |
| Authentication provider | Backend-issued HS256 JWT (`users.id`); Supabase GoTrue only verifies OAuth provider tokens |
| DB identity used by backend | `postgres` — `rolbypassrls = true`, `rolsuper = false`, owner of application tables |
| DB identity used by Storage | `supabase_storage_admin` (owner), `service_role` (bypasses RLS); backend uses `SUPABASE_SERVICE_ROLE_KEY` server-side only |
| Direct client DB/storage access | None found in Flutter apps or dashboards; apps use backend HTTP/Socket.IO. Supabase anon key is bundled for Auth. |
| Realtime | Socket.IO + Redis adapter; `supabase_realtime` publication exists but contains no tables. No Postgres changes publication used by NetRide. |
| Migrations | `backend/migrations/*.sql`, applied by `backend/scripts/run-migrations.cjs` through `DIRECT_DATABASE_URL` when available |

### B.2 Common state of application tables (after this audit)

All 64 application-owned tables in `public` now share this state:

- RLS: **enabled**
- Direct-client policies: **none** (all removed by migration `20261028_direct_api_lockdown.sql`)
- `anon`/`authenticated` table/sequence grants: **none**
- `public` schema USAGE for `anon`/`authenticated`: **revoked**
- Allowed path: backend connection (`postgres`) only; backend authorization and object-level checks are the application boundary
- `app_release_configs` was the one table with RLS disabled; it is now enabled.

`spatial_ref_sys` is the only intentional exception (section C.3). The three views are listed separately.

### B.3 Table inventory

Legend: `Y` = RLS enabled, `—` = none. “Backend” means the trusted `postgres` connection, which bypasses RLS. All rows in this table are owner-only for `anon`/`authenticated` (no public-schema USAGE, no grants, no policies) unless stated otherwise.

| Object | Data sensitivity / purpose | RLS | Policies (after fix) | anon/auth grants | Backend | Required action / exception |
|---|---|---|---|---|---|---|
| `users` | Identity, email/phone, DOB, password hash, verification, FCM | Y | — | — | all DML | deny-by-default; profile auth is backend-enforced |
| `drivers` | Licence, background status, approval, FCM, pricing | Y | — | — | all DML | deny-by-default |
| `user_devices` | Device/risk linkage | Y | — | — | all DML | deny-by-default |
| `device_tokens` | Push/device credentials | Y | — | — | all DML | deny-by-default |
| `verification_codes` | Hashed OTP codes/purpose/attempts | Y | — | — | all DML | deny-by-default |
| `profile_change_requests` | Sensitive profile-change review queue | Y | — | — | all DML | deny-by-default |
| `storage_files` | File metadata, owner, visibility, bucket/path | Y | — | — | all DML | deny-by-default; file access is `/api/files` |
| `driver_vehicles` | Driver vehicle, plate, photos, approval | Y | — | — | all DML | deny-by-default |
| `vehicles` | Vehicle catalog rows | Y | — | — | all DML | public SELECT policy removed; served by backend |
| `vehicle_models` | Vehicle model catalog | Y | — | — | all DML | public SELECT policy removed; served by backend |
| `driver_document_requirements` | Per-driver document review status | Y | — | — | all DML | deny-by-default |
| `driver_vehicle_submissions` | Vehicle submission/approval records | Y | — | — | all DML | deny-by-default |
| `driver_vehicle_resubmission_requests` | Resubmission workflow | Y | — | — | all DML | deny-by-default |
| `driver_ride_preferences` | Driver ride preferences | Y | — | — | all DML | deny-by-default |
| `rides` | Rider/driver, pickup/dropoff, fare, status, timestamps | Y | — | — | all DML | participant checks in backend |
| `ride_messages` | In-trip chat | Y | — | — | all DML | party checks in backend/socket |
| `ride_reports` | Safety reports and evidence | Y | — | — | all DML | participant/admin checks in backend |
| `ride_driver_rejections` | Driver rejection/accept-cancel history | Y | — | — | all DML | deny-by-default |
| `ride_routes` | Route geometry/snapshots | Y | — | — | all DML | deny-by-default |
| `ride_price_snapshots` | Fare/pricing snapshot per ride | Y | — | — | all DML | deny-by-default |
| `ride_fare_breakdowns` | Rider/driver/platform split | Y | — | — | all DML | deny-by-default |
| `speeding_violations` | Safety/speeding events | Y | — | — | all DML | deny-by-default |
| `rider_activity` | Demand/heatmap activity | Y | — | — | all DML | deny-by-default |
| `ratings` | Rider/driver ratings and reviews | Y | — | — | all DML | backend participant checks |
| `favorite_drivers` | Rider favorites | Y | — | — | all DML | backend ownership checks; API now returns safe driver fields only |
| `rider_wallets` | Rider wallet balance | Y | — | — | all DML | deny-by-default |
| `wallet_transactions` | Rider wallet ledger | Y | — | — | all DML | deny-by-default |
| `ride_credit_accounts` | Rider credit balance | Y | — | — | all DML | deny-by-default |
| `credit_transactions` | Credit ledger | Y | — | — | all DML | deny-by-default |
| `financial_transactions` | Double-entry/financial ledger | Y | — | — | all DML | deny-by-default |
| `stripe_customers` | Stripe customer mapping | Y | — | — | all DML | deny-by-default |
| `stripe_payments` | Payment intents/status | Y | — | — | all DML | deny-by-default |
| `stripe_webhook_events` | Webhook idempotency/audit | Y | — | — | all DML | deny-by-default |
| `driver_stripe_accounts` | Connect account mapping | Y | — | — | all DML | deny-by-default |
| `driver_wallets` | Driver earnings balance | Y | — | — | all DML | deny-by-default |
| `payouts` | Driver payout history | Y | — | — | all DML | deny-by-default |
| `payout_cards` | Driver payout card metadata | Y | — | — | all DML | deny-by-default |
| `sponsor_ledger_entries` | Sponsor budget/ledger | Y | — | — | all DML | deny-by-default |
| `sponsor_withdrawals` | Sponsor withdrawals | Y | — | — | all DML | deny-by-default |
| `special_redemptions` | Sponsor special redemption/settlement | Y | — | — | all DML | deny-by-default |
| `partner_commissions` | Partner commission ledger | Y | — | — | all DML | deny-by-default |
| `promo_usage` | Promo redemption accounting | Y | — | — | all DML | deny-by-default |
| `sponsors` | Sponsor business profile/funding | Y | — | — | all DML | public fields served by backend |
| `sponsor_portal_accounts` | Sponsor portal identity link | Y | — | — | all DML | deny-by-default |
| `partners` | Partner business/profile/status | Y | — | — | all DML | legacy partner middleware now requires ACTIVE |
| `fleet_partners` | Fleet organization | Y | — | — | all DML | deny-by-default |
| `fleet_portal_accounts` | Fleet portal identity link | Y | — | — | all DML | deny-by-default |
| `promo_codes` | Promo definitions | Y | — | — | all DML | public validation is backend-scoped |
| `referral_codes` | Referral codes | Y | — | — | all DML | deny-by-default |
| `referral_relationships` | Referrer/referred linkage | Y | — | — | all DML | deny-by-default |
| `referral_rewards` | Referral payout state | Y | — | — | all DML | deny-by-default |
| `pricing_profiles` | Pricing configuration | Y | — | — | all DML | deny-by-default |
| `pricing_configurations` | Global pricing knobs | Y | — | — | all DML | deny-by-default |
| `revenue_configs` | Platform/driver/fleet split | Y | — | — | all DML | deny-by-default |
| `regions` | Service regions/geofences | Y | — | — | all DML | deny-by-default |
| `notifications` | In-app notification content | Y | — | — | all DML | recipient checks in backend |
| `app_release_configs` | App version/update campaign configuration | Y (new) | — | — | all DML | was the only RLS-disabled table; fixed |
| `audit_events` | Security/operational audit trail | Y | — | — | all DML | deny-by-default |
| `audit_logs` | Admin action audit trail | Y | — | — | all DML | deny-by-default |
| `cache_config` | Cache configuration | Y | — | — | all DML | internal only |
| `eta_cache` | ETA cache | Y | — | — | all DML | internal only |
| `route_cache` | Route cache | Y | — | — | all DML | internal only |
| `places` | Place/POI search corpus | Y | — | — | all DML | public search is backend-scoped |
| `migrations_applied` | Migration bookkeeping | Y | — | — | all DML | internal only |
| `spatial_ref_sys` | PostGIS EPSG reference metadata (8,500 static rows) | N | — | PUBLIC SELECT only | SELECT | **documented exception** — do not enable/force RLS (section C.3) |
| `reward_ledger` (view) | Referral/admin credit ledger projection | n/a | — | — | SELECT | `security_invoker=true`; no direct grants |
| `geography_columns` (extension view) | PostGIS metadata | n/a | — | PUBLIC SELECT | SELECT | extension-owned, metadata only, behind schema USAGE gate |
| `geometry_columns` (extension view) | PostGIS metadata | n/a | — | PUBLIC SELECT | SELECT | extension-owned, metadata only, behind schema USAGE gate |

Additional objects:

- Sequences: `eta_cache_id_seq`, `ride_routes_id_seq`, `route_cache_id_seq`, `verification_codes_id_seq`; no `anon`/`authenticated` grants.
- Functions: 966 functions in `public`, almost all PostGIS. Application functions `cleanup_route_caches()`, `region_contains(...)`, `search_places(...)` are `SECURITY INVOKER`; PUBLIC EXECUTE was revoked. The only `SECURITY DEFINER` functions are PostGIS extension functions (`st_estimatedextent` variants), owned by `supabase_admin`, not callable through the Data API because `public` schema USAGE is denied.
- Storage: `storage.objects` and `storage.buckets` have RLS enabled; all direct-client policies removed. The `uploads` bucket remains public (deployment dependency). `secure-documents` does not exist yet in the connected environment.
- Realtime publication `supabase_realtime` contains no tables; no row replication exposure.

### B.4 Effective access matrix

| Principal | Own profile / files | Other user private data | Assigned/shared trip | Any trip (unassigned) | Verification/approval state | Financial records | Direct DB/Storage |
|---|---|---|---|---|---|---|---|
| Anonymous | Public profile photos via `/api/files`; public app/specials data | Denied | Denied | Denied | Denied | Denied | Public schema: denied; storage: no visible rows |
| Rider (backend JWT) | Read/update own profile via backend; own files | Denied | Read/update own rides; shared fields only | Denied | Cannot change own approval/role | Own wallet/credits; no other rider’s | No direct Data API |
| Driver (backend JWT) | Own driver profile/docs/vehicle/wallet | Denied | Assigned rides/messages/location | Denied | Cannot self-approve; direct profile endpoint still bypasses review queue (open risk) | Own earnings/payouts | No direct Data API |
| Administrator | All records through admin APIs | Allowed for review; audited | Allowed | Allowed | Allowed | Allowed | No direct Data API |
| Trusted backend (`postgres`) | All tables/functions | Allowed | Allowed | Allowed | Allowed | Allowed | RLS bypassed by owner; least-privilege role recommended |
| DB `anon` / `authenticated` | None | None | None | None | None | None | No `public` USAGE; storage policies deny |
| DB `service_role` | n/a | n/a | n/a | n/a | n/a | n/a | `BYPASSRLS`, no `public` USAGE; Storage service role only |
| Migration/owner | n/a | n/a | n/a | n/a | n/a | n/a | DDL via `DIRECT_DATABASE_URL` |

---

## C. Security findings

### C.1 Confirmed / remediated

| ID | Severity | Affected object/path | Existing configuration | Vulnerability | Who could exploit | Status |
|---|---|---|---|---|---|---|
| DB-01 | **High** | `storage.objects`, `storage.buckets`, `uploads` bucket | RLS enabled, but `anon`/`authenticated` had SELECT/INSERT/UPDATE/DELETE grants and eight policies with only `bucket_id='uploads'` | Anyone with the client-shipped anon key could list, upload, overwrite and delete bucket objects | Any app user or attacker with the anon key | **Effective listing/write closed** by removing policies. Grant revocation is blocked by `supabase_storage_admin` ownership (warning); RLS now denies. |
| DB-02 | **High (residual)** | Nine private `storage_files` rows in public `uploads` | Migration 057 classified them private but the object move was not executed; bucket public | Private licence/registration/orphan documents had public URLs; listing exposed names | Anyone with anon key before hardening; anyone with a known URL now | **Partially remediated.** Listing now 0; direct URL still HTTP 200. Requires deployment of signed-URL backend + `20261028_private_uploads_bucket.sql` + `migrate-storage-visibility.cjs` |
| DB-03 | **High** | Trusted-device JWT | Same HS256 secret and claims; `authMiddleware`/socket accepted any signed token | 30-day admin “remember device” token could be used as a full API/socket session | Holder of a trusted-device token | **Fixed** in code: `t` purpose claim enforced; trusted-device/file-access rejected; login requires `t='trusted-device'` |
| DB-04 | **High** | `GET /api/user/favorites` | `include: { driver: ... }` returned the entire `Driver` row | A rider could read a favourite driver’s licence/insurance/registration URLs, background status, FCM token | Any rider with a completed ride with the driver | **Fixed**: explicit safe driver-card select |
| DB-05 | **High** | `GET /api/files/:id` Bearer path | `identifyUser` only verified the signature; `canAccessFile` trusted the role claim | Demoted/deactivated admin could read any private document until JWT expiry | Stale admin token holder | **Fixed**: file route re-reads `users.role/is_active`; signing happens after authorization |
| DB-06 | **High** | Socket.IO rider `cancelTrip` | `cancelRideOffers(tripId)` ran before `RideService.cancelTrip` ownership check | Any authenticated rider with a trip UUID could cancel that ride’s driver offer | Any rider | **Fixed**: cancellation/ownership first; offer cleanup after, best-effort |
| DB-07 | Medium | `users`, `drivers`, `rides`, `ratings`, `favorite_drivers`, `vehicles`, `vehicle_models`, `driver_wallets`, `payouts`, `payout_cards`, `profile_change_requests`, `driver_document_requirements`, `driver_vehicle_submissions` | 18 direct-client policies from migrations 016/020/024/025 | Supabase-Auth assumptions (`auth.uid()`) never matched NetRide’s custom JWT; `users`/`drivers` UPDATE had no column restriction, so a future grant could allow role/verification escalation | Not exploitable at current grants | **Fixed**: all public policies dropped; direct API denial codified |
| DB-08 | Medium | `app_release_configs` | RLS disabled | No direct grants, so not exploitable, but inconsistent with every other app table | None at current grants | **Fixed**: RLS enabled |
| DB-09 | Medium | Storage schema/tables | `anon`/`authenticated` still hold USAGE/DML grants from `supabase_storage_admin` | Least-privilege gap; effective access is deny-all via RLS after policy removal | None effective; defense-in-depth only | **Open (operator)**: revoke via Supabase owner/dashboard or a superuser connection |
| DB-10 | Medium | `ensurePrivateBucket()` | Returned success on HTTP 200 without checking `public` | An existing public `secure-documents` bucket would be treated as private | Misconfiguration | **Fixed**: verifies and repairs `public=false` |
| DB-11 | Medium | Local file storage path | `path.join(UPLOADS_DIR, path)` with legacy user-derived paths | Historical traversal path from migration 029 could escape `backend/uploads` | Local/legacy row holder | **Fixed**: resolve + containment check on read/delete |
| DB-12 | Medium | `/api/routing/stats`, `/api/routing/cache/clear` | `identifyUser` only | Stale/deleted admin JWT could read stats or clear caches | Stale admin token holder | **Fixed**: `authMiddleware` + `adminMiddleware` (live DB revocation) |
| DB-13 | Medium | Legacy `/api/partner/*` | `partnerMiddleware` checked temporary password but not `partners.status` | Suspended/archived partner retained dashboard access | Suspended partner | **Fixed**: requires `status = ACTIVE` |
| DB-14 | Medium | Driver/admin profile responses | `SELECT u.*` and Prisma User returns | `password_hash`, FCM token, device-risk state returned | Authenticated self/admin | **Fixed**: fields stripped in driver profile/admin mutation responses |
| DB-15 | Low | Storage upload fallback | Anon key used if service-role key absent | If policies are permissive, client-key uploads could work; after policy removal, no | Configuration | Mitigated by deny-all policies; ensure service-role key is set |

### C.2 Potential / open application-level risks (not fixed without product decisions)

These are outside the database/RLS layer but affect the same data. They are reported rather than silently “fixed” because the correct behaviour depends on NetRide’s onboarding/product rules.

| ID | Risk | Evidence | Impact |
|---|---|---|---|
| APP-01 | Driver `PATCH /profile` bypasses the profile-change approval queue and DOB lock | `driver.routes.ts` uses auth only; `driver.service.ts` writes licence/vehicle/user fields directly; the dedicated approval queue exists | A driver can change licence/vehicle identity data without admin review |
| APP-02 | Rider `PATCH /profile` can change phone/DOB without OTP/DOB-lock; `verify-identity` resets BLOCKED/REJECTED to PENDING | `user.repository.ts`, `user.service.ts` | Identity/contact integrity and re-verification bypass |
| APP-03 | Admin block/reject does not set `users.is_active=false`; login reactivates `is_active` | `admin.controller.ts`, `auth.service.ts` | A blocked user may still request rides or undo deactivation by logging in |
| APP-04 | `driverMiddleware` admits any DRIVER/dual-role user without checking `drivers.is_active`/approval | `auth.middleware.ts`; dispatch eligibility separately checks `is_active` | Unapproved drivers can access driver-only HTTP features (heatmap, Connect onboarding), though not dispatch/ride acceptance |
| APP-05 | A rider can subscribe to any geohash and observe live driver locations | `socket.gateway.ts` `subscribeToNearbyDrivers` | Location privacy/tracking outside the rider’s actual area |
| APP-06 | Admin document “delete” only nulls the DB column; object and `storage_files` row remain | `admin.controller.ts` | Retention/authorization lifecycle gap |
| APP-07 | Document URLs accept arbitrary external `http(s)` URLs | `file-url.ts`, driver/user controllers | Data-governance/phishing risk; documents outside retention controls |
| APP-08 | `/metrics` unauthenticated; `/health` returns DB error text | `app.ts` | Operational information exposure |

### C.3 `spatial_ref_sys` finding — not a vulnerability

Observed:

- Schema `public`; owner `supabase_admin`; extension `postgis` 3.3.7 owns it.
- 8,500 static EPSG rows; not written by NetRide.
- `relacl = {supabase_admin=arwdDxtm, =r}` — **PUBLIC SELECT only**, no INSERT/UPDATE/DELETE.
- `relrowsecurity = false`, `relforcerowsecurity = false`.
- `anon`/`authenticated` have no USAGE on `public`; a direct `SELECT` as `anon` fails with `42501`.
- PostGIS `ST_Transform(ST_SetSRID(ST_MakePoint(-73.9,40.7),4326),3857)` continues to work as the backend owner after hardening.

Conclusion: the missing RLS is intentional and safe. This is static, public coordinate-system metadata, not user data. `PUBLIC SELECT` is the conventional PostGIS grant required by coordinate-transform functions for non-owner roles; write privileges are absent. Enabling RLS without policies would break spatial operations for any non-owner role and could interfere with extension upgrades, with no confidentiality benefit (the data is public by design). `FORCE RLS`, ownership changes or a rewrite were deliberately not performed. The only database access route (`public` schema Data API) is already denied to `anon`/`authenticated`.

---

## D. Root-cause analysis

1. **Storage had two independent controls removed.** The bucket was created public and the public object endpoint bypasses RLS. Separately, dashboard-created policies (`anon can *`, `admin can *` targeting `authenticated`) granted every operation on the whole `uploads` bucket. Because the anon key is shipped with the mobile apps (normal for Supabase Auth), these policies were reachable by anyone. The repository did not contain the bucket policy SQL, so the issue was invisible to migration review.
2. **The data-placement migration was operational, not automatic.** Migration 057 correctly classified files `private`, but the object copy/delete script was not part of app startup or `run-migrations`; nine private rows were left in the public bucket.
3. **RLS policies assumed a different identity provider.** Migrations 016/020/024/025 were written for Supabase PostgREST/Auth (`auth.uid()`), while NetRide issues its own JWTs and has no direct data client. The policies were dead because of schema/table grants, but they encoded unsafe self-update rules. The correct model is explicit deny-by-default for direct APIs, with the trusted backend as the only route.
4. **`app_release_configs` was added later and missed the RLS checklist.** It had no direct grants, so no exploit occurred, but it was inconsistent and is now covered.
5. **The backend intentionally uses an RLS-bypassing owner.** `postgres` is the table owner and has `BYPASSRLS`. RLS is therefore a safety net against direct PostgREST/Storage access, not the application authorization boundary. The actual boundary is the Express/Socket.IO code (role middleware and object-level checks). This makes backend authorization bugs high-impact; several were found and fixed.
6. **JWT purpose was not a first-class concept.** Trusted-device and file-access tokens shared the session signing key and claim shape. Adding an explicit `t` purpose and rejecting non-session purposes closes the confused-deputy path without logging out legacy no-`t` sessions.
7. **Storage grants are owned by `supabase_storage_admin`.** The migration role `postgres` can drop policies (verified) but cannot revoke grants granted by the storage owner (verified: ACL unchanged). Effective access is still deny-all via RLS; a Supabase owner/superuser must complete the grant cleanup.

---

## E. Code and migration changes

### E.1 Applied to the live database

| File | Purpose |
|---|---|
| `backend/migrations/20261028_direct_api_lockdown.sql` | Revoked `public` schema USAGE for `anon`/`authenticated`; revoked public/table/sequence/function grants; added default-privilege deny rules; dropped all 18 public direct-client policies; enabled RLS on `app_release_configs`; revoked app helper-function EXECUTE; re-asserted `reward_ledger` invoker semantics; removed all anon/authenticated/PUBLIC storage policies; left `spatial_ref_sys` untouched and documented. |

Applied with:

```text
node backend/scripts/run-migrations.cjs 20261028_direct_api_lockdown.sql
[apply] 20261028_direct_api_lockdown.sql ✓
SUMMARY: ran=1 skipped=0 failed=0
```

### E.2 Repository changes pending deployment

| File | Purpose |
|---|---|
| `backend/migrations/20261028_private_uploads_bucket.sql` | Sets `uploads` (and `secure-documents` if present) to `public=false`. Must run **after** the signed-URL backend is live. |
| `backend/src/services/storage.service.ts` | Signs every Supabase object (public and private); authorizes before minting; local path containment (`resolveLocalPath`). |
| `backend/src/routes/files.routes.ts` | Loads the file record first, re-checks live `users.role/is_active` for Bearer and query-token callers, authorizes, then signs. |
| `backend/src/config/supabase.ts` | `ensurePrivateBucket` verifies and repairs the private flag instead of trusting HTTP 200. |
| `backend/scripts/migrate-storage-visibility.cjs` | Verifies/repairs bucket privacy; no longer prints object paths on failure. |
| `backend/src/security/token-purpose.ts` | Defines `t: "access"` and `isSessionAccessToken` (legacy no-`t` tokens grandfathered). |
| `backend/src/middleware/auth.middleware.ts` | Rejects trusted-device/file-access tokens; partner status must be ACTIVE. |
| `backend/src/middleware/identifyUser.middleware.ts` | Does not populate `req.user` from non-session tokens. |
| `backend/src/app.ts` | Socket handshake rejects non-session tokens. |
| `backend/src/modules/auth/auth.service.ts` | Session tokens carry `t: "access"`; trusted-device login requires `t: "trusted-device"`. |
| `backend/src/gateway/socket.gateway.ts` | Rider cancellation authorizes first; admin monitoring re-checks live role/active state. |
| `backend/src/modules/user/favorite.routes.ts` | Returns a safe driver-card subset, not the full driver/private-document record. |
| `backend/src/modules/driver/driver.service.ts` | Strips `password_hash`, `fcm_token`, `device_risk_state` from driver profile responses. |
| `backend/src/modules/admin/admin.controller.ts` | Strips credential/internal fields from verify/reject/pending/block/unblock responses. |
| `backend/src/routing/api/routing-api.ts` | Admin diagnostics/cache-clear now use `authMiddleware` + `adminMiddleware`. |
| `tests/security/database-security-checks.cjs` | Repeatable read-only catalog/effective-access checks for the DB boundary. |
| `tests/unit/backend/security/token-purpose.unit.test.ts` | Token-purpose regression tests. |
| `tests/unit/backend/run-tests.cjs` | Registers the new suite. |
| `package.json` | `test:security` now runs the static checks plus the DB checks. |

### E.3 Important policy/grant changes (summary)

- `REVOKE ALL ON SCHEMA public FROM PUBLIC, anon, authenticated` (production already had this; now codified).
- `REVOKE ALL PRIVILEGES ON ALL TABLES/SEQUENCES/FUNCTIONS IN SCHEMA public FROM anon, authenticated`.
- `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ... FROM anon, authenticated`.
- `DROP POLICY` for every `public` policy.
- `ALTER TABLE public.app_release_configs ENABLE ROW LEVEL SECURITY`.
- `REVOKE ALL ON FUNCTION public.cleanup_route_caches/region_contains/search_places FROM PUBLIC` (owner retains execute).
- `REVOKE ALL ON SCHEMA storage FROM PUBLIC` and per-role storage revokes (best-effort; owner-controlled grants remain).
- `DROP POLICY` for every anon/authenticated/PUBLIC policy on `storage.objects`/`storage.buckets`.
- No change to `spatial_ref_sys`, PostGIS extension objects, table ownership, or RLS state.

---

## F. Testing results

### F.1 Executed

| Test / command | Result |
|---|---|
| Live catalog inventory (tables, views, policies, ACLs, roles, extensions, publications, buckets) | Completed on PostgreSQL 17.6 / PostGIS 3.3.7 |
| Role simulation as `anon`, `authenticated`, `service_role`, `postgres` | Confirmed public schema denial; before fix anon saw 25 `storage.objects` rows; after policy removal anon sees 0 |
| Supabase Storage API with the bundled anon key | Before: object listing HTTP 200; after: HTTP 200 with **0 objects**. A private-classified object’s direct public URL still returns HTTP 200 (residual DB-02) |
| `node tests/security/database-security-checks.cjs` | **17/17 checks passed**; 5 deployment warnings (storage grants, public bucket, 9 legacy private rows) |
| `npm run test:security` (root) | Static 18/18 + DB 17/17 passed |
| `node backend/scripts/run-migrations.cjs 20261028_direct_api_lockdown.sql` | Applied successfully to the connected Supabase database |
| Isolated test database harness (throwaway DB on the same cluster) | New migrations applied; **15/15** verification checks passed (anon/authenticated denied public + storage, zero storage rows, RLS on `app_release_configs`, `spatial_ref_sys` left RLS-off and read-only, both buckets private, PostGIS transform works) |
| `npm run build` (backend) | Clean TypeScript build |
| Full backend unit suite (`node ../tests/unit/backend/run-tests.cjs`) | Exit code 0; all reported suites passed |
| Focused auth-hardening suite | 9/9 passed (including trusted-device/file-access rejection) |
| Token-purpose suite | 5/5 passed |
| Post-hardening spatial query | `ST_Transform` works; `spatial_ref_sys` still 8,500 rows |

### F.2 Admin dashboard access verification

A read-only smoke test mounted the real admin routers in an isolated Express process (no `app.ts` background jobs) and called them with a short-lived JWT for an existing active ADMIN account. No mutating endpoint was called.

| Endpoint group | Result |
|---|---|
| `GET /api/admin/stats`, `/users`, `/rides`, `/logs`, `/profile-changes` | 200 |
| `GET /api/admin/payout-cards`, `/payouts`, `/vehicles/submissions`, `/fleets`, `/pricing`, `/revenue` | 200 |
| `GET /api/admin/partners`, `/promos`, `/referrals/stats`, `/credits`, `/ledger/rewards` | 200 |
| `GET /api/admin/sponsors`, `/sponsors/redemptions` | 200 |
| `GET /api/admin/payments/overview`, `/settlements`, `/events` | 200 |
| `GET /api/admin/drivers/live` | 503 in the isolated test because the local Redis endpoint accepted TCP but never reached `ready` (the endpoint now waits briefly and returns 503 instead of 500). In production this depends on Redis being available; it is not a database/RLS regression. |
| `GET /api/admin/app-updates` | **Not mounted in the current working tree** — see section G.3. This is a pre-existing uncommitted source change, not caused by the database hardening. |

Representative admin SQL reads (users/drivers/rides/routes/ledger/audit, document requirements, vehicle submissions, profile changes, payout cards/payouts, wallets, credits, partners/sponsors/portals, promos/referrals/commissions, reports/speeding/regions/pricing/revenue configs, app release configs, storage metadata) all succeeded as the backend owner after the RLS migration.

### F.3 Not executed / limitations

- No destructive write/delete was executed against production Storage or user data. Write capability was established from grants/policies, not by writing.
- The live backend was not redeployed in this environment; the file/CDN behaviour after `20261028_private_uploads_bucket.sql` is therefore not observed against a live new build. The code path was reviewed and the isolated migration test passed.
- `migrate-storage-visibility.cjs` could not be executed because `SUPABASE_SERVICE_ROLE_KEY` is not present in the available environment. This is recorded as an operator action.
- Supabase dashboard security advisors were not available via the provided access; the catalog was inspected directly.
- Full Flutter builds and live Stripe/Twilio/e2e flows were not re-run; no Flutter source was changed in this audit.
- The fresh-database migration harness exposed **11 pre-existing baseline migration failures** unrelated to this change: `029_migrate_legacy_file_urls` (missing `face_enrollment_url`), `043_after_trip_tip_credits` and `046_sponsors` (enum additions in the same transaction), `050/052/054/057/20261016_*` (sponsors dependency), `058_portal_identity_separation` (email constraint/index), `20261019_repair_zero_fare_settlements` (missing column). The new migrations themselves applied cleanly to both the existing production-like database and the simulated fresh database.

---

## G. Remaining risks and deployment requirements

### High — must be completed

1. **Deploy the signed-URL backend, then apply bucket privacy and move the nine private objects.** Exact order:
   1. Deploy this repository's backend (`storage.service.ts` signs all Supabase files).
   2. Apply `backend/migrations/20261028_private_uploads_bucket.sql` (sets `uploads.public=false`).
   3. Run `node backend/scripts/migrate-storage-visibility.cjs` with `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`; verify it reports 0 remaining private objects and the public copies are deleted.
   4. Verify `/api/files/:id` for a public profile photo and a private document, then run `npm run test:security`.
   - Until step 2/3, the nine private objects are still retrievable via known direct public URLs. Because listing was open before this audit, treat this as a possible exposure event: review Storage access logs and follow the applicable driver-document incident/notification procedure.
2. **Confirm no production code still assumes public bucket URLs.** This repository's only `publicStorageUrl` use is the file service fallback; stored URLs in the audited database are `/api/files/...`, not direct Supabase public URLs. Verify any external consumers/cached links before flipping the bucket.

### Medium — operator follow-up

3. **Revoke storage grants/USAGE as a Supabase owner/superuser.** The `postgres` migration role cannot revoke grants granted by `supabase_storage_admin` (ACL unchanged after `REVOKE`). RLS currently provides effective deny-all. Complete the defense-in-depth cleanup through the Supabase dashboard/owner connection:
   `REVOKE ALL ON SCHEMA storage FROM anon, authenticated;`
   `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA storage FROM anon, authenticated;`
4. **Adopt a dedicated backend DB role.** The backend connects as `postgres` (`BYPASSRLS`, table owner). Create a `NETRIDE_APP`-style `NOBYPASSRLS` role with only `USAGE` on `public`, DML on required tables/sequences and EXECUTE on required functions, then switch `DATABASE_URL` after staging validation. This reduces blast radius from a backend/SQL-injection defect.
5. **Resolve the application-level authorization gaps (APP-01…APP-08)** with product-approved rules. Highest priority: driver profile approval bypass, phone/DOB changes, admin block/deactivation semantics, and driver middleware approval state.
6. **Fix the pre-existing fresh-install migration chain** before relying on an empty-environment deployment. The 11 failures are outside this change set but mean `docker-compose`/fresh Supabase bootstrap is not reproducible from scratch.

### Low / informational

7. `/metrics` is unauthenticated and `/health` exposes raw DB error text on failure; restrict at the proxy.
8. The backend still returns counterparty email in some trip payloads; this may be intentional but should be reviewed as PII minimisation.
9. Admin dashboard stores the 30-day admin access token in `localStorage`; an XSS would expose a long-lived admin credential. Consider shorter admin sessions/refresh tokens.
10. `service_role` remains `BYPASSRLS` (Supabase design) but has no `public` schema USAGE; keep the service-role key server-side and rotate if ever exposed.

### G.3 Admin App Updates page is currently unmounted (pre-existing working-tree change)

The admin dashboard still calls `GET/PUT/POST/DELETE /api/admin/app-updates...` (`apps/admin_dashboard/src/api/admin.ts`), but the current working tree has:

- deleted `backend/src/modules/app-version/app-update.admin.controller.ts`
- deleted `backend/src/modules/app-version/app-update.admin.routes.ts`
- deleted `backend/src/modules/app-version/app-update.validation.ts`
- removed the `appUpdateAdminRoutes` import/mount from `backend/src/app.ts`
- reduced `app-version.service.ts` / `app-version.utils.ts` by roughly 755 lines, removing the admin draft/publish exports

This state predates and is unrelated to the database/RLS hardening; it means the **App Updates page cannot work until that feature is restored**. The repository still has the full implementation in `HEAD`, so it can be restored intentionally if the feature is still required. Do not treat the DB migration as the cause of this 404.

### `spatial_ref_sys` disposition

No action required. Leave RLS disabled. Preserve `PUBLIC SELECT` for PostGIS. Do not force RLS, change ownership, or rewrite the extension-managed table. The effective Data API guard is the revoked `public` schema USAGE, verified for `anon` and `authenticated`.

---

## H. Verification conclusion

- Every application table in `public` now has RLS enabled and no direct-client policy; the only exception is the extension-owned `spatial_ref_sys`, justified above.
- Direct PostgREST access to `public` is denied at schema-USAGE and grant level for `anon`/`authenticated`.
- Direct Storage listing/upload/overwrite/delete is denied by removal of all anon/authenticated policies; effective listing is 0 rows. Storage grant hygiene remains an owner-level follow-up.
- The trusted backend keeps its required access; public profile images continue through `/api/files` (signed URL path) after the code deploy.
- Confirmed cross-user and privilege-escalation paths fixed in code have regression coverage in the token-purpose/auth-hardening suites.
- The remaining high-severity item is the nine legacy private objects in the still-public bucket; it requires the deployment sequence in G.1 and is explicitly **not** claimed as resolved.
