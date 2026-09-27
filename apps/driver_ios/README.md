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

2. **Configure `.env`** (already included, matches the Flutter app):

   ```
   SUPABASE_URL=https://lpcnkfqagpouwzikedzl.supabase.co
   SUPABASE_ANON_KEY=sb_publishable_...
   GOOGLE_CLIENT_ID_IOS=your_ios_client_id
   GOOGLE_CLIENT_ID_WEB=your_web_client_id
   API_BASE_URL=https://netride.onrender.com
   ```

   The `.env` file is bundled as a resource and parsed at startup by `EnvConfig`.

3. **OAuth redirect** — the URL scheme `io.supabase.netride` is already declared
   in `Info.plist`. Add it to your Supabase project's **Redirect URLs**:
   `io.supabase.netride://login-callback/`

4. **(Optional) Push notifications** — drop `GoogleService-Info.plist` into
   `NetRideDriver/App/`. Without it the app degrades gracefully (no crash).

5. Set your Apple **Development Team** in Xcode before building to a device.

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