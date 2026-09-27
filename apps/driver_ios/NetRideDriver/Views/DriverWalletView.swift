import SwiftUI

/// Driver wallet + payouts (mirrors WalletScreen in the driver app).
struct DriverWalletView: View {
    @State private var wallet: [String: Any] = [:]
    @State private var payouts: [[String: Any]] = []
    @State private var isLoading = true
    @State private var showCardDialog = false
    @State private var showPayoutDialog = false
    @State private var message: String?
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Group {
                if isLoading {
                    ProgressView()
                } else {
                    List {
                        Section {
                            let balance = (wallet["balance_cents"] as? Int) ?? 0
                            let lifetime = (wallet["lifetime_earnings_cents"] as? Int) ?? 0
                            VStack(alignment: .leading, spacing: 6) {
                                Text("Available Balance")
                                    .font(.system(size: 14, weight: .medium))
                                    .foregroundColor(AppTheme.primaryBackground)
                                Text("$\(Double(balance) / 100, specifier: "%.2f")")
                                    .font(.system(size: 34, weight: .bold))
                                    .foregroundColor(.white)
                                Text("Lifetime earnings: $\(Double(lifetime) / 100, specifier: "%.2f")")
                                    .font(.system(size: 12))
                                    .foregroundColor(AppTheme.primaryBackground.opacity(0.8))
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding()
                            .background(
                                LinearGradient(colors: [AppTheme.secondaryDarkText, AppTheme.primaryBrandGreen],
                                               startPoint: .topLeading, endPoint: .bottomTrailing)
                            )
                            .cornerRadius(16)
                        }
                        .listRowBackground(Color.clear)

                        Section {
                            Button("Add Payout Card") { showCardDialog = true }
                            Button("Request Payout") { showPayoutDialog = true }
                        }

                        if let payoutCard = wallet["payout_card"] as? [String: Any] {
                            Section("Payout Card") {
                                HStack {
                                    Image(systemName: "creditcard.fill")
                                        .foregroundColor(AppTheme.primaryBrandGreen)
                                    Text("\(payoutCard["brand"] ?? "") •••• \(payoutCard["last4"] ?? "")")
                                        .font(.system(size: 14))
                                        .foregroundColor(AppTheme.secondaryDarkText)
                                    Spacer()
                                }
                            }
                        }

                        if !payouts.isEmpty {
                            Section("Recent Payouts") {
                                ForEach(0..<payouts.count, id: \.self) { idx in
                                    let payout = payouts[idx]
                                    let net = (payout["net_cents"] as? Int) ?? 0
                                    HStack {
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text("$\(Double(net) / 100, specifier: "%.2f")")
                                                .font(.system(size: 14, weight: .semibold))
                                                .foregroundColor(AppTheme.secondaryDarkText)
                                            Text((payout["requested_at"] as? String) ?? "")
                                                .font(.system(size: 12))
                                                .foregroundColor(AppTheme.secondaryDarkText.opacity(0.6))
                                        }
                                        Spacer()
                                        Text((payout["status"] as? String) ?? "")
                                            .font(.system(size: 12, weight: .semibold))
                                            .foregroundColor(statusColor((payout["status"] as? String) ?? ""))
                                    }
                                }
                            }
                        }

                        if let message {
                            Text(message).font(.system(size: 13)).foregroundColor(AppTheme.successGreen)
                        }
                        if let errorMessage {
                            Text(errorMessage).font(.system(size: 13)).foregroundColor(AppTheme.errorColor)
                        }
                    }
                }
            }
            .navigationTitle("Wallet")
            .navigationBarTitleDisplayMode(.inline)
            .sheet(isPresented: $showCardDialog) { PayoutCardView(onDone: { showCardDialog = false; Task { await load() } }) }
            .sheet(isPresented: $showPayoutDialog) { PayoutRequestView(balanceCents: (wallet["balance_cents"] as? Int) ?? 0, onDone: { showPayoutDialog = false; Task { await load() } }) }
        }
        .onAppear { Task { await load() } }
    }

    private func statusColor(_ status: String) -> Color {
        switch status {
        case "PAID": return AppTheme.successGreen
        case "FAILED": return AppTheme.errorColor
        default: return AppTheme.warningColor
        }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        wallet = (try? await UserService.getWallet()) ?? [:]
        payouts = (try? await UserService.getPayouts()) ?? []
    }
}

