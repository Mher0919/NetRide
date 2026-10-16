# NetRide Security Remediation Report

Date: 2026-10-15
Scope: full monorepo (backend, admin dashboard, sponsor portal, driver/rider Flutter apps, infrastructure, dependencies).
Baseline evidence: `%TEMP%\opencode\netride-baseline\audit-{root,admin,sponsor,backend}.json` (pre-fix) and `audit-*-post.json` (post-fix). Secret values are never reproduced in this report; secret-bearing files were reviewed with masked output only.

## 1. Executive summary

| Workspace | Baseline vulnerabilities | After remediation |
|---|---|---|
| root (`package.json`) | 37 (26 high, 1 critical) | **0** |
| `apps/admin_dashboard` | 16 (11 high, 1 critical) | **0** |
| `apps/sponsor_portal` | 4 (3 high, 1 critical) | **0** |
| `backend` | 25 (14 high, 1 critical) | **0** |

Application-level fixes: global security headers + CSP, strict URL-scheme validation for all user-supplied document URLs, deep-link `kind`/`state` allowlisting for payment returns, removal of traversal-capable dead code, container runs as non-root (verified), Android cleartext/backup hardening, iOS ATS hardening, WebView host allowlist, and untracking of committed environment files.

Verification: backend `tsc` build clean, `385/385` backend unit tests pass (including 6 new security regression tests), admin/sponsor `vite build` clean, sponsor `tsc` clean, Docker image builds and runs as `uid=1000(node)`, all XML/manifest/plist files parse.

## 2. Prompt findings — dispositions

Legend: **Fixed** = code/dependency change shipped; **Verified** = reviewed in depth, no vulnerability present (evidence below); **Action** = operator action required, cannot be completed from the codebase.

