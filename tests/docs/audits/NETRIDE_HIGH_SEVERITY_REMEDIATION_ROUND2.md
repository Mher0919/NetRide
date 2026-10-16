# NetRide — High-Severity Remediation Report (Round 2)

Date: 2026-10-16
Scope: four reported high-severity findings — Express security headers, zod DoS, unsafe filesystem access, improper SSL certificate validation.
Baseline: working tree at `11b0e66` (round-1 remediation committed as `b2a0954`). All work is staged in the working tree, uncommitted.

---

## Finding A — Express security headers (High)

**Reported locations:** `app.ts`, `server.js`, one additional → the repository contains exactly three Express entry points: `backend/src/app.ts`, `apps/admin_dashboard/server.js`, `apps/sponsor_portal/server.js` (verified by scanning every `express()` instantiation; all other `express` matches are routers/middleware).

**Verified root cause:** headers existed only as duplicated inline middleware; the backend still exposed `X-Powered-By`, HSTS was emitted unconditionally (including plain-HTTP local development), dashboard servers listened at import time so header behavior on real response paths could not be regression-tested, and nothing proved coverage of error/redirect paths.

**Changes:**
- `backend/src/middleware/securityHeaders.middleware.ts` (new): single policy for every response — `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, locked-down CSP (`default-src 'none'; frame-ancestors 'none'; base-uri 'none'`), `Permissions-Policy`, and **HSTS only when `req.secure`** (works behind Render via `trust proxy`). Registered before all routes/error handlers in `app.ts`.
- `backend/src/app.ts`: uses the middleware; added `app.disable('x-powered-by')`.
- Both dashboard `server.js`: refactored to an exported `createApp({ distDir })` factory (listens only when run directly, so `npm start`/`node server.js` behavior is unchanged — smoke-tested), `trust proxy` = 1, `x-powered-by` disabled, transport-aware HSTS, CSP unchanged from round 1 (admin: no third-party script origins; sponsor: `js.stripe.com` + `hooks.stripe.com` for the funding flow).

**Regression tests:**
- `tests/unit/backend/security/security-headers.unit.test.ts`: real HTTP assertions on 200, 302 and 500 responses (all headers, no HSTS on plain HTTP) plus HSTS presence with `X-Forwarded-Proto: https`.
- `tests/security/run-security-checks.cjs` (new root script `npm run test:security`): starts both dashboards on ephemeral ports with a temp `dist`; asserts headers on the SPA shell (200), on 404s, HSTS only for TLS, and app-specific CSP origin allowlists.

**Evidence:** backend `tsc` clean; `401/401` backend unit tests; `18/18` security checks. Express's `finalhandler` stamps its own hardened `default-src 'none'` CSP on unhandled 404s (verified) — assertions accept both policies. **Status: Fixed.**

---

## Finding B — zod denial of service (High)

**Verified root cause:** **CVE-2023-54404 / GHSA-mrhx-c7xc-m3w5** — zod's container validation accumulates one issue object per failing element with no cap and no early termination (`$ZodArray` / `handleArrayResult`), so a multi-megabyte array of invalid values allocates hundreds of MB and crashes the process. Advisory references zod issue #1872 and fix PR colinhacks/zod#6475; the patched line starts at 4.6.6 (the `abortEarly` option exists at runtime in 4.6.7). The repository had `zod@3.25.76` — inside the vulnerable class. npm audit does not flag it because the advisory has no package/version mapping (unreviewed); no other workspace or transitive copy of zod exists.

**Changes:**
- `zod` `^3.22.4` → `^4.6.7` (backend `package.json` + lockfile; `npm ls zod` → single 4.6.7 copy).
- zod v4 migration (compile-verified): `env.ts` boolean-flag defaults (`.default('false')` → `.default(false)`, 7 sites), `AnyZodObject` → `ZodType`, and all legacy `ZodError.errors` accesses → `.issues` (13 call sites, including `any`-typed catch blocks that TypeScript could not flag).
- `backend/src/utils/zod-parse.ts` (new): bounded parse helpers that pass the CVE mitigation `abortEarly: true` (runtime-supported; the published 4.6.7 typings lag, so the single cast is centralised and documented). Wired into the HTTP `validate` middleware, the socket `validate()` helper, and the `reportActivity` handler.
- `backend/src/middleware/jsonShapeGuard.middleware.ts` (new): boundary guard on JSON/urlencoded bodies — max 10,000 array elements, 5,000 object keys, 32 nesting levels → `413`. This is the real OOM mitigation since byte limits do not bound element counts. Wired in `app.ts` immediately after the body parsers.
- Schema audit: the only external array schemas are `car_photo_urls` (`.max(4)`) and notification `ids` (`.max(100)`); no unbounded array schema exists. Largest legitimate payloads are orders of magnitude below the guard limits.

**Regression tests (`tests/unit/backend/security/zod-dos.unit.test.ts`):**
- pins the installed zod version ≥ 4.6.6;
- demonstrates the amplification on 20,000 hostile elements (20,000 issues default) and that the bounded parse collapses it to ≤ 5 issues in bounded time;
- proves bounded parsing leaves valid payloads identical;
- guard unit tests (arrays/depth/keys boundaries, scalars ignored);
- HTTP integration: hostile array → 413, wrong-typed array → 400 with a single detail, valid payload → 200.

**Evidence:** `392 → 401` backend tests, all pass; backend audit 0 vulnerabilities after the major upgrade. **Status: Fixed.**

---

## Finding C — Potential file inclusion / unsafe filesystem access (High)

**Reported locations:** `astar-engine.ts`, `backfill-applied.cjs`, + two additional. All filesystem read sites in the repo were enumerated; dispositions:

| Location | Input source | Disposition |
|---|---|---|
| `backend/scripts/backfill-applied.cjs` | `process.argv[2]` + `readdir` | **Fixed** — was `readFileSync(path.join(DIR, argv[2]))` with no validation (traversal / absolute-path arbitrary read). Now: migrations-directory allowlist (mirrors `run-migrations.cjs`) + shared filename guard. |
| `backend/src/scripts/run-migration.ts` | `process.argv[2]` | **Fixed** — `path.join(__dirname, '../../migrations/', argv[2])` was traversal-capable; now `resolveMigrationFilename()` (pattern + containment). |
| `backend/src/routing/engine/astar-engine.ts` | operator config (`ROUTING_GRAPH_PATH` / CLI) | **Hardened in round 1** (resolve + regular-file check); now regression-tested (missing file, directory, and a valid graph round-trip). |
| `backend/scripts/run-migrations.cjs`, `migration-parse.cjs` | argv + `readdir` | Already allowlisted against the directory listing; now also use the shared filename guard. Live check: `node scripts/migration-parse.cjs ../secrets.sql` → `[missing]`, Windows absolute path likewise rejected. |
| `backend/src/services/push-notification.service.ts` | operator env (`FCM_SERVICE_ACCOUNT_PATH`) | **Hardened** — requires a regular file before reading. |
| `backend/src/scripts/preprocess-map.ts` / `routing/preprocessing/pbf-parser.ts` | operator CLI (PBF in, graph out) | **Verified / trusted input** — the tool's purpose is to read an operator-chosen PBF and write an operator-chosen graph; no request-derived or untrusted input; runs with the operator's own privileges; `path.resolve` + OS errors on invalid targets. Documented rather than artificially constrained (containment would break intended usage). |
| `backend/src/app.ts` migration bootstrap | hardcoded filenames (001…NNN) | Verified safe. |
| `storage.service.ts`, `files.routes.ts`, `email.service.ts` | DB records / UUID route param | Verified safe (server-generated, sanitized segments; the traversal-capable dead helper was removed in round 1). |

**New shared guards:** `backend/scripts/lib/migration-file.cjs` (CJS scripts) and `backend/src/security/safe-path.ts` (TS). Both reject `..`, separators, absolute paths, null bytes, encoded traversal, over-long names, and enforce containment (`path.dirname(resolved) === root`). CJS/TS duplication is deliberate — the scripts run under plain `node` without ts-node.

**Regression tests:**
- `tests/unit/backend/security/safe-path.unit.test.ts` — traversal/absolute/encoded rejection, containment in a temp root, astar rejections + valid load.
- `tests/unit/backend/security/migration-file-guard.unit.test.cjs` — same matrix for the shared CJS guard plus every real migration filename in the repo.

**Evidence:** all tests pass; live CLI rejection checks pass. **Status: Fixed** (preprocess/pbf location explicitly dispositioned as trusted-operator input).

---

## Finding D — Improper SSL certificate validation (High)

**Reported locations:** two `AndroidManifest.xml` + four additional. Verified set: 2 release manifests, 2 debug manifests, 2 `Info.plist`, plus the two profile manifests and the absence of any `network_security_config.xml`.

**Verified root cause (as of the scanner's snapshot):** release builds allowed cleartext traffic and iOS ATS allowed arbitrary loads. Those were corrected in round 1 (committed): release manifests now `usesCleartextTraffic="false"` + `allowBackup="false"`; cleartext is a **debug-only** override (`tools:replace`, debug source set) so development allowances cannot leak into release merges; `NSAllowsArbitraryLoads` replaced with `NSAllowsLocalNetworking`. Repository-wide source scan (Dart/Kotlin/Java/Swift under `lib/`, `android/app/src`, `ios/Runner`) found **no** `badCertificateCallback`, `onBadCertificate`, `HttpOverrides`, custom `X509TrustManager`/`HostnameVerifier`, `allowInsecure`, or `serverTrust` overrides — the apps rely on platform defaults. The payout WebView keeps JS enabled (Stripe requires it) with a navigation delegate that only allows `https://*.stripe.com`.

