# NetRide — Full-Ecosystem Security Remediation, Round 3 (Final Disposition)

Date: 2026-10-16
Scope: the complete 37-finding security report — authentication, MFA, OTP, password reset, business logic, access control, WebSocket, SQL injection, file access, redirects, uploads, secrets, rate limiting, resource consumption, dependencies, admin/rewards, email XSS, account enumeration, mobile platform, and organization policy.
Repository state at verification: working tree on `master` (`bd5ab63`) with this round's changes applied (not committed, not merged, not deployed — see §G).
Prior rounds: `tests/docs/audits/NETRIDE_SECURITY_REMEDIATION_REPORT.md` (round 1) and `NETRIDE_SECURITY_REMEDIATION_FINAL.md` (round 2) — both were inspected and their still-applicable fixes retained; this round re-verified them and absorbed the two open remediation PR branches (see §C-1).

---

## A. Executive summary

| Metric | Count |
|---|---|
| Original findings in the report | **37** |
| Unique underlying issues after deduplication | **31** |
| Fixed — Verified (matrix rows) | **23** |
| Verified False Positive | **10** |
| Mitigated — Residual Risk (matrix row: exported component) | **1** (+3 additional residual items discovered during the investigation, §G) |
| Unresolved — Action Required | **0** |
| External Action Required (cannot be completed from the repo) | **6** actions, referenced from findings 7, 8, 21, 24 and §D/§G |

Deduplication: the six dependency prototype-pollution findings (`immer`, `es-toolkit`, `pg-connection-string`, `pg`, `ioredis`, `pino`) plus `follow-redirects`/`cron-parser` share one root cause class (transitive dependency hygiene) and all resolve to "no reachable vulnerable code with current versions" — they are counted as unique findings but dispositioned individually below. Findings 5, 6, 15, 16 were fully remediated in prior rounds and were re-verified, not re-fixed.

Most important fixes this round:

- **Authentication / MFA / OTP.** Every one-time code is now *purpose-bound* (a portal reset code can never be a login code and vice versa), admin 2FA codes are bound to the individual administrator's identity (never a shared inbox key) and require a password-verified pending login, the consumer OTP-only login bypass is closed with a server-side login-challenge marker, and JWTs are re-checked against the database on every HTTP and socket authentication (deactivation, admin demotion, and password-change invalidation — including the admin forced-rotation flow, which now receives a fresh token).
- **Business logic.** The test-account classification is no longer spoofable from public mail domains (`test123@gmail.com` previously skipped the card requirement and could mint driver-wallet money via `complete-test`); ride state transitions are atomic and monotonic (no COMPLETED→CANCELLED regression, no accept/cancel race); sponsorship cancellation after a completed ride settles the rider like an expiry; the Stripe webhook fulfills only when the PaymentIntent id and amount match the authoritative row; Twilio conference joins are bound to the caller's Voice-token identity.
- **Rate limiting.** The HTTP rate-limit table was mis-keyed (`/api/auth/signup` vs the real `/api/auth/signup-password`), leaving every consumer auth endpoint on the permissive default. Keys now match the mounted routes, tests assert the sensitive-route coverage, phone-OTP/SMS has its own budget, and sockets gained a connection throttle plus per-user budgets for `requestRide`, `goOnline`, destination changes and chat (chat was previously keyed by a client-supplied tripId).
- **Secrets & sensitive data.** The real admin password hardcoded in `probe-e2e.js` is gone (env-based, fail-fast); the unused vulnerable `multer` dependency was removed; `GET /admin/users` no longer returns `password_hash`/`fcm_token`; mobile session credentials moved from plaintext SharedPreferences to Keystore/Keychain-backed secure storage with a migration that purges the plaintext copies; all HTML email templates escape user/DB-derived values; Redis stores only token digests; admin/reward inputs are validated and UUID-guarded.
- **Android platform.** Backup is disabled on every API level (`allowBackup=false`, `fullBackupContent=false`, plus a `dataExtractionRules` file disabling cloud backup **and** device-transfer), verified in the packaged debug and release APKs.

---

## B. Finding-by-finding disposition matrix

Status labels: `Fixed — Verified` / `Verified False Positive` / `Mitigated — Residual Risk` / `Unresolved — Action Required` / `External Action Required`.

### High severity

