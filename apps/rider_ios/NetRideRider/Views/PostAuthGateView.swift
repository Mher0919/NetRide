import SwiftUI

/// Post-auth gate: checks blocked status + referral eligibility (mirrors PostAuthGate).
struct PostAuthGateView: View {
    @State private var checked = false

    var body: some View {
        ZStack {
            AppTheme.primaryBackground.ignoresSafeArea()
            ProgressView()
        }
        .onAppear { check() }
    }

    private func check() {
        guard !checked else { return }
        checked = true
        Task {
            // Blocked check
            do {
                let profile = try await UserService.getProfile()
                if (profile["verification_status"] as? String) == "BLOCKED" {
                    AppRouter.shared.initialBlockedReason = profile["blocked_reason"] as? String
                    AppRouter.shared.replaceWith(.blocked)
                    return
                }
            } catch {
                AppRouter.shared.replaceWith(.main)
                return
            }
            // Referral eligibility
            do {
                let status = try await RewardsService.getOnboardingStatus()
                if status.eligible {
                    AppRouter.shared.replaceWith(.referralOnboarding)
                    return
                }
            } catch {}
            AppRouter.shared.replaceWith(.main)
        }
    }
}