**Regression tests:**
- `tests/security/run-security-checks.cjs`: platform config invariants for all 8 files (release cleartext/backup/`debuggable`, debug-only override, no ATS arbitrary loads or exception domains, WebView navigation allowlist) + a repo-wide TLS-bypass pattern scan.
- `apps/driver_flutter/test/tls_verification_test.dart` and `apps/rider_flutter/test/tls_verification_test.dart`: platform-level tests against a controlled local TLS server (certificates generated with OpenSSL at test time): **trusted + matching hostname accepted; self-signed chain rejected; hostname mismatch rejected; expired certificate rejected** — all via the unmodified dart:io trust pipeline.

**Evidence:** driver `flutter test` 9/9; rider `flutter test` 27/27; `flutter analyze` — no errors in either app (pre-existing info/warning debt only). **Status: Fixed.**

---

## Verification summary

| Check | Command | Result |
|---|---|---|
| Backend typecheck/build | `npm run build` (backend) | clean |
| Backend unit + integration tests | `npm test` (backend) | **401 passed / 0 failed** (was 385 pre-round) |
| Zod DoS suite | `run-tests.cjs security` | version pin, amplification, guard, HTTP integration all pass |
| Dashboard + mobile security checks | `npm run test:security` (root) | **18/18 passed** |
| Driver app tests | `flutter test` | 9 passed (incl. 4 TLS) |
| Rider app tests | `flutter test` | 27 passed (incl. 4 TLS) |
| Flutter static analysis | `flutter analyze` (both apps) | no errors |
| Admin build | `vite build` | success (pre-existing 123 unrelated `tsc` errors, build unaffected) |
| Sponsor build | `npx tsc -b` + `vite build` | 0 errors / success |
| Dependency scans | `npm audit` ×4 | **0 vulnerabilities** in all four workspaces |
| Dashboard server CLI smoke | `node server.js` (both apps, `PORT=0`) | both start and listen (main-guard refactor is deploy-safe) |
| Guard CLI behavior | `migration-parse.cjs ../secrets.sql`, Windows absolute path | rejected (`[missing]`) |

