import SwiftUI

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
        .onAppear {
            tokenInput = token ?? ""
        }
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