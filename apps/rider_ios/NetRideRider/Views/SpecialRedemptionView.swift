import SwiftUI

/// Redemption lifecycle card (mirrors SpecialRedemptionScreen).
struct SpecialRedemptionView: View {
    var code: String?
    var redemptionId: String?
    @EnvironmentObject var specialsProvider: SpecialsProvider
    @State private var redemption: SpecialRedemption?
    @State private var isLoading = true
    @State private var recoveredCode: String?
    @State private var errorMessage: String?
    @State private var showingRewardChoice = false

    var body: some View {
        ZStack {
            AppTheme.primaryBackground.ignoresSafeArea()
            Group {
                if isLoading {
                    ProgressView()
                } else if let redemption {
                    ScrollView {
                        VStack(spacing: 20) {
                            Text(redemption.sponsorName)
                                .font(.system(size: 24, weight: .bold))
                                .foregroundColor(AppTheme.secondaryDarkText)
                            Text(statusTitle(redemption))
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundColor(statusColor(redemption))

                            content(for: redemption)

                            if let errorMessage {
                                Text(errorMessage).font(.system(size: 13)).foregroundColor(AppTheme.errorColor)
                            }
                        }
                        .padding()
                    }
                }
            }
        }
        .onAppear { Task { await load() } }
        .onReceive(specialsProvider.$current) { updated in
            if let updated { redemption = updated }
        }
    }

    @ViewBuilder
    private func content(for redemption: SpecialRedemption) -> some View {
        switch redemption.status {
        case .created:
            VStack(spacing: 14) {
                Text("Your special is ready to attach to a ride.")
                    .font(.system(size: 15))
                    .foregroundColor(AppTheme.secondaryDarkText)
                AppButton(title: "Book my ride to this business") {
                    AppRouter.shared.replaceWith(.main)
                }
            }

        case .waitingForSponsor:
            VStack(spacing: 16) {
                if let displayCode = code ?? recoveredCode ?? specialsProvider.code(for: redemption.id) {
                    Text("Show this code to the business")
                        .font(.system(size: 14))
                        .foregroundColor(AppTheme.secondaryDarkText)
                    Text(displayCode)
                        .font(.system(size: 40, weight: .bold, design: .monospaced))
                        .foregroundColor(AppTheme.warningColor)
                        .padding()
                        .background(AppTheme.warningColor.opacity(0.12))
                        .cornerRadius(12)
                } else {
                    Text("Your one-time code will appear here once the ride completes.")
                        .font(.system(size: 14))
                        .foregroundColor(AppTheme.secondaryDarkText)
                }
                AppButton(title: "I got verified", style: .dark) {
                    markVerified(redemption)
                }
            }

        case .sponsorValidated, .rewardSelected, .rewardFailed:
            VStack(spacing: 14) {
                Text("Your reward is ready to collect!")
                    .font(.system(size: 15))
                    .foregroundColor(AppTheme.secondaryDarkText)
                if let cents = redemption.calculatedDiscountCents {
                    Text("Reward value: $\(Double(cents) / 100, specifier: "%.2f")")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundColor(AppTheme.primaryBrandGreen)
                }
                AppButton(title: "Choose Reward") {
                    showingRewardChoice = true
                }
            }

        case .rewardCompleted:
            VStack(spacing: 10) {
                Image(systemName: "checkmark.seal.fill")
                    .font(.system(size: 48))
                    .foregroundColor(AppTheme.successGreen)
                Text("Reward collected")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundColor(AppTheme.secondaryDarkText)
            }

        case .cancelled:
            Text(redemption.cancellationReasonText ?? "This special was cancelled.")
                .font(.system(size: 14))
                .foregroundColor(AppTheme.errorColor)

        case .expired:
            Text("This special reward has expired.")
                .font(.system(size: 14))
                .foregroundColor(AppTheme.errorColor)

        default:
            Text("We're working on your special.")
                .font(.system(size: 14))
                .foregroundColor(AppTheme.secondaryDarkText)
        }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        // Try pending list by id first, else current redemption.
        if let redemptionId {
            let pending = (try? await SpecialsService.pendingRedemptions()) ?? []
            if let found = pending.first(where: { $0.id == redemptionId }) {
                redemption = found
                return
            }
            // Recover code from notification history.
            recoveredCode = await recoverCode(for: redemptionId)
            redemption = await loadFromNotifications(redemptionId)
        }
        if redemption == nil {
            redemption = try? await SpecialsService.currentRedemption()
            if let r = redemption, code != nil { recoveredCode = code }
        }
    }

    private func loadFromNotifications(_ redemptionId: String) async -> SpecialRedemption? {
        let notifications = (try? await NotificationService.shared.fetchNotifications(limit: 50)) ?? []
        for n in notifications where n.type == "special_reward_ready" {
            if n.data["redemptionId"] == redemptionId {
                recoveredCode = n.data["code"] ?? recoveredCode
                var map: [String: Any] = ["id": redemptionId, "status": "WAITING_FOR_SPONSOR"]
                map["sponsor_name"] = n.data["sponsorName"]
                return SpecialRedemption(json: map)
            }
        }
        return nil
    }

    private func recoverCode(for redemptionId: String) async -> String? {
        let notifications = (try? await NotificationService.shared.fetchNotifications(limit: 50)) ?? []
        for n in notifications where n.type == "special_reward_ready" && n.data["redemptionId"] == redemptionId {
            return n.data["code"]
        }
        return nil
    }

    private func markVerified(_ redemption: SpecialRedemption) {
        Task {
            do {
                let updated = try await SpecialsService.markVerified(id: redemption.id)
                self.redemption = updated
            } catch {
                errorMessage = ErrorHandler.message(for: error)
            }
        }
    }

    private func statusTitle(_ redemption: SpecialRedemption) -> String {
        switch redemption.status {
        case .created: return "YOUR SPECIAL IS READY"
        case .ridePending: return "WAITING FOR YOUR RIDE"
        case .waitingForSponsor: return "SHOW THIS CODE"
        case .sponsorValidated, .rewardSelected: return "REWARD READY"
        case .rewardCompleted: return "COLLECTED"
        case .cancelled: return "CANCELLED"
        case .expired: return "EXPIRED"
        case .rewardFailed: return "REWARD FAILED"
        }
    }

    private func statusColor(_ redemption: SpecialRedemption) -> Color {
        switch redemption.status {
        case .cancelled, .expired, .rewardFailed: return AppTheme.errorColor
        case .rewardCompleted: return AppTheme.successGreen
        case .waitingForSponsor: return AppTheme.warningColor
        default: return AppTheme.primaryBrandGreen
        }
    }
}