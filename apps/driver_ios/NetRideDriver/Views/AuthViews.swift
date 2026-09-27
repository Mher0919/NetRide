import SwiftUI
import Supabase

struct SplashView: View {
    @State private var scale: CGFloat = 0.6
    @State private var opacity: Double = 0

    var body: some View {
        ZStack {
            AppTheme.primaryBackground.ignoresSafeArea()
            VStack(spacing: 12) {
                Image(systemName: "car.fill")
                    .resizable().scaledToFit()
                    .frame(width: 120, height: 120)
                    .foregroundColor(AppTheme.primaryBrandGreen)
                Text("NetRide")
                    .font(.system(size: 34, weight: .semibold))
                    .foregroundColor(AppTheme.secondaryDarkText)
                Text("SERVICE PARTNER")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(AppTheme.primaryBrandGreen)
            }
            .scaleEffect(scale)
            .opacity(opacity)
        }
        .onAppear {
            withAnimation(.easeOut(duration: 1.5)) { scale = 1.0; opacity = 1.0 }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                AppRouter.shared.path = [AppRouter.shared.initialTargetRoute]
            }
        }
    }
}

struct LoginView: View {
    @State private var showEmailForm = false
    @State private var email = ""
    @State private var password = ""
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var showReset = false

    var body: some View {
        ZStack {
            AppTheme.primaryBackground.ignoresSafeArea()
            ScrollView {
                VStack(spacing: 24) {
                    Spacer().frame(height: 40)
                    Image(systemName: "car.fill")
                        .resizable().scaledToFit()
                        .frame(width: 90, height: 90)
                        .foregroundColor(AppTheme.primaryBrandGreen)
                    Text("NetRide Driver")
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
                            AppButton(title: "Sign In", isEnabled: !isLoading) { login() }
                            Button("Forgot password?") { showReset = true }
                                .font(.system(size: 14, weight: .medium))
                                .foregroundColor(AppTheme.primaryBrandGreen)
                        }
                    }

                    if let errorMessage {
                        Text(errorMessage).font(.system(size: 13)).foregroundColor(AppTheme.errorColor)
                            .multilineTextAlignment(.center)
                    }

                    HStack(spacing: 6) {
                        Text("New to NetRide?")
                        Button("Sign Up") { AppRouter.shared.push(.signup) }
                            .fontWeight(.semibold)
                            .foregroundColor(AppTheme.primaryBrandGreen)
                    }
                    .font(.system(size: 15))
                    .foregroundColor(AppTheme.secondaryDarkText)
                }
                .padding(.horizontal, 28)
            }
        }
        .sheet(isPresented: $showReset) { ResetPasswordView(token: nil) }
    }

    private func login() {
        isLoading = true
        errorMessage = nil
        Task {
            do {
                let result = try await AuthService.loginWithPassword(email: email, password: password, role: "DRIVER")
                switch result {
                case .success(let complete):
                    NotificationService.shared.registerDevice()
                    DriverProvider.shared.initSocket(token: SessionStore.shared.jwtToken ?? "")
                    AppRouter.shared.initialTargetRoute = complete ? .main : .onboarding
                    AppRouter.shared.path = [.splash]
                case .otpRequired(let email):
                    AppRouter.shared.replaceWith(.verification(email: email, fullName: nil, role: "DRIVER"))
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
        let fullName = (meta["full_name"] as? String) ?? (meta["name"] as? String) ?? "NetRide Driver"
        let avatar = (meta["avatar_url"] as? String) ?? (meta["picture"] as? String)
        guard let session = SupabaseManager.shared.client.auth.currentSession,
              let accessToken = session.accessToken else { return }
        do {
            let res = try await AuthService.loginWithOAuth(
                email: user.email ?? "",
                fullName: fullName,
                profileImageUrl: avatar,
                role: "DRIVER",
                token: accessToken
            )
            AuthService.isAuthenticated = true
            NotificationService.shared.registerDevice()
            DriverProvider.shared.initSocket(token: SessionStore.shared.jwtToken ?? "")
            let onboarding = res["onboarding"] as? [String: Any] ?? [:]
            let driver = onboarding["driver"] as? [String: Any] ?? [:]
            let complete = driver["onboarding_complete"] as? Bool ?? false
            AppRouter.shared.initialTargetRoute = complete ? .main : .onboarding
            AppRouter.shared.path = [.splash]
        } catch {
            errorMessage = ErrorHandler.message(for: error)
        }
    }
}

struct SignupView: View {
    @State private var fullName = ""
    @State private var email = ""
    @State private var password = ""
    @State private var confirm = ""
    @State private var isLoading = false
    @State private var errorMessage: String?

    var body: some View {
        ZStack {
            AppTheme.primaryBackground.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Text("Become a Service Partner")
                        .font(.system(size: 24, weight: .semibold))
                        .foregroundColor(AppTheme.secondaryDarkText)
                    AppTextField(placeholder: "Full Name", text: $fullName, textContentType: .name)
                    AppTextField(placeholder: "Email", text: $email, keyboard: .emailAddress, textContentType: .emailAddress)
                    AppTextField(placeholder: "Password", text: $password, isSecure: true, textContentType: .newPassword)
                    passwordCheckpoints
                    AppTextField(placeholder: "Confirm Password", text: $confirm, isSecure: true)
                    if let errorMessage {
                        Text(errorMessage).font(.system(size: 13)).foregroundColor(AppTheme.errorColor)
                    }
                    AppButton(title: "Create Account", isEnabled: isValid && !isLoading) { signup() }
                    AppButton(title: "Back", style: .outlined) { AppRouter.shared.pop() }
                }
                .padding(28)
            }
        }
    }

    private var passwordCheckpoints: some View {
        VStack(alignment: .leading, spacing: 4) {
            checkpoint("At least 8 characters", password.count >= 8)
            checkpoint("At least 1 capital letter", password.contains(where: \.isUppercase))
            checkpoint("At least 1 number", password.contains(where: \.isNumber))
            checkpoint("At least 1 special character", password.contains { "!@#$%^&*(),.?\":{}|<>-_+=~`[]\\;'".contains($0) })
        }
        .font(.system(size: 13))
        .foregroundColor(AppTheme.secondaryDarkText)
    }

    private func checkpoint(_ text: String, _ passed: Bool) -> some View {
        HStack(spacing: 6) {
            Image(systemName: passed ? "checkmark.circle.fill" : "circle")
                .foregroundColor(passed ? AppTheme.successGreen : AppTheme.softBorderColor)
            Text(text)
        }
    }

    private var isValid: Bool {
        fullName.count >= 2 && email.contains("@") && password.count >= 8
            && password.contains(where: \.isUppercase)
            && password.contains(where: \.isNumber)
            && password == confirm
    }

    private func signup() {
        isLoading = true
        errorMessage = nil
        Task {
            do {
                let result = try await AuthService.signupWithPassword(email: email, fullName: fullName, password: password, role: "DRIVER")
                switch result {
                case .success:
                    NotificationService.shared.registerDevice()
                    DriverProvider.shared.initSocket(token: SessionStore.shared.jwtToken ?? "")
                    AppRouter.shared.initialTargetRoute = .onboarding
                    AppRouter.shared.path = [.splash]
                case .otpRequired:
                    AppRouter.shared.replaceWith(.verification(email: email, fullName: fullName, role: "DRIVER"))
                }
            } catch {
                errorMessage = ErrorHandler.message(for: error)
            }
            isLoading = false
        }
    }
}

