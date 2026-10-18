# NetRide — Consolidated Security Remediation Report (Final)

Date: 2026-10-16
Prompt scope: three Aikido HIGH findings — Express security headers, potential file inclusion (6 locations), improper SSL certificate validation (6 locations).
Repository state: implementations landed in commits `b2a0954` and `2364470`; working tree clean at `2364470`. This round adds independent re-verification against the wider 6-location scope and **real Android build evidence**. No code changes were required in this round beyond what was already committed — nothing below is claimed without executed evidence.

---

## A. Executive summary

| Finding | Status |
|---|---|
| 1 — Missing Express security headers (`app.ts`, `server.js` +1) | **Fixed** |
| 2 — Potential file inclusion (`astar-engine.ts`, `backfill-applied.cjs` +4) | **Fixed** (one location dispositioned as trusted operator-only input) |
| 3 — Improper SSL certificate validation (2 × `AndroidManifest.xml` +4) | **Fixed** |

Most important changes: a single transport-aware security-header policy applied to all three Express entry points with regression tests on success/redirect/error/404 paths; zod upgraded to the patched 4.6.7 line with a JSON shape guard capping request complexity (CVE-2023-54404 class) during the prior round's work; filesystem reads from argv/CLI/env constrained by allowlists and containment guards; and mobile release builds proven — via Gradle merged manifests **and the packaged APKs themselves** — to reject cleartext while debug-only overrides stay out of release.

This round's new evidence: four real Android APK builds (debug + release for both apps), `aapt2` inspection of the packaged manifests, Dart platform TLS tests re-run, all test suites and audits re-run clean.

---

## B. Finding-by-finding remediation matrix

### Finding 1 — Missing Express security headers (High)

| Reported location | Verified root cause | Change | Status |
|---|---|---|---|
| `backend/src/app.ts` | Headers were inline, HSTS unconditional (also on plain-HTTP dev), `X-Powered-By` exposed | `securityHeaders.middleware.ts` applied before all routes/error handlers; HSTS only when `req.secure` (works via `trust proxy`); `app.disable('x-powered-by')` | Fixed |
| `apps/admin_dashboard/server.js` | No headers ever; server listened at import so untestable | Exported `createApp()` factory with CSP + baseline headers, transport-aware HSTS, `trust proxy`=1, `x-powered-by` disabled; listens only when run directly (`npm start` smoke-tested) | Fixed |
| `apps/sponsor_portal/server.js` (the "additional" entry point) | Same as admin | Same; CSP additionally allows `js.stripe.com`/`hooks.stripe.com` for the funding flow | Fixed |

Entry-point inventory confirmed by scanning every `express()` instantiation: exactly these three applications exist (all other matches are routers/middleware). Middleware order verified: headers → webhook/body parsers → rate limit → routes → error handler. Express's `finalhandler` replaces the CSP with its own hardened `default-src 'none'` on unhandled 404s — equally strict, and covered by the dashboard test assertions.

Tests: `tests/unit/backend/security/security-headers.unit.test.ts` (200/302/500 + TLS-gated HSTS); `tests/security/run-security-checks.cjs` (both dashboards: SPA shell, 404, HSTS gating, per-app CSP origin allowlists).

### Finding 2 — Potential file inclusion (High) — all assessed locations

