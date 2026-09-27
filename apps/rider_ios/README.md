# NetRide Rider — Native iOS (Swift)

Native SwiftUI port of `apps/rider_flutter`. Same app logic, same backend
(`https://netride.onrender.com`), same Socket.IO events, same Supabase auth flow.

## Requirements

- macOS with Xcode 15+ (iOS 16+ deployment target)
- [XcodeGen](https://github.com/yonaskolb/XcodeGen) — generates the `.xcodeproj`
- A Supabase project (for Google/Apple OAuth sign-in)

## Setup

1. **Generate the Xcode project:**

   ```bash
   cd apps/rider_ios
   xcodegen generate
   open NetRideRider.xcodeproj
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
   `NetRideRider/App/`. Without it the app degrades gracefully (no crash).

5. Set your Apple **Development Team** in Xcode before building to a device.

## Architecture

| Flutter file | Swift file |
|---|---|
| `main.dart` | `App/NetRideRiderApp.swift` + `App/AppDelegate.swift` |
| `services/api_service.dart` | `Core/APIClient.swift` |
| `services/auth_service.dart` | `Core/AuthService.swift` |
| `providers/ride_provider.dart` | `Providers/RideProvider.swift` |
| `providers/specials_provider.dart` | `Providers/SpecialsProvider.swift` |
| `screens/*` | `Views/*` |
| `theme/app_theme.dart` | `Theme/AppTheme.swift` |

All endpoints, Socket.IO events, storage keys, and JSON shapes match the
backend spec exactly (see `docs/`).