**Not run (environment limits):** Android/iOS device or emulator builds (`flutter build apk`/`ipa` requires the mobile SDK chain and signing), Docker image rebuild (backend builds from source inside the image; the round-1 non-root image build remains valid and no Dockerfile changes were made), and the DB/Redis-backed e2e suites (require staging infra; do not run against production).

---

## Files changed

**Backend:** `src/app.ts`, `src/config/env.ts`, `src/middleware/{validate.middleware.ts,securityHeaders.middleware.ts*,jsonShapeGuard.middleware.ts*}`, `src/utils/{socket-validation.ts,zod-parse.ts*}`, `src/gateway/socket.gateway.ts`, `src/modules/driver/driver.controller.ts`, `src/modules/routing/routing.controller.ts`, `src/routing/api/routing-api.ts`, `src/scripts/run-migration.ts`, `src/services/push-notification.service.ts`, `src/security/safe-path.ts*`, `scripts/{backfill-applied.cjs,run-migrations.cjs,migration-parse.cjs}`, `scripts/lib/migration-file.cjs*`, `package.json`, `package-lock.json`, tracked `dist/` build output.
**Dashboards:** `apps/admin_dashboard/server.js`, `apps/sponsor_portal/server.js`.
**Mobile:** `apps/driver_flutter/test/tls_verification_test.dart*`, `apps/rider_flutter/test/tls_verification_test.dart*` (platform config already hardened in round 1).
**Tests/docs:** `tests/unit/backend/security/{security-headers.unit.test.ts*,zod-dos.unit.test.ts*,safe-path.unit.test.ts*,migration-file-guard.unit.test.cjs*}`, `tests/security/run-security-checks.cjs*`, `tests/unit/backend/run-tests.cjs`, root `package.json`.

`*` = new file.

---

## Residual risk

- **zod `abortEarly` typings:** the option is runtime-supported in 4.6.7 but absent from its published types; the cast is isolated in `utils/zod-parse.ts` and pinned by tests. Remove the cast when upstream exposes it.
- **Platform — device verification:** Dart TLS tests ran on the host VM, not on a physical device/emulator; Android manifest merging was validated structurally (debug-only overlay) but not through a Gradle build in this environment. Recommended: one CI emulator/device pass (`flutter build apk --debug` + integration smoke) before store submission.
- **Pre-existing debt unrelated to this round:** admin dashboard `tsc -b` errors (123, build unaffected), Flutter analyzer info/warnings.
- **Deployment actions:** stage/commit the working tree; the round-1 rotation checklist for historically exposed Google/Firebase keys still stands (git history untouched).

## Final recommendation

All four findings have a verified root cause, a code/config fix, and automated regression coverage executed locally: **Finding A Fixed, Finding B Fixed, Finding C Fixed, Finding D Fixed**. Backend, dashboards and mobile apps build and their test suites pass with zero new vulnerabilities in any workspace. The components are ready for a **staging deployment**; schedule a device-emulator smoke run and the staging e2e suite as the remaining pre-production gates. Do not treat this as production-ready until that mobile device pass and staging validation are complete.