| Location | Input source | Disposition |
|---|---|---|
| `backend/src/routing/engine/astar-engine.ts` | `ROUTING_GRAPH_PATH` / CLI (operator) | **Fixed/hardened** — `path.resolve` + regular-file requirement; regression-tested (missing file, directory rejected; valid graph round-trips) |
| `backend/scripts/backfill-applied.cjs` | `process.argv[2]` | **Fixed** — was `readFileSync(path.join(DIR, argv[2]))` (traversal / absolute-path read); now directory allowlist + shared `migration-file.cjs` guard |
| `backend/src/scripts/run-migration.ts` | `process.argv[2]` | **Fixed** — containment + filename pattern via `safe-path.ts` |
| `backend/src/services/push-notification.service.ts` | `FCM_SERVICE_ACCOUNT_PATH` (operator env) | **Hardened** — requires a regular file before reading |
| `backend/src/scripts/preprocess-map.ts` + `backend/src/routing/preprocessing/pbf-parser.ts` | CLI input/output paths | **Verified** — the tool's purpose is operator-chosen PBF → graph conversion; no request-derived input; runs as the invoking operator; `path.resolve` + OS errors for invalid targets. Artificially constraining it would break supported usage; documented instead |
| `backend/scripts/{run-migrations,migration-parse,gaps}.cjs`, `apply-036.js` | Directory listings / hardcoded names | **Verified** — listing-derived or hardcoded; run/parse additionally use the shared guard; live check: `../secrets.sql` and a Windows absolute path → `[missing]` |
| `backend/src/app.ts` migration bootstrap | Hardcoded filenames | **Verified** safe |
| `backend/src/services/storage.service.ts`, `routes/files.routes.ts`, `services/email.service.ts` | DB records / UUID params / server-generated paths | **Verified** safe (the traversal-capable dead helper was removed in round 1) |

New guards: `backend/scripts/lib/migration-file.cjs`, `backend/src/security/safe-path.ts` — reject `..`, separators, absolute paths, null bytes, encoded traversal, over-long names; enforce `dirname(resolved) === root`.

Tests: `tests/unit/backend/security/safe-path.unit.test.ts`, `tests/unit/backend/security/migration-file-guard.unit.test.cjs` (traversal matrix + every real migration file passes), plus the live CLI rejections above.

### Finding 3 — Improper SSL certificate validation (High) — all assessed locations

The six reported locations are the platform network-configuration files (2 release `AndroidManifest.xml`, 2 debug `AndroidManifest.xml`, 2 `Info.plist`); the two `profile` manifests were also inspected. There is **no** `network_security_config.xml` and **no** custom TLS code anywhere (`badCertificateCallback`, `onBadCertificate`, `HttpOverrides`, `X509TrustManager`, `HostnameVerifier`, `allowInsecure`, `serverTrust` → zero matches across `lib/`, `android/app/src`, `ios/Runner`).

| Location | Verified root cause | Change | Status |
|---|---|---|---|
| `apps/driver_flutter/.../main/AndroidManifest.xml` | Release allowed cleartext traffic | `usesCleartextTraffic="false"`, `allowBackup="false"` | Fixed |
| `apps/rider_flutter/.../main/AndroidManifest.xml` | Same | Same | Fixed |
| `apps/*/.../debug/AndroidManifest.xml` (2) | Scanner flags the cleartext flag; it must exist for local dev | Kept debug-only via `tools:replace`, isolated to the debug source set so release merges cannot inherit it | Fixed (intentional dev exception, proven isolated) |
| `apps/driver_flutter/ios/Runner/Info.plist`, `apps/rider_flutter/ios/Runner/Info.plist` | ATS allowed arbitrary loads | Replaced with `NSAllowsLocalNetworking`; no exception domains | Fixed |
| `apps/*/.../profile/AndroidManifest.xml` (2, inspected) | — | Clean (INTERNET only) | Verified |

**Release-build evidence (this round):** built debug + release APKs for both apps and inspected the *packaged* manifests with `aapt2`:

- release APKs: `usesCleartextTraffic=false`, `allowBackup=false`, no `debuggable` — for both apps;
- debug APKs: `usesCleartextTraffic=true`, `debuggable=true`, `allowBackup=false` — debug-only override working as designed;
- Gradle merged-manifest intermediates agree with the APK contents.

Tests: repo config invariants + TLS-bypass source scan in `tests/security/run-security-checks.cjs`; Dart platform tests (`apps/{driver,rider}_flutter/test/tls_verification_test.dart`) using a controlled local TLS server with OpenSSL-generated certificates prove: trusted+matching accepted, self-signed chain rejected, hostname mismatch rejected, expired certificate rejected.

---

## C. Files changed (over both remediation commits)

