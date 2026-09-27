# NetRide Driver — Native iOS (Swift)

Native SwiftUI port of `apps/driver_flutter`. Same app logic, same backend
(`https://netride.onrender.com`), same Socket.IO events, same Supabase auth flow.

## Requirements

- macOS with Xcode 15+ (iOS 16+ deployment target)
- [XcodeGen](https://github.com/yonaskolb/XcodeGen) — generates the `.xcodeproj`
- A Supabase project (for Google/Apple OAuth sign-in)

## Setup

1. **Generate the Xcode project:**

   ```bash
   cd apps/driver_ios
   xcodegen generate
   open NetRideDriver.xcodeproj
   ```

2. **Configure `env`** (included, matches the Flutter app — note: no leading dot):

   ```
   SUPABASE_URL=https://lpcnkfqagpouwzikedzl.supabase.co
   SUPABASE_ANON_KEY=sb_publishable_...
   GOOGLE_CLIENT_ID_IOS=your_ios_client_id
   GOOGLE_CLIENT_ID_WEB=your_web_client_id
   API_BASE_URL=https://netride.onrender.com
   ```

   The file is deliberately named `env` (no dot): OneDrive renames dotfiles
   (`.env` → `env`) on macOS sync, and Xcode's "Copy Bundle Resources" phase
   silently skips hidden files. `EnvConfig` searches for `env`, `NetRide.env`,
   `netride.env`, then `.env`. If the file is missing entirely it falls back to
   the values baked into `Info.plist` (already present), so the app always boots.

3. **OAuth redirect** — the URL scheme `io.supabase.netride` is already declared
   in `Info.plist`. Add it to your Supabase project's **Redirect URLs**:
   `io.supabase.netride://login-callback/`

4. **(Optional) Push notifications** — drop `GoogleService-Info.plist` into
   `NetRideDriver/App/`. Without it the app degrades gracefully (no crash).

5. Set your Apple **Development Team** in Xcode before building to a device:
   open `NetRideDriver.xcodeproj` → select the `NetRideDriver` target →
   **Signing & Capabilities** → choose your team. If Xcode shows
   *"Update to recommended settings"*, accepting it is safe.

## Signing

`CODE_SIGN_STYLE` is `Automatic` and the bundle id is `com.netride.driver`.
The only required step on your Mac is selecting your **Development Team** in
the target's Signing & Capabilities pane (the "requires a development team"
error disappears once you do). For on-device push notifications you'll also
need the `aps-environment` capability (already declared in
`NetRideDriver.entitlements`) and a signing team with push enabled.

## Architecture

| Flutter file | Swift file |
|---|---|
| `main.dart` | `App/NetRideDriverApp.swift` + `App/AppDelegate.swift` |
| `services/api_service.dart` | `Core/APIClient.swift` |
| `services/auth_service.dart` | `Core/AuthService.swift` |
| `providers/driver_provider.dart` | `Providers/DriverProvider.swift` |
| `services/navigation_service.dart` | `Services/NavigationService.swift` |
| `services/routing_service.dart` | `Services/RoutingService.swift` |
| `screens/*` | `Views/*` |
| `cache/*` | `Cache/*` |
| `theme/app_theme.dart` | `Theme/AppTheme.swift` |

All endpoints, Socket.IO events, storage keys, and JSON shapes match the
backend spec exactly (see `docs/`).

## Note on the map

The driver app uses MapKit with the same ArcGIS World Light Gray tile source as
the Flutter app, so no Google Maps API key is required. Demand heatmap circles
are rendered as map overlays from `GET /api/heatmap`.