import SwiftUI
import Supabase

@main
struct NetRideDriverApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @StateObject private var driverProvider = DriverProvider.shared
    @StateObject private var navigation = NavigationService()
    @StateObject private var communication = CommunicationService()

    init() {
        EnvConfig.load()
        SoundService.shared.initSounds()
    }

    var body: some Scene {
        WindowGroup {
            RootCoordinator()
                .environmentObject(driverProvider)
                .environmentObject(navigation)
                .environmentObject(communication)
                .onAppear { bootstrap() }
        }
    }

    private func bootstrap() {
        let token = SessionStore.shared.jwtToken

        if let token, AuthService.isJwtExpired(token) {
            Task {
                if let session = try? await SupabaseManager.shared.client.auth.refreshSession(),
                   let email = session.user?.email {
                    let meta = session.user?.userMetadata ?? [:]
                    let fullName = (meta["full_name"] as? String) ?? (meta["name"] as? String) ?? "NetRide Driver"
                    let avatar = (meta["avatar_url"] as? String) ?? (meta["picture"] as? String)
                    if let accessToken = session.accessToken,
                       let res = try? await AuthService.loginWithOAuth(
                        email: email, fullName: fullName, profileImageUrl: avatar, role: "DRIVER", token: accessToken
                       ) {
                        _ = res
                        AuthService.isAuthenticated = true
                        driverProvider.initSocket(token: SessionStore.shared.jwtToken ?? "")
                        NotificationService.shared.registerDevice()
                        await resolveStartup()
                    } else {
                        await AuthService.logout()
                    }
                } else {
                    await AuthService.logout()
                }
            }
        } else if token == nil, SupabaseManager.shared.hasSession {
            Task {
                _ = await AuthService.syncWithBackend()
                if let t = SessionStore.shared.jwtToken {
                    driverProvider.initSocket(token: t)
                    NotificationService.shared.registerDevice()
                }
                await resolveStartup()
            }
        } else if let token {
            AuthService.isAuthenticated = true
            CacheService.shared.initCache(prefs: UserDefaults.standard)
            driverProvider.initSocket(token: token)
            NotificationService.shared.registerDevice()
            Task { await resolveStartup() }
        } else {
            AppRouter.shared.initialTargetRoute = .login
        }
    }

    private func resolveStartup() async {
        if await AuthService.isDriverOnboardingComplete() {
            AppRouter.shared.initialTargetRoute = .main
        } else {
            AppRouter.shared.initialTargetRoute = .onboarding
        }
    }
}