- **Backend security**: `src/middleware/{securityHeaders,jsonShapeGuard,validate}.middleware.ts`, `src/utils/{zod-parse,socket-validation}.ts`, `src/security/{file-url,safe-path}.ts`, `src/app.ts`, `src/config/env.ts`, `src/gateway/socket.gateway.ts`, `src/modules/{driver/driver.controller,routing/routing.controller,payments/payments.controller,user/user.controller}.ts`, `src/routing/{api/routing-api,engine/astar-engine}.ts`, `src/scripts/run-migration.ts`, `src/services/{email,push-notification}.service.ts`, `src/modules/payments/return-target.ts`, `scripts/{backfill-applied,run-migrations,migration-parse}.cjs`, `scripts/lib/migration-file.cjs`, `Dockerfile` (prior round), `package.json`/lockfile (zod 4.6.7, ts-node-dev→tsx, overrides).
- **Dashboards**: `apps/{admin_dashboard,sponsor_portal}/server.js` (+ `apps/admin_dashboard/src/utils/safeUrl.ts` and page call sites from round 1).
- **Mobile**: release/debug manifests and `Info.plist` (both apps), `apps/driver_flutter/lib/screens/profile_screen.dart` (WebView navigation allowlist), both `test/tls_verification_test.dart`.
- **Tests**: `tests/unit/backend/security/*` (headers, zod-DoS, safe-path, migration guard), `tests/security/run-security-checks.cjs`, `tests/unit/backend/run-tests.cjs`, root `package.json` (`test:security`).
- **Docs**: `tests/docs/audits/NETRIDE_HIGH_SEVERITY_REMEDIATION_ROUND2.md`, this report.

## D. Test evidence (all executed, current tree)

| Check | Command | Result |
|---|---|---|
| Backend typecheck/build | `npm run build` (backend) | clean |
| Backend unit/integration | `npm test` (backend) | **401 passed / 0 failed** |
| Cross-cutting security | `npm run test:security` (root) | **18/18 passed** |
| Driver app | `flutter test` | **9 passed** (incl. 4 TLS) |
| Rider app | `flutter test` | **27 passed** (incl. 4 TLS) |
| Android debug APK | `flutter build apk --debug` | built (both apps); packaged manifest verified via `aapt2` |
| Android release APK | `flutter build apk --release` | built (both apps); packaged manifest verified via `aapt2` |
| Release signing inspection | `apksigner verify --print-certs` | `CN=Android Debug` — see residual risk |
| Dependency scans (npm audit equivalent) | `npm audit` in all 4 workspaces | **0/0/0/0 vulnerabilities** |
| Dashboard lint | `npm run lint` (sponsor / admin) | sponsor clean; admin 220 pre-existing errors across ~30 files — **none on the security-changed lines** (verified per-file) |
| Rider build repair | `flutter clean` + remove `android/.gradle` + `flutter pub get` | fixed stale local Gradle state (pre-existing environment issue, unrelated to security changes) |

**Not executed:** the Aikido SaaS scan itself (no local access — the equivalent scans above were run instead); iOS builds (Xcode unavailable on Windows); physical-device/emulator functional network test (manifest-level and Dart-level behavior verified instead).

## E. Residual risk and release recommendation

- **Release APKs are currently debug-signed** (`CN=Android Debug`) — a keystore/CI secret is required; add an upload keystore before store submission. Kept as an explicit operator action, not silently patched.
- iOS ATS configuration is verified statically; run one Xcode build/device pass in CI to confirm the merged `Info.plist`.
- Admin dashboard lint/type debt is pre-existing and untouched.
- Round-1 credential-rotation checklist for historically exposed Google/Firebase configs still stands (git history untouched).
- Debug builds intentionally allow cleartext for local development; this is isolated by build variant and proven not to leak into release.

**Recommendation:** all three findings are fixed at their verified sources with executed regression evidence, all reported locations have an explicit disposition, builds and suites are green, and no security control was weakened or suppressed. The components are ready for a **staging deployment**; before production store release, complete the two gating items — production Android keystore and one CI device pass (Android emulator + iOS build) — and run the staging e2e suite.