struct VerificationView: View {
    var email: String
    var fullName: String?
    var role: String = "DRIVER"
    @State private var code = ""
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var resendDisabled = false

    var body: some View {
        ZStack {
            AppTheme.primaryBackground.ignoresSafeArea()
            VStack(spacing: 20) {
                Text("Verify your email")
                    .font(.system(size: 24, weight: .semibold))
                    .foregroundColor(AppTheme.secondaryDarkText)
                Text("We sent a 6-digit code to \(email)")
                    .font(.system(size: 14))
                    .foregroundColor(AppTheme.secondaryDarkText)
                TextField("", text: $code)
                    .keyboardType(.numberPad)
                    .font(.system(size: 32, weight: .bold, design: .monospaced))
                    .multilineTextAlignment(.center)
                    .onChange(of: code) { newValue in
                        code = String(newValue.filter(\.isNumber).prefix(6))
                        if code.count == 6 { submit() }
                    }
                    .frame(width: 220)
                    .padding()
                    .background(Color.white)
                    .cornerRadius(12)
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(AppTheme.softBorderColor))
                if let errorMessage {
                    Text(errorMessage).font(.system(size: 13)).foregroundColor(AppTheme.errorColor)
                }
                AppButton(title: "Verify", isEnabled: code.count == 6 && !isLoading) { submit() }
                Button(resendDisabled ? "Resend in a moment…" : "Resend code") {
                    resend()
                }
                .disabled(resendDisabled)
                .font(.system(size: 14, weight: .medium))
                .foregroundColor(resendDisabled ? AppTheme.softBorderColor : AppTheme.primaryBrandGreen)
            }
            .padding(28)
        }
    }

    private func submit() {
        isLoading = true
        errorMessage = nil
        Task {
            do {
                _ = try await AuthService.verifyOTP(email: email, code: code, fullName: fullName, role: role)
                NotificationService.shared.registerDevice()
                DriverProvider.shared.initSocket(token: SessionStore.shared.jwtToken ?? "")
                if await AuthService.isDriverOnboardingComplete() {
                    AppRouter.shared.initialTargetRoute = .main
                } else {
                    AppRouter.shared.initialTargetRoute = .onboarding
                }
                AppRouter.shared.path = [.splash]
            } catch {
                errorMessage = ErrorHandler.message(for: error)
            }
            isLoading = false
        }
    }

    private func resend() {
        resendDisabled = true
        Task {
            try? await AuthService.requestOTP(email: email)
            try? await Task.sleep(nanoseconds: 30_000_000_000)
            resendDisabled = false
        }
    }
}

