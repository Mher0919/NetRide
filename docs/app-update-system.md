# NetRide App Update System

## Overview

The app update system is database-driven and shared by the Rider and Driver
applications. `app_release_configs` is the single source of truth for the
latest version, minimum supported version, build numbers, store URL, and whether
enforcement is active. There is no admin dashboard control and no custom update
popup.

## Database

`backend/migrations/20261020_app_release_configs.sql` creates the table:

| Column | Meaning |
| --- | --- |
| `app` | `rider` or `driver` |
| `platform` | `android` or `ios` |
| `latest_version` | Informational latest version |
| `minimum_version` | Required version. Installed versions below it must update |
| `latest_build` | Optional latest build number |
| `minimum_build` | Optional required build number |
| `store_url` | Canonical HTTPS store listing |
| `is_active` | `false` disables update enforcement for the row |
| `updated_at` | Last manual database update |

Change version policy directly in the database:

```sql
UPDATE app_release_configs
   SET minimum_version = '2.0.0',
       latest_version  = '2.1.0',
       minimum_build   = 20,
       latest_build    = 21,
       is_active       = TRUE,
       updated_at      = NOW()
 WHERE app = 'rider' AND platform = 'android';
```

The backend caches published configuration for up to 30 seconds (Redis) and
15 seconds (in-process fallback), so changes apply shortly after the SQL
statement without a deploy.

The campaign/draft columns added by `20261021_app_update_campaigns.sql` are
legacy and are no longer read or written by the application.

## Mobile behavior

On launch, resume, and whenever the server returns `426 APP_UPDATE_REQUIRED`,
the Flutter gate in `app_update_gate.dart` fetches `GET /api/app/version`.

When `installed_version < minimum_version`:

- **Android**: Play Core immediate in-app update is started automatically. If
  an immediate update is not available, the Play Store listing is opened.
- **iOS**: the App Store listing is opened.
- No custom card, dialog, or popup is shown. The store is the only update UI.
- The redirect happens once per app session. If the store cannot be opened the
  gate retries on the next enforcement signal or launch.

Users at or above the minimum are never interrupted. Optional update prompts
have been removed.

The version request is bounded to 6 seconds. If the configuration request
fails, the app uses a previously cached policy for up to 24 hours. If no cached
policy exists, the app fails open so a network outage does not lock users out.
A cached mandatory policy continues to enforce the update while offline.

## Server enforcement

`appVersion.middleware.ts` inspects these mobile headers:

- `X-App-Id`
- `X-App-Platform`
- `X-App-Version`
- `X-App-Build`

When the headers identify a known app and the database row is active with a
higher `minimum_version`, protected API operations return:

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
recover their account, discover the update, download files, and so on:

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
that supports this system.

## Security

- Policy mutations happen only through direct database access.
- Store URLs must be HTTPS and match the target platform and app package.
- The mobile client also revalidates the store URL before launching it.
- Missing or invalid configuration fails open and never fabricates a successful
  update.
