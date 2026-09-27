import SwiftUI

/// Credits balance + ledger (mirrors CreditsScreen).
struct CreditsView: View {
    @State private var account: CreditAccount?
    @State private var transactions: [LedgerTransaction] = []
    @State private var isLoading = true

    var body: some View {
        NavigationStack {
            Group {
                if isLoading {
                    ProgressView()
                } else {
                    List {
                        Section {
                            VStack(alignment: .leading, spacing: 6) {
                                Text("Ride Credits")
                                    .font(.system(size: 14, weight: .medium))
                                    .foregroundColor(AppTheme.primaryBackground)
                                Text("$\(centsToDollars(account?.balanceCents ?? 0))")
                                    .font(.system(size: 34, weight: .bold))
                                    .foregroundColor(.white)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding()
                            .background(
                                LinearGradient(colors: [AppTheme.primaryBrandGreen, AppTheme.secondaryDarkText],
                                               startPoint: .topLeading, endPoint: .bottomTrailing)
                            )
                            .cornerRadius(16)
                        }
                        .listRowBackground(Color.clear)

                        Section("History") {
                            ForEach(transactions) { tx in
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(txTitle(tx.type))
                                            .font(.system(size: 14, weight: .medium))
                                            .foregroundColor(AppTheme.secondaryDarkText)
                                        if let desc = tx.description {
                                            Text(desc).font(.system(size: 12)).foregroundColor(AppTheme.secondaryDarkText.opacity(0.6))
                                        }
                                    }
                                    Spacer()
                                    Text("\(tx.amountCents >= 0 ? "+" : "-")$\(centsToDollars(abs(tx.amountCents)))")
                                        .font(.system(size: 14, weight: .semibold))
                                        .foregroundColor(tx.amountCents >= 0 ? AppTheme.successGreen : AppTheme.errorColor)
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Ride Credits")
        }
        .onAppear { Task { await load() } }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        account = try? await RewardsService.getCredits()
        transactions = (try? await RewardsService.getCreditTransactions()) ?? []
    }

    private func txTitle(_ type: String) -> String {
        switch type {
        case "REFERRAL_REWARD": return "Referral reward"
        case "ADMIN_GRANT": return "Bonus credits"
        case "RIDE_APPLIED": return "Applied to ride"
        case "RIDE_REFUND": return "Refunded from cancelled ride"
        case "SPONSOR_REWARD": return "Special reward"
        default: return type
        }
    }

    private func centsToDollars(_ cents: Int) -> String {
        String(format: "%.2f", Double(cents) / 100)
    }
}

/// Wallet / payment (mirrors WalletScreen).
struct WalletView: View {
    @State private var account: WalletAccount?
    @State private var transactions: [LedgerTransaction] = []
    @State private var isLoading = true

    var body: some View {
        NavigationStack {
            Group {
                if isLoading {
                    ProgressView()
                } else {
                    List {
                        Section {
                            VStack(alignment: .leading, spacing: 6) {
                                Text("Payment Method")
                                    .font(.system(size: 14, weight: .medium))
                                    .foregroundColor(AppTheme.primaryBackground)
                                Text("$\(centsToDollars(account?.balanceCents ?? 0))")
                                    .font(.system(size: 34, weight: .bold))
                                    .foregroundColor(.white)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding()
                            .background(
                                LinearGradient(colors: [AppTheme.secondaryDarkText, AppTheme.successGreen],
                                               startPoint: .topLeading, endPoint: .bottomTrailing)
                            )
                            .cornerRadius(16)
                        }
                        .listRowBackground(Color.clear)

                        Section("History") {
                            ForEach(transactions) { tx in
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(txTitle(tx.type))
                                            .font(.system(size: 14, weight: .medium))
                                            .foregroundColor(AppTheme.secondaryDarkText)
                                        if let desc = tx.description {
                                            Text(desc).font(.system(size: 12)).foregroundColor(AppTheme.secondaryDarkText.opacity(0.6))
                                        }
                                    }
                                    Spacer()
                                    Text("\(tx.amountCents >= 0 ? "+" : "-")$\(centsToDollars(abs(tx.amountCents)))")
                                        .font(.system(size: 14, weight: .semibold))
                                        .foregroundColor(tx.amountCents >= 0 ? AppTheme.successGreen : AppTheme.errorColor)
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Payment")
        }
        .onAppear { Task { await load() } }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        account = try? await RewardsService.getWallet()
        transactions = (try? await RewardsService.getWalletTransactions()) ?? []
    }

    private func txTitle(_ type: String) -> String {
        switch type {
        case "ADMIN_GRANT": return "Added to account"
        case "RIDE_PAYMENT": return "Paid for ride"
        case "RIDE_REFUND": return "Refunded ride payment"
        case "SPONSOR_REWARD": return "Special refund"
        default: return type
        }
    }

    private func centsToDollars(_ cents: Int) -> String {
        String(format: "%.2f", Double(cents) / 100)
    }
}