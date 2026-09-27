import SwiftUI

/// Favorite drivers list (mirrors FavoriteDriversScreen).
struct FavoriteDriversView: View {
    @State private var favorites: [FavoriteDriver] = []
    @State private var isLoading = true

    var body: some View {
        NavigationStack {
            Group {
                if isLoading {
                    ProgressView()
                } else if favorites.isEmpty {
                    VStack(spacing: 12) {
                        Image(systemName: "star")
                            .font(.system(size: 44))
                            .foregroundColor(AppTheme.softBorderColor)
                        Text("No favorite drivers yet")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundColor(AppTheme.secondaryDarkText)
                    }
                } else {
                    List {
                        ForEach(favorites) { driver in
                            HStack(spacing: 12) {
                                Image(systemName: "person.crop.circle.fill")
                                    .resizable().scaledToFit()
                                    .frame(width: 44, height: 44)
                                    .foregroundColor(AppTheme.primaryBrandGreen)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(driver.fullName ?? "Driver")
                                        .font(.system(size: 15, weight: .semibold))
                                        .foregroundColor(AppTheme.secondaryDarkText)
                                    Text("\(String(format: "%.1f", driver.rating)) ★ · \(driver.ratingCount) rides")
                                        .font(.system(size: 13))
                                        .foregroundColor(AppTheme.secondaryDarkText.opacity(0.7))
                                    if let phone = driver.phoneNumber {
                                        Text(PhoneUtils.format(phone))
                                            .font(.system(size: 12))
                                            .foregroundColor(AppTheme.primaryBrandGreen)
                                    }
                                }
                                Spacer()
                            }
                            .swipeActions {
                                Button(role: .destructive) {
                                    remove(driver)
                                } label: {
                                    Label("Remove", systemImage: "heart.slash")
                                }
                            }
                        }
                    }
                    .refreshable { await load() }
                }
            }
            .navigationTitle("Favorite Drivers")
        }
        .onAppear { Task { await load() } }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        favorites = (try? await UserService.getFavorites()) ?? []
    }

    private func remove(_ driver: FavoriteDriver) {
        Task {
            try? await UserService.removeFavorite(driverId: driver.driverId)
            await load()
        }
    }
}