/// Add payout card dialog (mirrors payout-card dialog in the driver app).
struct PayoutCardView: View {
    var onDone: () -> Void
    @State private var cardNumber = ""
    @State private var expMonth = ""
    @State private var expYear = ""
    @State private var cardholderName = ""
    @State private var zip = ""
    @State private var cvc = ""
    @State private var message: String?
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Card Details") {
                    TextField("Card number", text: $cardNumber)
                        .keyboardType(.numberPad)
                    HStack {
                        TextField("MM", text: $expMonth).keyboardType(.numberPad)
                        TextField("YY", text: $expYear).keyboardType(.numberPad)
                        TextField("CVC", text: $cvc).keyboardType(.numberPad)
                    }
                    TextField("Cardholder name", text: $cardholderName)
                    TextField("ZIP", text: $zip).keyboardType(.numberPad)
                }
                if let message {
                    Text(message).font(.system(size: 13)).foregroundColor(AppTheme.successGreen)
                }
                if let errorMessage {
                    Text(errorMessage).font(.system(size: 13)).foregroundColor(AppTheme.errorColor)
                }
            }
            .navigationTitle("Add Payout Card")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { onDone() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { submit() }
                        .fontWeight(.semibold)
                }
            }
        }
    }

    private var validLuhn: Bool {
        let digits = cardNumber.filter(\.isNumber)
        guard digits.count >= 13, digits.count <= 19 else { return false }
        var sum = 0
        var double = false
        for ch in digits.reversed() {
            var d = Int(String(ch)) ?? 0
            if double {
                d *= 2
                if d > 9 { d -= 9 }
            }
            sum += d
            double.toggle()
        }
        return sum % 10 == 0
    }

    private func submit() {
        guard validLuhn else {
            errorMessage = "Please enter a valid card number."
            return
        }
        Task {
            do {
                _ = try await UserService.addPayoutCard(
                    cardNumber: cardNumber,
                    expMonth: Int(expMonth) ?? 0,
                    expYear: Int(expYear) ?? 0,
                    cardholderName: cardholderName,
                    zip: zip,
                    cvc: cvc
                )
                message = "Card added! Reviewing…"
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { onDone() }
            } catch {
                errorMessage = ErrorHandler.message(for: error)
            }
        }
    }
}

/// On-demand payout request (mirrors payout dialog in the driver app).
struct PayoutRequestView: View {
    var balanceCents: Int
    var onDone: () -> Void
    @State private var amountDollars = ""
    @State private var message: String?
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Amount ($)", text: $amountDollars)
                        .keyboardType(.decimalPad)
                } footer: {
                    Text("Minimum $10. A 5% fee applies.")
                }
                if let message {
                    Text(message).font(.system(size: 13)).foregroundColor(AppTheme.successGreen)
                }
                if let errorMessage {
                    Text(errorMessage).font(.system(size: 13)).foregroundColor(AppTheme.errorColor)
                }
            }
            .navigationTitle("Request Payout")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { onDone() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Request") { submit() }
                        .fontWeight(.semibold)
                }
            }
        }
    }

    private func submit() {
        guard let amount = Double(amountDollars), amount >= 10 else {
            errorMessage = "Minimum payout is $10."
            return
        }
        let cents = Int(amount * 100)
        guard cents <= balanceCents else {
            errorMessage = "Insufficient balance."
            return
        }
        Task {
            do {
                let res = try await UserService.requestPayout(amountCents: cents)
                let net = (res["net_cents"] as? Int) ?? 0
                message = "Payout requested! You'll receive $\(Double(net) / 100, specifier: "%.2f")."
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { onDone() }
            } catch {
                errorMessage = ErrorHandler.message(for: error)
            }
        }
    }
}