import SwiftUI

/// Referral onboarding: scan QR / enter code / skip (mirrors ReferralOnboardingScreen).
struct ReferralOnboardingView: View {
    @State private var showScanner = false
    @State private var showManual = false
    @State private var manualCode = ""
    @State private var successText: String?
    @State private var errorMessage: String?
    @State private var isLoading = false

    var body: some View {
        ZStack {
            AppTheme.primaryBackground.ignoresSafeArea()
            VStack(spacing: 24) {
                Image(systemName: "gift.fill")
                    .resizable().scaledToFit()
                    .frame(width: 70, height: 70)
                    .foregroundColor(AppTheme.primaryBrandGreen)
                Text("Refer a friend, earn credits")
                    .font(.system(size: 24, weight: .semibold))
                    .foregroundColor(AppTheme.secondaryDarkText)
                Text("You both earn $5 in ride credits after your first completed ride.")
                    .font(.system(size: 15))
                    .foregroundColor(AppTheme.secondaryDarkText)
                    .multilineTextAlignment(.center)

                if let successText {
                    Text(successText)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundColor(AppTheme.successGreen)
                        .multilineTextAlignment(.center)
                }
                if let errorMessage {
                    Text(errorMessage)
                        .font(.system(size: 13))
                        .foregroundColor(AppTheme.errorColor)
                        .multilineTextAlignment(.center)
                }

                AppButton(title: "Scan a Referral Code", icon: "qrcode.viewfinder") {
                    showScanner = true
                }
                AppButton(title: "Enter a Code", icon: "keyboard", style: .outlined) {
                    showManual = true
                }
                AppButton(title: "Skip for now", style: .outlined) {
                    skip()
                }
            }
            .padding(28)
        }
        .sheet(isPresented: $showScanner) {
            QrScannerView(onboarding: true) { result in
                handleScan(payload: result)
            }
        }
        .alert("Enter Referral Code", isPresented: $showManual) {
            TextField("Code", text: $manualCode)
                .autocapitalization(.allCharacters)
            Button("Submit") { submitCode() }
            Button("Cancel", role: .cancel) {}
        }
        .interactiveDismissDisabled()
    }

    private func handleScan(payload: String) {
        Task {
            do {
                let res = try await RewardsService.scanReferral(payload: payload)
                successText = res.referrerName.map { "You're now linked with \($0)!" } ?? "Code accepted!"
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                    AppRouter.shared.replaceWith(.main)
                }
            } catch {
                errorMessage = ErrorHandler.message(for: error)
            }
        }
    }

    private func submitCode() {
        let normalized = manualCode.uppercased().trimmingCharacters(in: .whitespaces)
        guard normalized.count == 10 else {
            errorMessage = "Please enter a valid 10-character code."
            return
        }
        isLoading = true
        errorMessage = nil
        Task {
            do {
                let res = try await RewardsService.scanReferral(code: normalized)
                successText = res.referrerName.map { "You're now linked with \($0)!" } ?? "Code accepted!"
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                    AppRouter.shared.replaceWith(.main)
                }
            } catch {
                errorMessage = ErrorHandler.message(for: error)
            }
            isLoading = false
        }
    }

    private func skip() {
        Task {
            try? await RewardsService.skipOnboarding()
            AppRouter.shared.replaceWith(.main)
        }
    }
}