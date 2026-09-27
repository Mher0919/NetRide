import SwiftUI

/// Mandatory US phone verification (mirrors OnboardingScreen in the rider app).
struct OnboardingView: View {
    @State private var phone = ""
    @State private var code = ""
    @State private var step: Step = .phone
    @State private var isLoading = false
    @State private var errorMessage: String?

    enum Step { case phone, code }

    var body: some View {
        ZStack {
            AppTheme.primaryBackground.ignoresSafeArea()
            VStack(spacing: 20) {
                Text("Verify your phone")
                    .font(.system(size: 24, weight: .semibold))
                    .foregroundColor(AppTheme.secondaryDarkText)

                switch step {
                case .phone:
                    Text("NetRide operates in California. Enter your US phone number.")
                        .font(.system(size: 14))
                        .foregroundColor(AppTheme.secondaryDarkText)
                        .multilineTextAlignment(.center)
                    AppTextField(placeholder: "(555) 555-5555", text: $phone, keyboard: .phonePad, textContentType: .telephoneNumber)
                    AppButton(title: "Send Code", isEnabled: PhoneUtils.normalizeUS(phone) != nil && !isLoading) {
                        requestCode()
                    }
                case .code:
                    Text("Enter the 6-digit code sent to \(PhoneUtils.format(phone))")
                        .font(.system(size: 14))
                        .foregroundColor(AppTheme.secondaryDarkText)
                        .multilineTextAlignment(.center)
                    TextField("", text: $code)
                        .keyboardType(.numberPad)
                        .font(.system(size: 32, weight: .bold, design: .monospaced))
                        .multilineTextAlignment(.center)
                        .onChange(of: code) { newValue in
                            code = String(newValue.filter(\.isNumber).prefix(6))
                            if code.count == 6 { verifyCode() }
                        }
                        .frame(width: 220)
                        .padding()
                        .background(Color.white)
                        .cornerRadius(12)
                        .overlay(RoundedRectangle(cornerRadius: 12).stroke(AppTheme.softBorderColor))
                }

                if let errorMessage {
                    Text(errorMessage).font(.system(size: 13)).foregroundColor(AppTheme.errorColor)
                }
            }
            .padding(28)
        }
    }

    private func requestCode() {
        guard let normalized = PhoneUtils.normalizeUS(phone) else { return }
        isLoading = true
        errorMessage = nil
        Task {
            do {
                let autoVerified = try await AuthService.requestPhoneOTP(phone: normalized, role: "RIDER")
                if autoVerified {
                    AppRouter.shared.replaceWith(.main)
                } else {
                    SessionStore.shared.setString("code_sent", forKey: SessionStore.onboardingPhoneStepKey)
                    step = .code
                }
            } catch {
                errorMessage = ErrorHandler.message(for: error)
            }
            isLoading = false
        }
    }

    private func verifyCode() {
        guard let normalized = PhoneUtils.normalizeUS(phone) else { return }
        isLoading = true
        errorMessage = nil
        Task {
            do {
                try await AuthService.verifyPhoneOTP(phone: normalized, code: code, role: "RIDER")
                AppRouter.shared.replaceWith(.main)
            } catch {
                errorMessage = ErrorHandler.message(for: error)
            }
            isLoading = false
        }
    }
}