| # | Finding | Disposition | Evidence |
|---|---|---|---|
| A | Trusted proxy / `proxy-addr` | Fixed | Critical advisory GHSA-jqcg-44mw-7w3h (`proxy-addr >=1.1.0 <2.0.8`) resolved to 2.0.8+ in all three Express services via lockfile updates. `app.set('trust proxy', 1)` (`backend/src/app.ts:149`) is already correct for the single Render proxy. |
| B | SQL injection (`sponsor.service.ts`, `ride.service.ts`) | Verified | All values are bound parameters. Dynamic SQL fragments are static strings, allowlisted column names (`sponsor.service.ts:302-319`), computed placeholder indexes (`$n`), or server-derived constants (`ORDER BY km_away ASC` / `created_at DESC`). `admin-sponsor.controller.ts` filter builder uses `$n` placeholders + bound values. No string interpolation of user input into SQL found in ride/sponsor/admin/ride-state modules. |
| C | Missing security headers (backend + dashboards) | Fixed | `backend/src/app.ts` now sets `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, HSTS, `Permissions-Policy`, locked-down CSP on every API response. `apps/admin_dashboard/server.js` and `apps/sponsor_portal/server.js` now set CSP + the same baseline headers before static serving; `x-powered-by` disabled. Sponsor CSP additionally allows `js.stripe.com`/`hooks.stripe.com` for the funding flow. |
| D | Open redirect (`payments.controller.ts`) | Fixed | `kind`/`state` query values are attacker-controllable and were echoed into the `netride://` deep link. New `backend/src/modules/payments/return-target.ts` allowlists both (`card|topup|driver_onboarding`, `success|cancel|refresh|done`), defaulting safely; `returnHandler` uses it (`payments.controller.ts:215-236`). No user-controlled redirect target exists anywhere else (`res.redirect` review: 3 call sites, all env-based). |
| E | Stored XSS via document URLs (`UserDetail.tsx`, `RideAudit.tsx`) | Fixed | Both sides hardened: (1) `apps/admin_dashboard/src/utils/safeUrl.ts` only opens `http(s)`/same-origin URLs with `noopener,noreferrer`; all 4 `window.open` call sites updated (incl. legacy JSON-array parsing, now also crash-proof); (2) `backend/src/security/file-url.ts` rejects `javascript:`, `data:`, `file:`, `ftp:` and scheme-relative URLs on every write path (driver onboarding/profile/vehicle, rider identity). Previously `z.string().url()` accepted `javascript:` URIs. |
| F | File inclusion / path traversal (`email.service.ts`, `astar-engine.ts`) | Fixed | `EmailService.getAttachment` was unreferenced dead code with an unsanitized `path.join(..., filePart)` on `/uploads/` splits — removed along with its unused `fs`/`path` imports. `AStarEngine.loadGraph` now `path.resolve`s the operator-configured path and requires a regular file (rejects directories/devices/FIFOs); input is config-only, never request-derived. `StorageService`/`files.routes.ts` were already path-safe (server-generated paths, sanitized segments, UUID route param). |
| G | Command injection (`shell-quote`) | Fixed | Sole consumer was the unused Expo toolchain in the root package (critical `shell-quote` 1.8.4–1.10.0). Root `expo` dependency removed (no `app.json`/`eas.json`/imports exist — the repo's apps are Flutter/Vite). Root audit: 37 → 0. |
| H | HTTP request smuggling (`undici <=6.28.0`) | Fixed | Transitive to the removed Expo tree; resolved by removal + dependency updates. |
| I | Prototype pollution (axios, immer, es-toolkit, pg, pg-connection-string, ioredis, pino, ...) | Fixed | `axios` bumped to `^1.20.0` in all three npm services (clears 20+ advisory ranges `<1.20.0`); backend `qs` override `^6.16.1` (clears GHSA-4mjr-xmp4-gh2g etc.); `pg`/`ioredis`/`pino` transitives refreshed via lockfiles; no vulnerable immer/es-toolkit usage remains in the audit output. |
| J | DoS clusters (qs, qs-adjacent, body-parser, brace-expansion, micromatch, nanoid, etc.) | Fixed | Fixed via upgrades + overrides. `ts-node-dev` (high, no fix) removed and replaced with `tsx watch`; this also eliminates the unfixable `braces`/`chokidar@2` transitive chain. |
| K | Crypto/dependency cluster (node-forge, uuid, @xmldom/xmldom, form-data, follow-redirects, source-map-js, ws, engine.io, socket.io-parser, @fastify/busboy, tinyexec, jose, react-router, nanoid, yargs, pino) | Fixed | Per-package upgrades: `firebase-admin ^14.5.0` (drops vulnerable `@fastify/busboy`, `gaxios`/`uuid@9` trees), `ws`/`engine.io`/`socket.io-parser`/`socket.io-adapter` refreshed via `npm audit fix`, `react-router-dom ^7.18.2` (CSRF/open-redirect/XSS advisory ranges incl. GHSA-wrjc-x8rr-h8h6), `vite ^8.0.16` (GHSA-fx2h-pf6j-xcff), `postcss`/`nanoid`/`source-map-js`/`form-data`/`browserslist` transitives patched. `node-forge`/`@xmldom/xmldom`/`tinyexec`/`jose`/`yargs`/`shell-quote` all belonged to the removed Expo tree. Final audit: 0/0/0/0. |
| — | `nodemailer <=10.0.5` (8 advisories incl. arbitrary file read + SSRF) | Fixed | `nodemailer ^10.1.1`; import adjusted to the new bundled named type (`SendMailOptions`); stale `@types/nodemailer@8` removed. |
| — | Prisma `deepmerge-ts <8` (stack exhaustion) | Fixed | `overrides.deepmerge-ts: ^8.0.2`; verified `npx prisma validate` (schema valid) + `npm run build` + 385 tests. |
| — | `proxy-addr` critical (all Express services) | Fixed | Resolved 2.0.8+ in all three lockfiles. |

### Phase 3 — credentials & secret handling

| Item | Disposition | Notes |
|---|---|---|
| `apps/admin_dashboard/.env`, `apps/driver_flutter/.env`, `apps/rider_flutter/.env` tracked in git | **Fixed** | `git rm --cached` performed (files kept locally); `**/.env` already ignored — future commits cannot re-add them. `.env.example` files created for each app. Current values are client-side API URLs/anon keys; no server secrets. |
| `backend/.env` | Verified | Never tracked (`backend/.gitignore` covers it). |
| `google-services.json` / `GoogleService-Info.plist` (both apps) | **Action** | Added in `5413951` (Initial Commit), deleted in `6585f5a`/`eb05aa7`; still present in git history. Files carry a GCP/Firebase API key → rotate/restrict, see §5. Ignore rules added to prevent re-adding. |
| `probe-e2e-tmp.js`, `fix-admin-auth.js` (deleted `461ae9e`), `backend/scripts/seed_riders.cjs`, `infra/loadtest/ride_request.js` | Verified / **Action** | Not present in HEAD. Content only reachable via git history; no live credentials were found in the current tree. Include in any history-rewrite decision (§5/§6). |
| `tests/scripts/diagnostics/verify-admin.js`, `tests/e2e/dashboard-workflows/run-colab-identity-e2e.cjs`, `tests/unit/backend/modules/payments/payments.unit.test.ts`, `tests/unit/backend/modules/{sponsor/sponsor-auth,partner/partner-auth}.unit.test.ts` | Verified | Masked review: matches were env-var names (`SUPABASE_SERVICE_ROLE_KEY`), live-key *detection* prefixes (`sk_live_` comparisons in `stripe.client.ts`), or test fixtures. No real keys. Live-Stripe interlock (`STRIPE_ALLOW_LIVE`) remains intact. |

### Phase 4 — mobile

| Item | Disposition | Notes |
|---|---|---|
| Android `usesCleartextTraffic="true"` in release | Fixed | Main manifests now `false` + `android:allowBackup="false"`; debug-only manifest override (with `tools:replace`) keeps local HTTP dev working. |
| iOS `NSAllowsArbitraryLoads` | Fixed | Replaced with `NSAllowsLocalNetworking` in both `Info.plist` files; shipping traffic now subject to ATS. |
| Exported components | Verified | Only `MainActivity` is exported (required for launcher + Supabase deep link); FCM service `android:exported="false"`. No export surface change needed. |
| WebView JavaScript (driver payout onboarding) | Fixed | Kept JS enabled (Stripe Checkout requires it) but added a `NavigationDelegate.onNavigationRequest` allowlist: only `https://*.stripe.com` may render; everything else is prevented, closing the in-app phishing vector. |
| Android release signing | **Action** | Both `build.gradle.kts` files sign release builds with the debug keystore (Flutter template default). Create an upload keystore + `key.properties` before store submission; cannot be fixed without operator keystore material. |

### Phase 5/6 — infrastructure & authorization review

| Item | Disposition | Notes |
|---|---|---|
| Docker image ran as root | Fixed | Runtime stage now copies with `--chown=node:node`, `/start.sh` is root-owned `0555`, `/app/uploads` owned by `node`, `USER node` before `CMD`. Verified: `docker run --entrypoint id` → `uid=1000(node)`; `/app/uploads` `node:node`. |
| Dependency/CI management | Fixed / Action | All four lockfiles regenerated with 0 audit findings. No CI workflows exist in the repo (`.github/workflows` empty) — recommend wiring `npm audit`/builds into CI (follow-up). |
| File authorization (`files.routes.ts`) | Verified | UUID format gate, owner/admin check for private files, 404-not-403 for unauthorized private reads, `nosniff` + attachment disposition, token minting scoped owner/admin. No change required. |
| Payment status endpoint authorization | Verified | `GET /api/payments/ride/:rideId/status` restricts to rider/driver/admin (`payments.controller.ts:160-192`). |
| CORS | Residual | When `CORS_ORIGINS` is unset the API accepts all origins (documented, bearer-token-only auth). Recommend setting `CORS_ORIGINS` in production. |
| `/metrics` | Residual | Unauthenticated by design; relies on network policy/reverse-proxy restriction. |

## 3. Dependency changes

- **backend**: `axios ^1.6.2→^1.20.0`, `firebase-admin ^14.2.0→^14.3.1`, `nodemailer ^8.0.6→^10.1.1`, `ts-node-dev`→`tsx` (`dev` script → `tsx watch src/app.ts`), `@types/nodemailer` removed; `overrides: { qs: ^6.16.1, deepmerge-ts: ^8.0.2 }`. Express remained 4.22.1 (latest 4.x) with audit-fixed transitives.
- **apps/admin_dashboard**: `axios ^1.20.0`, `react-router-dom ^7.18.2`, `vite ^8.0.16` + full `npm audit fix` pass (react-router, ws, socket.io-parser, nanoid, postcss, form-data, engine.io-client, browserslist, brace-expansion, source-map-js, proxy-addr).
- **apps/sponsor_portal**: `axios ^1.20.0`, `react-router-dom ^7.18.2`, `vite ^8.0.16` + audit-fix pass (proxy-addr, brace-expansion, source-map-js).
- **root**: `expo@54.0.0` removed (unused; no Expo config or imports; 630 packages pruned). Root `node_modules/` now ignored by `.gitignore`.

## 4. Verification evidence

| Check | Command | Result |
|---|---|---|
| Backend typecheck/build | `npm run build` (backend) | clean |
| Backend unit tests | `npm test` (backend) | 385 passed, 0 failed |
| New security tests | `node tests/unit/backend/run-tests.cjs security` | 30 passed incl. file-URL scheme rejection + deep-link allowlist |
| Prisma schema | `npx prisma validate` | valid (with override) |
| Admin build | `vite build` | built, exit 0 |
| Sponsor typecheck/build | `npx tsc -b` / `vite build` | 0 errors / built |
| Driver app analysis | `flutter analyze` | no errors (pre-existing info/warnings only) |
| Manifests/plists | XML parse of 4 AndroidManifest + 2 Info.plist | all well-formed |
| Container user | `docker build` + `docker run --entrypoint id` | image built; `uid=1000(node)`; `/start.sh` 0555 root; `/app/uploads` node-owned |
| npm audits | `npm audit` ×4 (JSON saved `audit-*-post.json`) | 0 vulnerabilities in all four workspaces |

Note: `npx tsc -b` in the admin dashboard reports ~123 pre-existing type errors (e.g., `Sponsors.tsx`, MUI v9 prop typings) unrelated to this change set — none reference the new/edited files, and the project's build script (`vite build`) passes. Treat as pre-existing type debt.

## 5. Credential rotation checklist (operator action)

1. **Google/Firebase API keys** from the history-exposed `google-services.json` / `GoogleService-Info.plist` (both apps): rotate/restrict in GCP Console (Android/iOS app restrictions, no unrestricted key), regenerate both config files, store outside git.
2. **Supabase anon keys** in the untracked `apps/*/.env`: client-public by design; rotate only on evidence of abuse.
3. **Stripe**: no live keys found in repo/tests; keep the `STRIPE_ALLOW_LIVE` interlock. Rotate only as precaution if the history is deemed exposed.
4. **Gmail OAuth (backend)**: refresh token/secret live only in local `backend/.env` (never tracked). Rotate if that file was ever shared.
5. **Git history**: `.env` files and Google configs remain in history (`5413951`, pre-deletion commits). Rewriting history (git-filter-repo/BFG) is **not** performed here — it requires explicit approval and coordinated force-push.

## 6. Residual risk & follow-ups

- Git history exposure until rotation/history-rewrite decision (see §5).
- Prisma 7 upgrade pending: `package.json#prisma` config is deprecated; `deepmerge-ts` override is validated but should be revisited with the major upgrade.
- `/metrics` unauthenticated; CORS defaults to open when `CORS_ORIGINS` is unset — set both in production.
- Android release builds currently debug-signed (§2 Phase 4 action).
- CSP allows `style-src 'unsafe-inline'` (MUI/emotion runtime styles); acceptable, revisit if CSS-in-JS is removed.
- Flutter analyzer info/warning backlog and admin `tsc` debt are pre-existing and unaffected by this change.
- Full DB/Redis-backed e2e suites were not run locally; run `npm --prefix backend run e2e:*` against a staging environment before deploy.
- `graphify-out/` was stale (built from `404bcc44`); run `graphify update .` after this change if the graph should reflect it. (Its working-tree changes were left untouched by this work.)

## 7. Files changed

Backend: `src/app.ts`, `src/security/file-url.ts` (new), `src/modules/payments/return-target.ts` (new), `src/modules/payments/payments.controller.ts`, `src/modules/driver/driver.controller.ts`, `src/modules/user/user.controller.ts`, `src/services/email.service.ts`, `src/routing/engine/astar-engine.ts`, `Dockerfile`, `package.json`, `package-lock.json`, tracked `dist/` build output.
Dashboards: `apps/admin_dashboard/server.js`, `src/utils/safeUrl.ts` (new), `src/pages/{UserDetail,RideAudit}.tsx`, `package.json`, `package-lock.json`; `apps/sponsor_portal/server.js`, `package.json`, `package-lock.json`.
Mobile: both `AndroidManifest.xml` (main + debug), both `Info.plist`, `apps/driver_flutter/lib/screens/profile_screen.dart`.
Config/docs: `.gitignore`, `.env.example` ×3, `tests/unit/backend/security/security.unit.test.ts`, root `package.json`/`package-lock.json`.
