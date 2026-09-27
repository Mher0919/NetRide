import SwiftUI
import Supabase

@main
struct NetRideRiderApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @StateObject private var rideProvider = RideProvider.shared
    @StateObject private var specialsProvider = SpecialsProvider()
    @StateObject private var communication = CommunicationService()

    init() {
        EnvConfig.load()
        SoundService.shared.initSounds()
    }

    var body: some Scene {
        WindowGroup {
            RootCoordinator()
                .environmentObject(rideProvider)
                .environmentObject(specialsProvider)
                .environmentObject(communication)
                .onAppear {
                    specialsProvider.bind(rideProvider: rideProvider)
                    bootstrap()
                }
        }
    }

    private func bootstrap() {
        let storedToken = SessionStore.shared.jwtToken

        // Restore / refresh session on cold start.
        if let token = storedToken, AuthService.isJwtExpired(token) {
            Task {
                if let session = try? await SupabaseManager.shared.client.auth.refreshSession() {
                    let user = session.user
                    let email = user.email
                    let meta = user.userMetadata
                    let fullName = (meta["full_name"]?.stringValue)
                        ?? (meta["name"]?.stringValue)
                        ?? "NetRide Rider"
                    let avatar = (meta["avatar_url"]?.stringValue) ?? (meta["picture"]?.stringValue)
                    let accessToken = session.accessToken
                    if let res = try? await AuthService.loginWithOAuth(
                        email: email ?? "", fullName: fullName, profileImageUrl: avatar, role: "RIDER", token: accessToken
                       ) {
                        _ = res
                        AuthService.isAuthenticated = true
                        rideProvider.initSocket(token: SessionStore.shared.jwtToken ?? "")
                        NotificationService.shared.registerDevice()
                        resolveStartup(forcePostAuth: true)
                    } else {
                        await AuthService.logout()
                    }
                } else {
                    await AuthService.logout()
                }
            }
        } else if storedToken == nil, SupabaseManager.shared.hasSession {
            Task {
                _ = await AuthService.syncWithBackend()
                if let t = SessionStore.shared.jwtToken {
                    rideProvider.initSocket(token: t)
                    NotificationService.shared.registerDevice()
                }
                resolveStartup(forcePostAuth: true)
            }
        } else if let token = storedToken {
            AuthService.isAuthenticated = true
            rideProvider.initSocket(token: token)
            NotificationService.shared.registerDevice()
            resolveStartup(forcePostAuth: false)
        } else {
            AppRouter.shared.initialTargetRoute = .login
        }
    }

    /// Determine startup destination from authoritative backend state.
    private func resolveStartup(forcePostAuth: Bool) {
        Task {
            do {
                let profile = try await UserService.getProfile()
                if (profile["verification_status"] as? String) == "BLOCKED" {
                    AppRouter.shared.initialIsBlocked = true
                    AppRouter.shared.initialBlockedReason = profile["blocked_reason"] as? String
                    AppRouter.shared.initialTargetRoute = .blocked
                } else {
                    AppRouter.shared.initialTargetRoute = forcePostAuth ? .postAuth : .postAuth
                }
            } catch {
                // Backend unreachable but valid JWT — trust existing session.
                AppRouter.shared.initialTargetRoute = .main
            }
        }
    }
}