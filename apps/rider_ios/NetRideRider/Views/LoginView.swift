import SwiftUI
import Supabase
import AuthenticationServices

struct LoginView: View {
    @State private var showEmailForm = false
    @State private var email = ""
    @State private var password = ""
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var appName = "NetRide"
    @State private var oauthTimeout = false
    @State private var showReset = false

    var body: some View {
        ZStack {
            AppTheme.primaryBackground.ignoresSafeArea()
            ScrollView {
                VStack(spacing: 24) {
                    Spacer().frame(height: 40)
                    Image(systemName: "car.fill")
                        .resizable()
                        .scaledToFit()
                        .frame(width: 90, height: 90)
                        .foregroundColor(AppTheme.primaryBrandGreen)

                    Text("Welcome to \(appName)")
                        .font(.system(size: 26, weight: .semibold))
                        .foregroundColor(AppTheme.secondaryDarkText)

                    if !showEmailForm {
                        VStack(spacing: 12) {
                            AppButton(title: "Continue with Google", icon: "g.circle.fill", style: .outlined) {
                                oauth(google: true)
                            }
                            AppButton(title: "Continue with Apple", icon: "apple.logo", style: .outlined) {
                                oauth(google: false)
                            }
                            AppButton(title: "Continue with Email", icon: "envelope.fill") {
                                withAnimation { showEmailForm = true }
                            }
                        }
                    } else {
                        VStack(spacing: 14) {
                            AppTextField(placeholder: "Email", text: $email, keyboard: .emailAddress, textContentType: .emailAddress)
                            AppTextField(placeholder: "Password", text: $password, isSecure: true, textContentType: .password)
                            AppButton(title: "Sign In", isEnabled: !isLoading) {
                                login()
                            }
                            Button("Forgot password?") {
                                showReset = true
                            }
                            .font(.system(size: 14, weight: .medium))
                            .foregroundColor(AppTheme.primaryBrandGreen)
                        }
                    }

                    if let errorMessage {
                        Text(errorMessage)
                            .font(.system(size: 13))
                            .foregroundColor(AppTheme.errorColor)
                            .multilineTextAlignment(.center)
                    }

                    HStack(spacing: 6) {
                        Text("New to NetRide?")
                        Button("Sign Up") {
                            AppRouter.shared.push(.signup)
                        }
                        .fontWeight(.semibold)
                        .foregroundColor(AppTheme.primaryBrandGreen)
                    }
                    .font(.system(size: 15))
                    .foregroundColor(AppTheme.secondaryDarkText)
                }
                .padding(.horizontal, 28)
            }
        }
        .onAppear { loadAppName() }
        .sheet(isPresented: $showReset) { ResetPasswordView(token: nil) }
    }

    private func loadAppName() {
        Task {
            appName = await AuthService.getAppName()
        }
    }

    private func login() {
        isLoading = true
        errorMessage = nil
        Task {
            do {
                let result = try await AuthService.loginWithPassword(email: email, password: password, role: "RIDER")
                switch result {
                case .success:
                    NotificationService.shared.registerDevice()
                    RideProvider.shared.initSocket(token: SessionStore.shared.jwtToken ?? "")
                    await routeAfterAuth()
                case .otpRequired(let email):
                    AppRouter.shared.replaceWith(.verification(email: email, fullName: nil, role: "RIDER"))
                }
            } catch {
                errorMessage = ErrorHandler.message(for: error)
            }
            isLoading = false
        }
    }

    private func oauth(google: Bool) {
        isLoading = true
        errorMessage = nil
        Task {
            do {
                let redirectTo = URL(string: "io.supabase.netride://login-callback/")!
                let auth = SupabaseManager.shared.client.auth
                if google {
                    _ = try await auth.signInWithOAuth(provider: .google, redirectTo: redirectTo)
                } else {
                    _ = try await auth.signInWithOAuth(provider: .apple, redirectTo: redirectTo)
                }
                // Wait for the auth state to settle, then sync with backend.
                try await Task.sleep(nanoseconds: 1_000_000_000)
                await finishOAuth()
            } catch {
                errorMessage = "Sign-in was cancelled or could not be completed."
            }
            isLoading = false
        }
    }

    private func finishOAuth() async {
        guard let user = SupabaseManager.shared.client.auth.currentUser else { return }
        let meta = user.userMetadata
        let fullName = (meta["full_name"] as? String) ?? (meta["name"] as? String) ?? "NetRide Rider"
        let avatar = (meta["avatar_url"] as? String) ?? (meta["picture"] as? String)
        guard let session = SupabaseManager.shared.client.auth.currentSession,
              let accessToken = session.accessToken else { return }
        do {
            _ = try await AuthService.loginWithOAuth(
                email: user.email ?? "",
                fullName: fullName,
                profileImageUrl: avatar,
                role: "RIDER",
                token: accessToken
            )
            AuthService.isAuthenticated = true
            NotificationService.shared.registerDevice()
            RideProvider.shared.initSocket(token: SessionStore.shared.jwtToken ?? "")
            await routeAfterAuth()
        } catch {
            errorMessage = ErrorHandler.message(for: error)
        }
    }

    private func routeAfterAuth() async {
        do {
            let profile = try await UserService.getProfile()
            if (profile["verification_status"] as? String) == "BLOCKED" {
                AppRouter.shared.initialBlockedReason = profile["blocked_reason"] as? String
                AppRouter.shared.initialTargetRoute = .blocked
            } else {
                AppRouter.shared.initialTargetRoute = .postAuth
            }
        } catch {
            AppRouter.shared.initialTargetRoute = .postAuth
        }
        AppRouter.shared.path = [.splash]
    }
}