import SwiftUI

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
                    Text("Create your account")
                        .font(.system(size: 24, weight: .semibold))
                        .foregroundColor(AppTheme.secondaryDarkText)

                    AppTextField(placeholder: "Full Name", text: $fullName, textContentType: .name)
                    AppTextField(placeholder: "Email", text: $email, keyboard: .emailAddress, textContentType: .emailAddress)
                    AppTextField(placeholder: "Password", text: $password, isSecure: true, textContentType: .newPassword)
                    passwordCheckpoints
                    AppTextField(placeholder: "Confirm Password", text: $confirm, isSecure: true)

                    if let errorMessage {
                        Text(errorMessage)
                            .font(.system(size: 13))
                            .foregroundColor(AppTheme.errorColor)
                    }

                    AppButton(title: "Create Account", isEnabled: isValid && !isLoading) {
                        signup()
                    }
                    AppButton(title: "Back", style: .outlined) {
                        AppRouter.shared.pop()
                    }
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
                let result = try await AuthService.signupWithPassword(email: email, fullName: fullName, password: password, role: "RIDER")
                switch result {
                case .success:
                    NotificationService.shared.registerDevice()
                    RideProvider.shared.initSocket(token: SessionStore.shared.jwtToken ?? "")
                    AppRouter.shared.replaceWith(.postAuth)
                case .otpRequired:
                    AppRouter.shared.replaceWith(.verification(email: email, fullName: fullName, role: "RIDER"))
                }
            } catch {
                errorMessage = ErrorHandler.message(for: error)
            }
            isLoading = false
        }
    }
}