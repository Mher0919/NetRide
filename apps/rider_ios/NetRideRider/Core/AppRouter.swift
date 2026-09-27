import SwiftUI

/// Global navigation state (mirrors ApiService.navigatorKey + route table in main.dart).
@MainActor
final class AppRouter: ObservableObject {
    static let shared = AppRouter()

    /// Current stack destination. Routes mirror the Flutter route names.
    enum Route: Hashable {
        case splash
        case blocked
        case login
        case signup
        case verification(email: String, fullName: String?, role: String)
        case onboarding
        case postAuth
        case referralOnboarding
        case main
        case trip
        case credits
        case profile
        case resetPassword(token: String)
        case specialDetail(id: String)
        case specialRedemption(code: String?, redemptionId: String?)
        case map
    }

    @Published var path: [Route] = []
    @Published var initialTargetRoute: Route = .login
    @Published var initialIsBlocked = false
    @Published var initialBlockedReason: String?

    private init() {}

    func push(_ route: Route) {
        path.append(route)
    }

    func popToRoot() {
        path.removeAll()
    }

    func replaceWith(_ route: Route) {
        path.removeAll()
        path.append(route)
    }

    func pop() {
        if !path.isEmpty { path.removeLast() }
    }
}

/// Root coordinator (mirrors the Flutter onGenerateRoute switch).
struct RootCoordinator: View {
    @ObservedObject private var router = AppRouter.shared
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        NavigationStack(path: $router.path) {
            Group {
                switch router.initialTargetRoute {
                case .blocked:
                    BlockedAccountView(reason: router.initialBlockedReason)
                case .postAuth:
                    PostAuthGateView()
                case .login:
                    LoginView()
                case .onboarding:
                    OnboardingView()
                case .main:
                    MainTabView()
                default:
                    SplashView()
                }
            }
            .navigationDestination(for: AppRouter.Route.self) { route in
                destination(route)
            }
        }
        .preferredColorScheme(.light)
        .tint(AppTheme.primaryBrandGreen)
        .onChange(of: scenePhase) { phase in
            if phase == .active {
                NotificationCenter.default.post(name: .appForegrounded, object: nil)
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .authStateChanged)) { _ in
            // After logout, return to login.
            if !AuthService.isAuthenticated {
                router.replaceWith(.login)
            }
        }
    }

    @ViewBuilder
    private func destination(_ route: AppRouter.Route) -> some View {
        switch route {
        case .splash:
            SplashView()
        case .blocked:
            BlockedAccountView(reason: router.initialBlockedReason)
        case .login:
            LoginView()
        case .signup:
            SignupView()
        case .verification(let email, let fullName, let role):
            VerificationView(email: email, fullName: fullName, role: role)
        case .onboarding:
            OnboardingView()
        case .postAuth:
            PostAuthGateView()
        case .referralOnboarding:
            ReferralOnboardingView()
        case .main:
            MainTabView()
        case .trip:
            TripView()
        case .credits:
            CreditsView()
        case .profile:
            ProfileView()
        case .resetPassword(let token):
            ResetPasswordView(token: token)
        case .specialDetail(let id):
            SpecialDetailView(sponsorId: id)
        case .specialRedemption(let code, let redemptionId):
            SpecialRedemptionView(code: code, redemptionId: redemptionId)
        case .map:
            MapScreenView()
        }
    }
}