/// Referral screen (mirrors ReferralScreen).
struct ReferralView: View {
    @State private var info: ReferralInfo?
    @State private var history: [ReferralHistoryEntry] = []
    @State private var isLoading = true
    @State private var showScanner = false
    @State private var showManual = false
    @State private var manualCode = ""
    @State private var message: String?
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Group {
                if isLoading {
                    ProgressView()
                } else {
                    ScrollView {
                        VStack(spacing: 16) {
                            // QR code (referral payload)
                            if let info {
                                Text("Your referral code")
                                    .font(.system(size: 16, weight: .semibold))
                                    .foregroundColor(AppTheme.secondaryDarkText)
                                Text(info.code)
                                    .font(.system(size: 28, weight: .bold, design: .monospaced))
                                    .foregroundColor(AppTheme.primaryBrandGreen)
                                // Placeholder QR (payload rendered by system QR generator)
                                QRCodeView(payload: info.qrPayload)
                                    .frame(width: 180, height: 180)
                                Button("Copy referral link") {
                                    UIPasteboard.general.string = info.referralUrl
                                    message = "Link copied!"
                                }
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundColor(AppTheme.primaryBrandGreen)

                                HStack(spacing: 30) {
                                    stat("Invited", "\(info.referredCount)")
                                    stat("Earned", "$\(Double(info.rewardsEarnedCents) / 100, specifier: "%.2f")")
                                }

                                if info.canScan {
                                    AppButton(title: "Scan a Code", icon: "qrcode.viewfinder") { showScanner = true }
                                    AppButton(title: "Enter a Code", icon: "keyboard", style: .outlined) { showManual = true }
                                } else {
                                    Text("You've already used a referral code.")
                                        .font(.system(size: 13))
                                        .foregroundColor(AppTheme.secondaryDarkText.opacity(0.6))
                                }
                            }

                            if let message {
                                Text(message).font(.system(size: 13)).foregroundColor(AppTheme.successGreen)
                            }
                            if let errorMessage {
                                Text(errorMessage).font(.system(size: 13)).foregroundColor(AppTheme.errorColor)
                            }

                            if !history.isEmpty {
                                Divider()
                                VStack(alignment: .leading, spacing: 10) {
                                    Text("History")
                                        .font(.system(size: 16, weight: .semibold))
                                        .foregroundColor(AppTheme.secondaryDarkText)
                                    ForEach(history) { entry in
                                        HStack {
                                            Text(entry.friendName ?? entry.friendEmail ?? "Friend")
                                                .font(.system(size: 14))
                                                .foregroundColor(AppTheme.secondaryDarkText)
                                            Spacer()
                                            Text(historyLabel(entry.status))
                                                .font(.system(size: 12, weight: .semibold))
                                                .foregroundColor(AppTheme.primaryBrandGreen)
                                        }
                                        .padding(.vertical, 4)
                                    }
                                }
                            }
                        }
                        .padding()
                    }
                }
            }
            .navigationTitle("Refer & Earn")
        }
        .onAppear { Task { await load() } }
        .sheet(isPresented: $showScanner) {
            QrScannerView(onboarding: false) { payload in
                scan(payload: payload)
            }
        }
        .alert("Enter Referral Code", isPresented: $showManual) {
            TextField("Code", text: $manualCode)
            Button("Submit") { scan(code: manualCode.uppercased()) }
            Button("Cancel", role: .cancel) {}
        }
    }

    private func stat(_ label: String, _ value: String) -> some View {
        VStack(spacing: 4) {
            Text(value).font(.system(size: 20, weight: .bold)).foregroundColor(AppTheme.secondaryDarkText)
            Text(label).font(.system(size: 12)).foregroundColor(AppTheme.secondaryDarkText.opacity(0.6))
        }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        info = try? await RewardsService.getReferral()
        history = (try? await RewardsService.getReferralHistory()) ?? []
    }

    private func scan(payload: String) {
        Task {
            do {
                _ = try await RewardsService.scanReferral(payload: payload)
                message = "Referral code accepted!"
            } catch {
                errorMessage = ErrorHandler.message(for: error)
            }
        }
    }

    private func scan(code: String) {
        Task {
            do {
                _ = try await RewardsService.scanReferral(code: code)
                message = "Referral code accepted!"
            } catch {
                errorMessage = ErrorHandler.message(for: error)
            }
        }
    }

    private func historyLabel(_ status: String) -> String {
        switch status {
        case "QR_SCANNED": return "Invited"
        case "LINKED": return "Joined"
        case "FIRST_RIDE_PENDING": return "First ride pending"
        case "FIRST_RIDE_COMPLETED": return "First ride done"
        case "REWARD_GRANTED": return "$5 earned"
        default: return status
        }
    }
}

/// Simple QR code renderer using CoreImage (mirrors qr_flutter rendering).
struct QRCodeView: UIViewRepresentable {
    var payload: String

    func makeUIView(context: Context) -> UIImageView {
        let view = UIImageView()
        view.contentMode = .scaleAspectFit
        return view
    }

    func updateUIView(_ uiView: UIImageView, context: Context) {
        guard let filter = CIFilter(name: "CIQRCodeGenerator") else { return }
        filter.setValue(Data(payload.utf8), forKey: "inputMessage")
        filter.setValue("M", forKey: "inputCorrectionLevel")
        guard let output = filter.outputImage else { return }
        let scaled = output.transformed(by: CGAffineTransform(scaleX: 10, y: 10))
        let context = CIContext()
        if let cgImage = context.createCGImage(scaled, from: scaled.extent) {
            uiView.image = UIImage(cgImage: cgImage)
        }
    }
}