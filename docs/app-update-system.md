# NetRide App Update System

## Overview

The app update system is database-driven and shared by the Rider and Driver
applications. The `app_release_configs` table remains the single source of
truth for the minimum supported version, latest version, store URL, and the
published update campaign.

Flow:

1. An administrator drafts campaign changes in **Admin -> App Updates**.
2. Drafts are stored in `app_release_configs.draft_config` and never affect
   mobile clients.
3. Publishing copies the validated draft into the published columns inside a
   transaction, marks the campaign `PUBLISHED`, records an audit event, and
   invalidates the policy cache.
4. The mobile apps fetch `GET /api/app/version` on launch and resume.
5. When the installed version is below the published minimum version, the
   mandatory full-screen update popup is shown and cannot be dismissed.
6. Protected API requests from known mobile clients below the minimum version
   receive `426 Upgrade Required`.

## Database

`backend/migrations/20261020_app_release_configs.sql` creates the base table.

`backend/migrations/20261021_app_update_campaigns.sql` adds:

- Popup content: campaign name, title, message, button text, supporting text,
  announcement label, accent color.
- Campaign lifecycle: `campaign_status`, `published_at`, `published_by`.
- Draft state: `draft_config`, `draft_updated_by`, `draft_updated_at`,
  `draft_revision`.

Existing rows are backfilled as published campaigns so the prior version
policy remains active. No second version-management table is created.

The update campaign schema is applied automatically on backend startup by
`runMigrations()` when `draft_config` is missing. It can also be applied with:

```powershell
npm run migrate -- 20261021_app_update_campaigns.sql
```

## Admin workflow

The **App Updates** section is available only to authenticated administrators;
the backend applies both `authMiddleware` and `adminMiddleware` to every
mutation.

1. Select the application and platform (Rider/Driver, Android/iOS).
2. Edit release targets, App Store URL, and popup content.
3. Use the live preview, including small/standard/large phone sizes.
4. Save the draft. Draft changes are not visible to users.
5. Publish from the confirmation dialog. Publishing requires an explicit
   acknowledgement and shows the title, message, minimum version, target, and
   global blocking impact.
6. Use **Deactivate campaign** to stop mandatory enforcement. This is audited.

Draft revision checks prevent two administrators from silently overwriting each
other. A stale revision receives HTTP 409 and the dashboard reloads the latest
state.

Publishing does not automatically raise the minimum version. The administrator
chooses the minimum explicitly; publishing applies exactly the saved draft.

## Eligibility

The mandatory rule is:

```text
installed_version < minimum_supported_version
```

Version comparison is numeric component-by-component, not lexicographic.
Build numbers break ties when version names are equal. Users at or above the
minimum are never blocked by the mandatory campaign, though they may still see
the separate optional update prompt when they are below `latest_version`.

The minimum version is authoritative. The latest version is informational.

## Mobile behavior

The Flutter gate in `app_update_gate.dart`:

- Checks policy on launch and on resume when stale.
- Shows a branded loading gate during the first policy fetch, bounded by a
  6-second request timeout and an 8-second hard overlay limit.
- Shows a non-dismissible full-screen popup when a mandatory update is
  required. Back navigation, barrier taps, and ordinary dismissal are blocked.
- Uses the configured title, message, button text, supporting text,
  announcement label, and approved accent color.
- Opens Google Play in-app immediate update on Android when available, then
  falls back to the database-configured Play listing. iOS opens the
  database-configured App Store listing.
- Rechecks policy after returning from the store and on resume. A cached
  mandatory policy is never treated as proof that the device updated.
- Displays clear errors when the store URL is missing or invalid. It never
  reports a fake successful update.

If the configuration request fails, the app uses a previously cached policy for
up to 24 hours. If no cached policy exists, the app fails open so a network
outage does not lock users out. A cached mandatory policy continues to enforce
the update while offline. This favors safety for known mandatory outages while
avoiding an unrecoverable offline launch.

## Server enforcement

`appVersion.middleware.ts` inspects these mobile headers:

- `X-App-Id`
- `X-App-Platform`
- `X-App-Version`
- `X-App-Build`

When the headers identify a known app and the published policy requires an
update, protected API operations return:

```json
{
  "error": "This version of NetRide is no longer supported. Please update to continue.",
  "code": "APP_UPDATE_REQUIRED",
  "minimum_version": "2.0.0",
  "latest_version": "2.1.0",
  "store_url": "https://..."
}
```

The following boundaries are intentionally exempt so users can authenticate,
recover their account, discover the update, download files, and administrators
can manage campaigns:

- `/api/auth/*`
- `/api/app/*` (including the policy endpoint)
- `/api/admin/*`
- `/api/files/*`
- `/api/portal/*`, `/api/partner/*`, `/api/sponsor/*` web portal routes
- health, metrics, and ping endpoints
- non-mobile requests without the app headers

Socket.IO handshakes also carry the app id, platform, version, and build.
Connections below the minimum version are rejected with
`APP_UPDATE_REQUIRED`, so mutating socket events cannot bypass the HTTP check.

Older clients that never send app metadata cannot be positively identified by
the server. They remain protected by the in-app gate once they install a build
that supports this system. Client metadata is used for policy enforcement but
is not treated as device attestation.

## Caching

Published policy is cached in Redis for 30 seconds and in process memory as a
fallback when Redis is unavailable. Publish and deactivate operations delete
the Redis key and clear the local cache. If Redis is unavailable during
invalidation, other instances may serve the previous policy for up to the
30-second Redis TTL or their local fallback window.

## Security

- Only admins can create drafts, publish, discard drafts, or deactivate.
- All draft fields are validated on the server.
- Popup text rejects HTML/markup and is length-limited.
- Accent colors are restricted to an approved, accessible palette.
- Store URLs must be HTTPS and must match the target platform and app package.
- The mobile client also revalidates the store URL before launching it.
- Draft and publish operations use row locks and revision checks.
- Every draft, publish, discard, and deactivation action is recorded in
  `audit_events`.
