import SwiftUI

/// 6-digit email OTP entry (mirrors VerificationScreen).
struct VerificationView: View {
    var email: String
    var fullName: String?
    var role: String = "RIDER"
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
                        let filtered = String(newValue.filter(\.isNumber).prefix(6))
                        code = filtered
                        if filtered.count == 6 { submit() }
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
                RideProvider.shared.initSocket(token: SessionStore.shared.jwtToken ?? "")
                AppRouter.shared.replaceWith(.postAuth)
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