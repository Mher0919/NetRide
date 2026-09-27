import SwiftUI

/// Global navigation state (mirrors ApiService.navigatorKey + driver route table).
@MainActor
final class AppRouter: ObservableObject {
    static let shared = AppRouter()

    enum Route: Hashable {
        case splash
        case login
        case signup
        case verification(email: String, fullName: String?, role: String)
        case onboarding
        case success
        case main
        case trip
        case profile
        case documents
        case replaceVehicle
        case vehicleInspection
        case resetPassword(token: String)
        case availability
    }

    @Published var path: [Route] = []
    @Published var initialTargetRoute: Route = .login

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

struct RootCoordinator: View {
    @ObservedObject private var router = AppRouter.shared
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        NavigationStack(path: $router.path) {
            Group {
                switch router.initialTargetRoute {
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
        case .login:
            LoginView()
        case .signup:
            SignupView()
        case .verification(let email, let fullName, let role):
            VerificationView(email: email, fullName: fullName, role: role)
        case .onboarding:
            OnboardingView()
        case .success:
            SuccessView()
        case .main:
            MainTabView()
        case .trip:
            TripView()
        case .profile:
            DriverProfileView()
        case .documents:
            DocumentResubmissionView()
        case .replaceVehicle:
            ReplaceVehicleView()
        case .vehicleInspection:
            VehicleInspectionView()
        case .resetPassword(let token):
            ResetPasswordView(token: token)
        case .availability:
            AvailabilityView()
        }
    }
}