import SwiftUI

struct BlockedAccountView: View {
    var reason: String?
    @State private var checking = false

    var body: some View {
        ZStack {
            AppTheme.primaryBackground.ignoresSafeArea()
            VStack(spacing: 20) {
                Image(systemName: "hand.raised.fill")
                    .resizable().scaledToFit()
                    .frame(width: 60, height: 60)
                    .foregroundColor(AppTheme.errorColor)
                Text("Account Blocked")
                    .font(.system(size: 26, weight: .semibold))
                    .foregroundColor(AppTheme.secondaryDarkText)
                Text(reason ?? "Your account has been blocked.")
                    .font(.system(size: 15))
                    .foregroundColor(AppTheme.secondaryDarkText)
                    .multilineTextAlignment(.center)
                Button("Contact Support") {
                    let url = URL(string: "mailto:support@netride.org?subject=Blocked%20Account")!
                    UIApplication.shared.open(url)
                }
                .font(.system(size: 15, weight: .semibold))
                .foregroundColor(AppTheme.primaryBrandGreen)
            }
            .padding(28)
        }
        .onAppear { startPolling() }
    }

    private func startPolling() {
        checking = true
        Task {
            while checking {
                try? await Task.sleep(nanoseconds: 10_000_000_000)
                guard let profile = try? await UserService.getProfile(),
                      (profile["verification_status"] as? String) != "BLOCKED" else { continue }
                checking = false
                AppRouter.shared.replaceWith(.main)
            }
        }
    }
}