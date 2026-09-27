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
        let storedToken = SessionStore.shared.jwtToken

        if let token = storedToken, AuthService.isJwtExpired(token) {
            Task {
                if let session = try? await SupabaseManager.shared.client.auth.refreshSession() {
                    let user = session.user
                    let email = user.email
                    let meta = user.userMetadata
                    let fullName = (meta["full_name"]?.stringValue)
                        ?? (meta["name"]?.stringValue)
                        ?? "NetRide Driver"
                    let avatar = (meta["avatar_url"]?.stringValue) ?? (meta["picture"]?.stringValue)
                    let accessToken = session.accessToken
                    if let res = try? await AuthService.loginWithOAuth(
                        email: email ?? "",
                        fullName: fullName,
                        profileImageUrl: avatar,
                        role: "DRIVER",
                        token: accessToken
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
        } else if storedToken == nil, SupabaseManager.shared.hasSession {
            Task {
                _ = await AuthService.syncWithBackend()
                if let t = SessionStore.shared.jwtToken {
                    driverProvider.initSocket(token: t)
                    NotificationService.shared.registerDevice()
                }
                await resolveStartup()
            }
        } else if let token = storedToken {
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