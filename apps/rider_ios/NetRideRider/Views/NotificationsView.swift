import SwiftUI

/// In-app notification history (mirrors NotificationsScreen).
struct NotificationsView: View {
    @State private var notifications: [NetRideNotification] = []
    @State private var isLoading = true

    var body: some View {
        NavigationStack {
            Group {
                if isLoading {
                    ProgressView()
                } else if notifications.isEmpty {
                    VStack(spacing: 12) {
                        Image(systemName: "bell")
                            .font(.system(size: 44))
                            .foregroundColor(AppTheme.softBorderColor)
                        Text("No notifications")
                            .font(.system(size: 16, weight: .semibold))
                    }
                } else {
                    List {
                        ForEach(notifications) { notification in
                            Button {
                                open(notification)
                            } label: {
                                HStack(alignment: .top, spacing: 12) {
                                    Image(systemName: icon(for: notification.type))
                                        .foregroundColor(color(for: notification.type))
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(notification.title)
                                            .font(.system(size: 14, weight: notification.isRead ? .regular : .bold))
                                            .foregroundColor(AppTheme.secondaryDarkText)
                                        Text(notification.body)
                                            .font(.system(size: 13))
                                            .foregroundColor(AppTheme.secondaryDarkText.opacity(0.7))
                                        if let date = notification.createdAt {
                                            Text(date.formatted())
                                                .font(.system(size: 11))
                                                .foregroundColor(AppTheme.secondaryDarkText.opacity(0.5))
                                        }
                                    }
                                    Spacer()
                                }
                            }
                            .listRowBackground(notification.isRead ? Color.clear : AppTheme.primaryBrandGreen.opacity(0.06))
                        }
                    }
                    .refreshable { await load() }
                }
            }
            .navigationTitle("Notifications")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Mark all read") { markAllRead() }
                        .font(.system(size: 13, weight: .medium))
                }
            }
        }
        .onAppear { Task { await load() } }
        .onReceive(NotificationCenter.default.publisher(for: .notificationPing)) { _ in
            Task { await load() }
        }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        notifications = (try? await NotificationService.shared.fetchNotifications()) ?? []
    }

    private func markAllRead() {
        let ids = notifications.map(\.id)
        Task {
            try? await NotificationService.shared.markRead(ids: ids)
            await load()
        }
    }

    private func open(_ notification: NetRideNotification) {
        Task {
            try? await NotificationService.shared.markRead(id: notification.id)
            if notification.route == "/trip" {
                AppRouter.shared.push(.trip)
            } else if notification.route == "/credits" {
                AppRouter.shared.push(.credits)
            }
        }
    }

    private func icon(for type: String) -> String {
        switch type {
        case "ride_accepted", "driver_arrived", "ride_started", "ride_completed":
            return "car.fill"
        case "ride_cancelled":
            return "xmark.circle.fill"
        case "credits_earned", "credits_applied", "wallet_charged":
            return "dollarsign.circle.fill"
        case "promo_applied":
            return "tag.fill"
        case "referral_linked", "referral_reward":
            return "gift.fill"
        case "special_reward_ready", "special_reward_credited", "special_refunded":
            return "star.circle.fill"
        default:
            return "bell.fill"
        }
    }

    private func color(for type: String) -> Color {
        switch type {
        case "ride_accepted", "driver_arrived", "ride_started", "ride_completed":
            return AppTheme.successGreen
        case "ride_cancelled":
            return AppTheme.errorColor
        case "credits_earned", "credits_applied", "wallet_charged", "special_reward_ready", "special_reward_credited", "special_refunded":
            return AppTheme.primaryBrandGreen
        case "promo_applied":
            return AppTheme.warningColor
        case "referral_linked", "referral_reward":
            return AppTheme.successGreen
        default:
            return AppTheme.primaryBrandGreen
        }
    }
}

extension Notification.Name {
    static let notificationPing = Notification.Name("notificationPing")
}