| # | Finding | Reported locations | Verified root cause | Remediation | Status |
|---|---|---|---|---|---|
| 1 | Improper Authentication | `auth.service.ts`, `auth.middleware.ts`, +2 (resolved: `app.ts` socket auth, `portal-auth.service.ts`) | Stateless 30-day JWTs never re-checked against live state; deactivated/demoted/password-changed sessions stayed valid; admin forced-rotation flow reused the stale token; Redis reset tokens stored raw. | `AuthService.assertTokenStillValid` (existence, `is_active`, ADMIN role, `password_changed_at` with 1 s skew tolerance) enforced in `authMiddleware` (async, fail-closed) and the Socket.IO handshake; `changePassword` now issues a fresh token and the admin dashboard adopts it; reset/change/email tokens stored as SHA-256 digests; portal refresh tokens are indexed per user and revoked on password change, with an issuedAt-vs-password-change check on refresh. Both open remediation-PR implementations were reviewed, extended and absorbed (PR branches remain unmerged). | Fixed — Verified |
| 2 | Multer uncaught exception | dependency `multer` | `multer@1.4.5-lts.2` was declared but **not imported anywhere** (uploads use bounded base64 JSON handlers). | Dependency + `@types/multer` removed (`npm uninstall`); lockfile contains no `multer`. No feature lost. | Fixed — Verified |
| 3 | Multi-Factor Authentication Bypass | `auth.service.ts` | Consumer `/auth/verify-otp` accepted any mailed code without proof the password step happened (OTP-only account takeover); admin 2FA verified against the shared `ADMIN_NOTIFY_EMAIL` key, so one admin's code could complete another admin's login; no pending-login requirement. | Server-side `login_otp_challenge` marker set only by password login/signup and consumed with the code; ADMIN accounts rejected by `/auth/verify-otp`; admin codes stored under the admin's own identity (purpose `ADMIN_2FA`, delivered to the shared inbox) and `verifyAdmin2FA` requires the `admin_login_challenge` set by the password step; `requestAdmin2FA` is a no-op without a pending challenge. | Fixed — Verified |
| 4 | Potential SQL Injection | `sponsor.service.ts`, `ride.service.ts`, +1 | None — all values are bound parameters; dynamic fragments are static strings, allowlisted columns, or computed `$n` placeholders. Re-verified by scan (10 interpolation matches, all placeholder indexes). | No change required. | Verified False Positive |
| 5 | Missing Express Security Headers | `app.ts`, `server.js`, +1 (sponsor portal) | Fixed in round 1/2 (central `securityHeaders` middleware + both dashboards' `createApp()`). | Re-verified by `tests/unit/backend/security/security-headers.unit.test.ts` and the security runner (SPA shell, 404, HSTS-gating, per-app CSP). | Fixed — Verified (prior round) |
| 6 | Open Redirect | `payments.controller.ts` | Fixed in round 1 (`return-target.ts` allowlists `kind`/`state`; no user-controlled redirect base). | Re-verified; legitimate Stripe return flows preserved. | Fixed — Verified (prior round) |
| 7 | Generic API keys | `probe-e2e-tmp.js` (current name `probe-e2e.js`), `verify-admin.js` | **Real admin password hardcoded** in `probe-e2e.js:29` (renamed from the flagged `probe-e2e-tmp.js` and missed by round 1); `verify-admin.js` already used env vars only. | `probe-e2e.js` now requires `ADMIN_TEST_PASSWORD` / `PARTNER_TEST_PASSWORD` (fail-fast), generates fleet passwords at runtime, and no longer prints the reset sponsor password. Rotate the exposed admin password (history) — §D. | Fixed — Verified (current tree) + External Action Required (rotation) |
| 8 | Generic API key | `fix-admin-auth.js` | Deleted from HEAD in an earlier commit; the same real admin password remains in git history. | Current tree clean; rotation + history decision are operator actions (§D). | External Action Required |
| 9 | Stripe access token | `payments.unit.test.ts` | Fake interlock fixtures only (`sk_test_abc`, `sk_live_fake…`) passed to `stripeKeyIsLive()` assertions; live key is never present in the repo. | No change required. | Verified False Positive |
| 10 | Generic API keys | `run-colab-identity-e2e.cjs` + associated | Runtime-generated fixtures except one literal scratch-account password; no real secrets. | Literal replaced with a runtime-generated value; cleanup logic unchanged. | Fixed — Verified |
| 11 | Business Logic Bypass | `feature.routes.ts`, `webhook.service.ts`, +14 | Confirmed defects: spoofable test-account gate (money minting), non-atomic ride state transitions (accept/cancel race, COMPLETED regression, active-ride hard delete), decline/rating/favorite authorization gaps, webhook fulfillment not bound to the local payment row, sponsor cancellation bypassing the no-show settlement, Twilio connect trusting a body-supplied userId. | See §C-2/§C-3 for the full list and tests. Non-atomic writes made atomic (`expectedStatuses`), test classification restricted to reserved/operator domains, PI-id+amount binding added before fulfillment, sponsor cancel runs the expiry settlement, Voice-token identity enforced, participant checks precede favorite/rating writes. | Fixed — Verified |
| 12 | Insecure Password Reset Flow | `portal.controller.ts` | A login 2FA code could be redeemed as a password-reset code (purpose confusion); reset token stored raw in Redis; credential change did not revoke portal sessions. | Purpose-bound OTPs (`PORTAL_RESET` vs `PORTAL_LOGIN`), hashed reset tokens, `PortalAuthService.changePassword` revokes all refresh tokens for the user, refresh rotation rejects tokens predating the password change, and the same unified token handling repairs the previously broken in-session “request password change” deep-link flow. | Fixed — Verified |
| 13 | Predictable Token Authentication Bypass | `otp.service.ts` | Static `111111` dev bypass accepted implicitly whenever `NODE_ENV=development`; codes/binding otherwise CSPRNG + hashed. | Bypass now requires an explicit `ALLOW_DEV_OTP_BYPASS=true` opt-in **and** non-production; disabled by default (test-asserted). Codes: `crypto.randomInt`, SHA-256 storage, single-use, 5-attempt cap, 10-min TTL. | Fixed — Verified |
| 14 | Excessive Authentication Attempts | `otp.service.ts`, `special-redemption.service.ts` | No resend cooldown (mail-bomb / attempt-reset loop); sponsor code validation incremented one arbitrary candidate row (limit ineffective, N-code amplification); route-level rate-limit keys for several auth routes did not match real paths. | 60 s per-(email, purpose) resend cooldown (cleared on success, fail-open only on Redis outage), per-sponsor Redis failure budget (10/15 min) with exhausted candidates filtered and deterministic ordering, and corrected rate-limit keys (+ phone-OTP budgets). | Fixed — Verified |
| 15 | Potential File Inclusion | `astar-engine.ts`, `storage.service.ts`, +4 | Fully remediated in rounds 1/2 (allowlists, containment guards, `safe-path`, dead helper removed). | Re-verified by `safe-path`/migration-guard suites and live CLI rejections; no new call sites. | Fixed — Verified (prior round) |
| 16 | Improper SSL Certificate Validation | 2 × AndroidManifest + 4 | Fully remediated in rounds 1/2 (release cleartext off, ATS hardened, TLS-bypass source scan clean). | Re-verified; debug + release APKs rebuilt this round and `aapt2` confirms `usesCleartextTraffic=false` in release. | Fixed — Verified (prior round) |

### Medium severity

| # | Finding | Reported locations | Verified root cause | Remediation | Status |
|---|---|---|---|---|---|
| 17 | Insufficient verification of WebSocket data authenticity | `socket.gateway.ts` | Role resolution failed **open** on DB errors; rider locations broadcast the raw client payload; destination-change handler used raw payload; driver-arrival map leaked on cancel; addresses unbounded. | Handshake now also runs `assertTokenStillValid` and fails **closed**; broadcasts forward only validated fields; destination handler uses validated data; cancel paths purge `driverArrivalTimes`; `address` capped at 500 chars; `maxHttpBufferSize` explicit. | Fixed — Verified |
| 18 | Improper Access Control | `ride.repository.ts`, `auth.service.ts`, +5 | Unscoped `updateStatus` primitive (any status, no owner predicate, silent no-ops); `delete` allowed active rides; favorite-driver upsert ran before rating authorization; `markCommissionPaid` ignored the partner in the route; `GET /admin/users` returned credential material; Twilio connect trusted caller-supplied identity. | Allowed-transition matrix + `expectedStatuses` atomic guards (throw on zero rows), terminal-only history delete, favorite upsert after successful rating, partner-scoped commission payment, Prisma `omit` for `password_hash`/`fcm_token`, Voice-token identity binding. | Fixed — Verified |
| 19 | Prototype Pollution — `immer` | dependency | Present only transitively in `admin_dashboard` via `recharts` (10.2.0 + 11.1.8 under redux-toolkit); no direct import; no deep-merge/`__proto__` sinks in app code. | `npm audit` 0 in all workspaces; no change required. | Verified False Positive |
| 20 | Plaintext Storage of Secrets | `auth.service.ts`, `rider_flutter auth_service.dart` | Redis stored reset/email/pwd-change/portal-reset tokens in plaintext; mobile stored `jwt_token`/`user_id`/`user_role` in SharedPreferences. | Server: SHA-256 digests only (raw token exists only in the delivered link/response). Mobile (both apps): `SecureTokenStore` on `flutter_secure_storage` (Keystore/Keychain), one-time migration purges legacy plaintext values, all ~20 call sites converted, logout clears both stores. | Fixed — Verified |
| 21 | GitHub organization IP allow-list | NetRide GitHub org | Organization-level setting; not representable in source. | Cannot be changed without org-owner authorization; precise instructions + rollout/recovery plan in §D-3. | External Action Required |
| 22 | Android exported components | 2 × AndroidManifest | `MainActivity` must stay exported for LAUNCHER + the Supabase OAuth deep link; the FCM service is `exported=false`; no receivers/providers. Every exported component audited. | No stricter declaration is possible without breaking app launch/OAuth; deep-link handling validates its token path server-side. Documented with the merged-manifest inventory. | Mitigated — Residual Risk |
| 23 | Improper Android backup configuration | 2 manifests + 2 others | `allowBackup=false` existed, but Android 12+ device-transfer could still move data; no `dataExtractionRules`. | Both apps: `fullBackupContent="false"` + `dataExtractionRules` disabling cloud backup and device-transfer; verified in packaged debug and release APKs via `aapt2`. | Fixed — Verified |
| 24 | Potential GCP API key exposure | `google-services.json` | Files are absent from the working tree and HEAD; the blobs (live-looking `AIza…` keys, project `uberish-493800`) remain in git history; `.gitignore` blocks re-adding. | Current tree verified clean. Rotation/restriction is a GCP-console action (§D-2). | External Action Required |
| 25 | Prototype Pollution — `es-toolkit` | dependency | Transitive via `recharts` (`1.46.1`); no direct import; audit clean. | No change required. | Verified False Positive |
| 26 | Prototype Pollution — `pg-connection-string` | dependency | `2.12.0` (current); audit clean; connection string only from env. | No change required. | Verified False Positive |
| 27 | Prototype Pollution — `pg` | dependency | `8.20.0` (current); audit clean; no object-merge of query inputs. | No change required. | Verified False Positive |
| 28 | Sensitive info via redirects — `follow-redirects` | dependency | `1.16.0` via axios `1.20.0`; audit clean; axios strips auth headers on cross-host redirects. | No change required. | Verified False Positive |
| 29 | Prototype Pollution — `ioredis` | dependency | `5.10.1` (bullmq-pinned); audit clean. | No change required. | Verified False Positive |
| 30 | Denial of Service — `cron-parser` | dependency | `4.9.0` — the patched release for the ReDoS advisory; only reachable through bullmq schedulers with **hardcoded** cron patterns (`*/5 * * * *`); no user-supplied expression path exists. | No change required; reachability documented. | Verified False Positive |
| 31 | Uncontrolled Resource Consumption | `otp.service.ts`, `storage.service.ts`, +3 | OTP endpoints could be re-triggered without cooldown; socket events unbounded (connections, requestRide, goOnline, chat, geo subscription); arrival map leak; unbounded address strings; upload/body caps already existed. | OTP cooldown; connection throttle (Redis, 30/min/IP, fail-open); per-user socket budgets; chat budget keyed per sender; map cleanup; bounded strings; existing 5 MB/base64 limits, MIME allowlists and `jsonShapeGuard` retained. | Fixed — Verified |
| 32 | Missing Rate Limiting | `socket.gateway.ts`, `sms.service.ts`, +1 | HTTP table keys did not match mounted routes (signup/login/ride-cancel/portal routes fell through to defaults); sockets had no connection limit; phone-OTP unprotected; sponsor route limits real but fail-open. | Corrected keys + added budgets (login/signup/oauth/change-password/request-password-change/phone-OTP/portal refresh/ride accept-decline-tip/complete-test) and a regression test asserting coverage of 21 sensitive routes; socket limits above. | Fixed — Verified |
| 33 | Exposure of Sensitive Information | `RideDetail.tsx`, `migrate-storage-visibility.cjs`, +5 | Dashboard logged full Axios error objects (bearer token + PII in dev-console); migration script printed private document object paths; `GET /admin/users` included `password_hash`/`fcm_token`; email error paths logged full Gaxios errors (request bodies = OTP codes/links); socket logs contained addresses; `verifyEmailChange` reflected `error.message` into HTML. | Console/error logging reduced to messages; object paths redacted (ids only); Prisma `omit`; static escaped HTML error page; addresses removed from logs; admin responses already `no-store`. | Fixed — Verified |
| 34 | Improper Input Validation | `admin-rewards.controller.ts` | `parseInt` → NaN/negative/huge reached SQL; status/type filters unvalidated; promo updates skipped partner/usage validation; clone suffix used `Math.random`. | `safeInt` clamps, UUID/param guards on the router, status allowlist, full re-validation of merged promo state + partner ACTIVE + `max_uses ≥ times_used`, crypto-random clone suffix, commission partner scoping. | Fixed — Verified |
| 35 | Prototype Pollution — `pino` | dependency | `8.21.0` + `pino-http 9.0.0`; audit clean; logger receives plain, bounded objects. | No change required. | Verified False Positive |
| 36 | Cross-Site Scripting in email service | `email.service.ts` | Every template interpolated raw user/DB values (names, emails, requested-field keys, admin notes, payout references) and embedded unencoded tokens/ids in URLs; error paths logged full error objects. | Added `escapeHtml`/`encodeUrlPart` (exported util) and applied to all 16 templates including `href` attributes and `requested_changes` keys; URLs percent-encode identifiers; error logging message-only. **No template field removed.** | Fixed — Verified |
| 37 | Account or Identity Enumeration | `auth.controller.ts`, `portal.controller.ts` | Signup returned “An account with this email already exists” (existence oracle); other flows already generic. | Duplicate signup returns the identical `otp_required` response and the real owner receives a password-reset email; existing generic responses (login, forgot-password, portal reset, OTP) preserved; regression tests cover existing vs unknown responses. | Fixed — Verified |

---

## C. Authentication and business-logic verification report

### C-1. Existing work reviewed (no duplication, no discarded fixes)

- Round-1/2 fixes (headers, file inclusion, SSL, zod DoS guard, path guards, Docker user, dashboard CSP) were re-inspected in the tree and re-verified by their suites — untouched this round.
- Open PR `fix/aikido-security-code-audit-146195908-538w` (OTP-only login bypass): implementation reviewed; its challenge-marker design retained, upgraded to fail-closed Redis writes, single-use consumption, and combined with the new purpose binding. Its mirror-logic test file was superseded by `auth-hardening.unit.test.ts`, which exercises the real service.
- Open PR `fix/aikido-security-code-audit-146196333-27cx` (token revocation): reviewed and extended from ADMIN-only role/`password_changed_at` checks to all roles, added socket-handshake enforcement, fail-closed middleware semantics, blocked-vs-deactivated distinction kept per product behavior, and the admin forced-rotation flow repaired with a fresh token. Neither branch was merged or modified remotely.

### C-2. Authentication / MFA / OTP / reset — how it was tested

- Real-implementation unit tests (mocked pool/Redis/email via module injection): code hashing (digest stored, plaintext never persisted), purpose binding (wrong-purpose redemption fails), single-use consumption, cooldown suppression, admin-identity binding with alternate delivery address, static-bypass default-off.
- Middleware tests: missing token → 401; malformed token → 401; revocation-check throw → 401 (fail closed, `next` not called); valid token → `req.user` set and `next` called.
- Enumeration tests (existing suite) plus new signup duplicate behavior (identical response, owner notified).
- Not executable locally (no DB/Redis/Stripe/SMTP): full login→OTP→session, portal 2FA, admin 2FA, reset-link click-through, refresh rotation. These are covered by the existing e2e suite, which requires a staging environment (§F).

### C-3. Business logic and access control — how it was tested / verified

| Check | Verification |
|---|---|
| Test-account gate | `test123@gmail.com`, `dev.user@gmail.com`, etc. classified non-test (regression suite); reserved/operator domains still classify; SQL mirror keeps the operator-domain guard. |
| Ride transitions | Allowed-transition matrix + `expectedStatuses`; queue cancels pass `[REQUESTED]` and tolerate the accept-wins race; history delete restricted to COMPLETED/CANCELLED; `updateStatus` throws on zero rows (no silent state regressions). |
| Decline/rating/favorite | Any offer mismatch (missing `offerId` or foreign offer) returns without recording a rejection or re-matching; favorite upsert now runs only after `rateRide` authorizes the caller as a COMPLETED-ride participant. |
| Webhook fulfillment | `payment_intent.succeeded` throws when the PI id ≠ stored intent id or received amount < row amount; idempotency (event-id claim + ledger unique keys) unchanged; duplicate deliveries remain no-ops; signature verification and raw-body ordering unchanged. |
| Sponsor cancel | Unvalidated `WAITING_FOR_SPONSOR` cancellation now runs the same rider no-show settlement as expiry; validated/settled states unchanged. |
| Redemption brute force | Exhausted candidates filtered, deterministic order, per-sponsor Redis budget (10 failures/15 min), counter cleared on success; atomic SPONSOR_VALIDATED transition and double-settle guards untouched. |
| Call privacy | Conference join requires `From=client:<token identity>` matching the claimed user; JWT-minting endpoint still enforces ride party + live status. |
| Admin surface | UUID/status param guards, clamped pagination, promo re-validation, commission scoping; `GET /admin/users` omits `password_hash`/`fcm_token`. |

Could not be fully verified: live Stripe webhook replay/refund scenarios, Twilio signature flows, and cross-instance rate-limit behavior — documented in §F/§G.

---

## D. Credential exposure report

No secret values are printed in this report or in any committed artifact.

| Credential / location | Assessment | Action | State |
|---|---|---|---|
| `admin@netride.org` password in `tests/scripts/diagnostics/probe-e2e.js` (was `probe-e2e-tmp.js`), plus `backend/fix-admin-auth.js` (deleted, history-only) | **Real credential** (same value in both). Environment-dependent whether the account still uses it. | Removed from the current tree; script now requires `ADMIN_TEST_PASSWORD`. **Rotate the password** in the database/admin console and re-run any script with the env var. | Code fixed; **rotation pending (operator)** |
| Partner/fleet test-account passwords (`partner-test@netride.org`, `fleet-test@netride.org`) | Test fixtures; `run-colab-identity-e2e.cjs` now generates them at runtime, `probe-e2e.js` reads them from env. | Rotate if these seeded accounts exist in production-like environments. | Code fixed; rotation optional |
| `payments.unit.test.ts` `sk_live_…` strings | Fake fixtures for the live-key interlock assertions. | None. | Verified false positive |
| `google-services.json` / `GoogleService-Info.plist` (both apps) | Not in tree/HEAD; history blobs contain Firebase client keys (`AIza…`, project `uberish-493800`). Firebase client keys are public-by-design, but the project should enforce app restrictions. | In GCP/Firebase console: restrict each key to Android package + SHA-1 / iOS bundle id, restrict APIs, regenerate and store outside git. | **Pending (operator)** |
| `MAPS_API_KEY` (driver manifest placeholder) | Value lives in untracked `local.properties`; manifest only holds the placeholder. | Restrict the key in GCP to the Android app + SHA-1. | Verified (repo); restriction recommended |
| Stripe keys | No live/test secret in the repo; client code only compares prefixes; `STRIPE_ALLOW_LIVE` interlock intact. `backend/.env` (untracked) holds a test key. | Rotate only if that env file was shared. | Verified |
| Portal/consumer reset tokens, refresh tokens, OTPs | Now stored hashed (Redis digests) or hash-only (`verification_codes`). | None. | Fixed |
| Git history generally (`.env` files, Google configs) | Still recoverable from history. | History rewrite requires explicit approval; not performed. | External decision |

---

## E. Dependency change report

| Package | Before | After | Reason | Compatibility |
|---|---|---|---|---|
| `multer` (+`@types/multer`) | 1.4.5-lts.2 (unused) | **removed** | Vulnerable 1.x line; zero importers; uploads are base64 with 5 MB caps. | No API consumers. |
| `flutter_secure_storage` | — | **^11.2.0** (both Flutter apps) | Keystore/Keychain storage for session credentials. | Resolved against Flutter 3.41.7; Android debug + release APKs built and desktop plugin registrants regenerated. |
| `cron-parser` | 4.9.0 (bullmq) | unchanged | Patched release for the ReDoS advisory; only hardcoded cron patterns. | No change. |
| `pg` / `pg-connection-string` | 8.20.0 / 2.12.0 | unchanged | Audit-clean; no merge sinks. | No change. |
| `ioredis` / `pino` / `pino-http` / `follow-redirects` / axios | 5.10.1 / 8.21.0 / 9.0.0 / 1.16.0 / 1.20.0 | unchanged | Audit-clean at installed versions. | No change. |
| `immer` / `es-toolkit` | 10.2.0+11.1.8 / 1.46.1 (dashboard, via recharts) | unchanged | No direct use; audit clean. | No change. |

Lockfiles regenerated where changed; `npm audit` reports **0 vulnerabilities in all four workspaces**. No blanket overrides were added; the existing `qs`/`deepmerge-ts` overrides from round 1 remain.

---

## F. Test evidence

All commands executed on the current working tree (Windows, Node 20, Flutter 3.41.7).

| Check | Command | Result |
|---|---|---|
| Backend typecheck/build | `npm run build` (backend) | clean (dist regenerated) |
| Backend unit/integration suite | `npm test` = `node tests/unit/backend/run-tests.cjs` | **416 passed / 0 failed** (was 401 before this round's new suites) |
| New auth/MFA/OTP/rate-limit suite | `node tests/unit/backend/run-tests.cjs auth-hardening` | **9/9 passed** |
| New ride state-machine suite | `node tests/unit/backend/run-tests.cjs ride-transition` | **6/6 passed** |
| Cross-cutting security runner | `npm run test:security` | **18/18 passed** |
| Dashboard build | `npm run build` (admin_dashboard) | built (exit 0) |
| Driver app tests | `flutter test` (driver_flutter) | **9 passed** (incl. 4 TLS) |
| Rider app tests | `flutter test` (rider_flutter) | **27 passed** (incl. 4 TLS) |
| Flutter analyzer | `flutter analyze` (both) | **no errors** (pre-existing info/warnings only) |
| Android debug APKs | `flutter build apk --debug` (both) | built |
| Android release APK | `flutter build apk --release` (rider) | built (84.1 MB) |
| Packaged manifest evidence | `aapt2 dump xmltree … AndroidManifest.xml` | release: `allowBackup=false`, `fullBackupContent=false`, `dataExtractionRules=@xml/…`, `usesCleartextTraffic=false`, no `debuggable`; debug: cleartext true (intended, debug-only) |
| Dependency scans | `npm audit` ×4 workspaces | **0/0/0/0 vulnerabilities** |
| Secret scan of changed tree | pattern scan (`sk_live_`, `AKIA`, `AIza`, `service_role`, literal passwords) | no real credential in the current tree |

**Not executed (environment constraints):** the Aikido SaaS scan itself; the DB/Redis/Stripe-backed e2e suites (`e2e:cancellation`, `e2e:full`, `e2e:specials`, `e2e:stripe`, `e2e:colab*`); iOS builds (Xcode unavailable on Windows); physical-device network tests; live Twilio webhook validation. `backend/.env` presence confirmed only; values never printed.

---

## G. Residual risk and release recommendation

### Residual risks

1. **Two financial-accounting gaps discovered during the investigation remain open by design decision** (not among the scanner locations, but part of the payments business-logic surface):
   - Refunds (`charge.refunded` and the admin refund action) only mark `stripe_payments` REFUNDED; wallet/sponsor/budget balances are not clawed back, and partial refunds are recorded as full.
   - Tips are credited to drivers but no matching rider charge exists in the settlement path.
   These require product/ledger decisions (and DB columns for refund amounts); implementing them unilaterally would change financial behavior. **Mitigated — Residual Risk**; flagged for a dedicated finance-approved change.
2. **Android exported `MainActivity`** must remain exported (launcher + OAuth deep link). Invocation is input-validated server-side; **Mitigated — Residual Risk**.
3. **`error.message` is still returned verbatim by several controllers** (portal/partner/sponsor/admin). The named scanner locations were fixed; a blanket rewrite of ~100 sites was deliberately not performed to avoid API-contract changes. **Mitigated — Residual Risk**.
4. **Rate limiters fail open on Redis outages** (HTTP and socket). Chosen to preserve availability; documented.
5. **History-exposed credentials** (admin password, Firebase client keys) remain valid until rotated. See §D.
6. **Admin dashboard has pre-existing lint/type debt (~220 findings)** unrelated to this change set; no security-changed lines are affected.
7. **Release APKs are still debug-signed** (pre-existing) — needs an upload keystore before store submission.

### External actions required (operator)

1. Rotate the `admin@netride.org` password (exposed in git history).
2. Restrict/rotate the Firebase/GCP keys from the history-deleted `google-services.json`/`GoogleService-Info.plist` and the Maps key.
3. GitHub organization IP allow-list: enable under Org → Settings → Security (requires GitHub Enterprise Cloud). Suggested safe rollout: start in **monitor mode**, collect runner/deploy egress IPs (Render static egress, GitHub-hosted runner ranges via the meta API), add the allow-list, then enforce; keep a break-glass owner token. Verify in the org audit log. Not changed by this work.
4. Produce an Android upload keystore + `key.properties` and wire CI signing.
5. Decide on git-history rewrite (BFG/filter-repo) for the removed `.env`/Google configs — requires explicit approval and coordinated force-push.
6. Production hygiene already recommended by prior rounds: set `CORS_ORIGINS`, restrict `/metrics` at the proxy.

### Release recommendation

- **Staging: recommended.** All executed suites pass, builds are green, and the fixes are fail-closed where it matters.
- **Production: gated** on (a) the credential rotations above, (b) one staging run of the DB/Redis/Stripe e2e suites (the login→OTP→session, portal 2FA, reset-link, webhook, and refund paths must be exercised against a real environment), and (c) the Android signing keystore.
- No scanner was suppressed; no security control was weakened to make tests pass; all 37 findings have an explicit disposition.

---

## H. Files changed

**Backend source (security-relevant):**
`src/app.ts` (socket auth/revocation, connection throttle, payload cap, migration bootstrap 060), `src/middleware/auth.middleware.ts` (async revocation check), `src/middleware/rateLimitConfig.ts` (route-accurate limits), `src/modules/auth/auth.service.ts` (challenge binding, hashed tokens, admin 2FA binding, revoked-token check, generic duplicate signup, change-password policy), `src/modules/auth/otp.service.ts` (purpose binding, cooldown, env-gated dev bypass), `src/modules/auth/auth.controller.ts`, `src/modules/portal/portal-auth.service.ts` + `portal.controller.ts` (purpose-bound OTP, hashed reset tokens, refresh-token revocation), `src/modules/ride/feature.routes.ts`, `ride.repository.ts`, `ride.service.ts`, `ride.controller.ts`, `src/modules/payments/webhook.service.ts`, `src/modules/sponsor/special-redemption.service.ts`, `src/modules/admin/admin.controller.ts`, `admin-rewards.controller.ts`, `admin-rewards.routes.ts`, `src/modules/partner/partner.service.ts`, `src/modules/user/user.controller.ts`, `src/services/email.service.ts`, `src/gateway/socket.gateway.ts`, `src/utils/socket-validation.ts`, `src/utils/testUser.ts`, `src/utils/html-escape.ts` (new), `src/queue/jobs/matchRide.ts`, `src/services/matching.service.ts`, `scripts/migrate-storage-visibility.cjs`, `migrations/060_otp_purpose.sql` (new), `package.json` / `package-lock.json` (multer removed), tracked `dist/` rebuilt.

**Dashboards:** `apps/admin_dashboard/src/pages/ChangePassword.tsx` (fresh-token adoption), `src/pages/RideDetail.tsx` (safe error logging).

**Mobile (both apps):** `lib/services/secure_token_store.dart` (new), `lib/services/auth_service.dart` + `api_service.dart` + all token read sites (`main.dart`, providers, screens), `pubspec.yaml` / `pubspec.lock` (flutter_secure_storage ^11.2.0), `android/app/src/main/AndroidManifest.xml` (fullBackupContent + dataExtractionRules), `android/app/src/main/res/xml/data_extraction_rules.xml` (new), regenerated desktop plugin registrants.

**Tests:** `tests/unit/backend/security/auth-hardening.unit.test.ts` (new), `tests/unit/backend/security/ride-transition-guards.unit.test.ts` (new), `tests/unit/backend/run-tests.cjs` (suites registered), `tests/fixtures/seed-loadtest-riders.cjs`, `tests/loadtest/ride-request.js`, `tests/e2e/dashboard-workflows/run-colab-identity-e2e.cjs`, `tests/scripts/diagnostics/probe-e2e.js`.

**Docs:** this report (`tests/docs/audits/NETRIDE_SECURITY_REMEDIATION_ROUND3.md`).

No production deployment, merge, credential rotation, or organization setting was performed. The two open remediation branches remain unmerged; their correct parts are incorporated here and their test intent is covered by implementation-level tests.