struct ResetPasswordView: View {
    var token: String?
    @State private var tokenInput = ""
    @State private var newPassword = ""
    @State private var confirm = ""
    @State private var message: String?
    @State private var errorMessage: String?

    var body: some View {
        ZStack {
            AppTheme.primaryBackground.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("Reset Password")
                        .font(.system(size: 24, weight: .semibold))
                        .foregroundColor(AppTheme.secondaryDarkText)
                    if token == nil {
                        AppTextField(placeholder: "Reset token", text: $tokenInput)
                    }
                    AppTextField(placeholder: "New password", text: $newPassword, isSecure: true)
                    AppTextField(placeholder: "Confirm new password", text: $confirm, isSecure: true)
                    if let message {
                        Text(message).font(.system(size: 13)).foregroundColor(AppTheme.successGreen)
                    }
                    if let errorMessage {
                        Text(errorMessage).font(.system(size: 13)).foregroundColor(AppTheme.errorColor)
                    }
                    AppButton(title: "Reset Password", isEnabled: newPassword.count >= 6 && newPassword == confirm) {
                        submit()
                    }
                }
                .padding(28)
            }
        }
        .onAppear { tokenInput = token ?? "" }
    }

    private func submit() {
        let effectiveToken = token ?? tokenInput
        guard !effectiveToken.isEmpty else {
            errorMessage = "Please enter your reset token."
            return
        }
        errorMessage = nil
        message = nil
        Task {
            do {
                try await AuthService.resetPassword(token: effectiveToken, newPassword: newPassword)
                message = "Password reset successfully! Please sign in."
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                    AppRouter.shared.replaceWith(.login)
                }
            } catch {
                errorMessage = ErrorHandler.message(for: error)
            }
        }
    }
}