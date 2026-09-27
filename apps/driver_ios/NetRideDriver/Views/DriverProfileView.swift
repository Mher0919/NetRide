import SwiftUI
import PhotosUI

/// Driver account tab (mirrors ProfileScreen in the driver app).
struct DriverProfileView: View {
    @EnvironmentObject var driverProvider: DriverProvider
    @State private var profile: [String: Any] = [:]
    @State private var vehicles: [[String: Any]] = []
    @State private var isLoading = true
    @State private var showSettings = false
    @State private var showReplaceVehicle = false
    @State private var showWallet = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Group {
                if isLoading {
                    ProgressView()
                } else {
                    ScrollView {
                        VStack(spacing: 16) {
                            profileHeader
                            AppCard {
                                menuTiles
                            }
                        }
                        .padding()
                    }
                    .refreshable { await load() }
                }
            }
            .navigationTitle("Account")
            .sheet(isPresented: $showSettings) { DriverSettingsView(hasPassword: profile["has_password"] as? Bool ?? false) }
            .sheet(isPresented: $showReplaceVehicle) { ReplaceVehicleView() }
            .sheet(isPresented: $showWallet) { DriverWalletView() }
        }
        .onAppear { Task { await load() } }
    }

    private var profileHeader: some View {
        VStack(spacing: 12) {
            if let url = FileUrl.resolve(profile["profile_image_url"] as? String),
               let remote = URL(string: url) {
                AsyncImage(url: remote) { phase in
                    if let image = phase.image {
                        image.resizable().scaledToFill()
                    } else {
                        placeholderAvatar
                    }
                }
                .frame(width: 96, height: 96)
                .clipShape(Circle())
            } else {
                placeholderAvatar
            }
            Text(profile["full_name"] as? String ?? "")
                .font(.system(size: 22, weight: .semibold))
                .foregroundColor(AppTheme.secondaryDarkText)
            Text(profile["email"] as? String ?? "")
                .font(.system(size: 14))
                .foregroundColor(AppTheme.secondaryDarkText.opacity(0.7))
            if let vehicle = activeVehicle {
                Text("\(vehicle["year"] ?? "") \(vehicle["make"] ?? "") \(vehicle["model"] ?? "")")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundColor(AppTheme.primaryBrandGreen)
                Text("Plate: \(vehicle["license_plate_number"] ?? "")")
                    .font(.system(size: 13))
                    .foregroundColor(AppTheme.secondaryDarkText.opacity(0.6))
            }
            if let errorMessage {
                Text(errorMessage).font(.system(size: 13)).foregroundColor(AppTheme.errorColor)
            }
        }
    }

    private var placeholderAvatar: some View {
        Image(systemName: "person.crop.circle.fill")
            .resizable().scaledToFit()
            .frame(width: 96, height: 96)
            .foregroundColor(AppTheme.primaryBrandGreen)
    }

    private var activeVehicle: [String: Any]? {
        profile["active_vehicle"] as? [String: Any]
    }

    private var menuTiles: some View {
        VStack(spacing: 0) {
            menuRow(icon: "car.fill", title: "Replace Vehicle") { showReplaceVehicle = true }
            Divider()
            menuRow(icon: "creditcard.fill", title: "Wallet & Payouts") { showWallet = true }
            Divider()
            menuRow(icon: "gearshape.fill", title: "App Settings") { showSettings = true }
            Divider()
            Button {
                signOut()
            } label: {
                HStack {
                    Image(systemName: "rectangle.portrait.and.arrow.right")
                    Text("Sign Out")
                    Spacer()
                }
                .foregroundColor(AppTheme.errorColor)
                .font(.system(size: 15, weight: .medium))
                .padding(.vertical, 14)
            }
        }
    }

    private func menuRow(icon: String, title: String, action: @escaping () -> Void) -> some View {
        Button(action: {
            SoundService.shared.playClick()
            action()
        }) {
            HStack(spacing: 12) {
                Image(systemName: icon)
                    .frame(width: 24)
                    .foregroundColor(AppTheme.primaryBrandGreen)
                Text(title)
                    .foregroundColor(AppTheme.secondaryDarkText)
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(AppTheme.softBorderColor)
            }
            .font(.system(size: 15, weight: .medium))
            .padding(.vertical, 14)
        }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            profile = try await UserService.getProfile()
            vehicles = try await UserService.getVehicles()
        } catch {
            if let api = error as? APIError, case .server(let status, _) = api, status == 404 {
                await AuthService.logout()
                AppRouter.shared.replaceWith(.login)
            }
        }
    }

    private func signOut() {
        Task {
            await AuthService.logout()
            AppRouter.shared.replaceWith(.login)
        }
    }
}

/// Driver settings (mirrors SettingsScreen in the driver app).
struct DriverSettingsView: View {
    var hasPassword: Bool
    @State private var soundEnabled = true
    @State private var voiceMuted = false
    @State private var showAccountAction = false
    @State private var isDeletion = false
    @State private var message: String?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Toggle("Sound effects", isOn: $soundEnabled)
                        .onChange(of: soundEnabled) { value in
                            SoundService.shared.setEnabled(value)
                        }
                    Toggle("Navigation voice", isOn: Binding(
                        get: { !voiceMuted },
                        set: { voiceMuted = !$0; NavigationVoiceService.instance.isMuted = !$0 }
                    ))
                }

                if hasPassword {
                    Section("Password & Security") {
                        Button("Change Password") { changePassword() }
                    }
                }

                Section("Account") {
                    Button("Deactivate Account") {
                        isDeletion = false
                        showAccountAction = true
                    }
                    .foregroundColor(AppTheme.warningColor)
                    Button("Delete Account") {
                        isDeletion = true
                        showAccountAction = true
                    }
                    .foregroundColor(AppTheme.errorColor)
                }

                if let message {
                    Text(message).font(.system(size: 13)).foregroundColor(AppTheme.successGreen)
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .sheet(isPresented: $showAccountAction) {
                DriverAccountActionView(isDeletion: isDeletion)
            }
        }
        .onAppear {
            soundEnabled = SessionStore.shared.soundEnabled
            voiceMuted = SessionStore.shared.voiceMuted
        }
    }

    private func changePassword() {
        let alert = UIAlertController(title: "Change Password", message: "Enter your current password.", preferredStyle: .alert)
        alert.addTextField { $0.isSecureTextEntry = true }
        alert.addAction(UIAlertAction(title: "Send Verification", style: .default) { _ in
            guard let value = alert.textFields?.first?.text else { return }
            Task {
                do {
                    try await AuthService.requestPasswordChange(currentPassword: value)
                    message = "Verification email sent!"
                } catch {
                    message = ErrorHandler.message(for: error)
                }
            }
        })
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        UIApplication.shared.keyWindow?.rootViewController?.present(alert, animated: true)
    }
}

struct DriverAccountActionView: View {
    var isDeletion: Bool
    @State private var acknowledged = false
    @State private var errorMessage: String?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: isDeletion ? "trash.fill" : "pause.circle.fill")
                .font(.system(size: 48))
                .foregroundColor(isDeletion ? AppTheme.errorColor : AppTheme.warningColor)
            Text(isDeletion ? "Delete Account" : "Deactivate Account")
                .font(.system(size: 22, weight: .semibold))
            Text(isDeletion
                 ? "This will permanently delete your account and all your data. This cannot be undone."
                 : "Your account will be temporarily deactivated.")
                .font(.system(size: 14))
                .multilineTextAlignment(.center)
                .foregroundColor(AppTheme.secondaryDarkText)
            Toggle(isOn: $acknowledged) { Text("I understand").font(.system(size: 14, weight: .medium)) }
                .tint(AppTheme.errorColor)
            if let errorMessage {
                Text(errorMessage).font(.system(size: 13)).foregroundColor(AppTheme.errorColor)
            }
            AppButton(title: isDeletion ? "Delete my account" : "Deactivate", style: .dark, isEnabled: acknowledged) {
                confirm()
            }
        }
        .padding(24)
    }

    private func confirm() {
        Task {
            do {
                if isDeletion {
                    try await AuthService.deleteAccount()
                } else {
                    try await AuthService.deactivateAccount()
                }
                dismiss()
                AppRouter.shared.replaceWith(.login)
            } catch {
                errorMessage = ErrorHandler.message(for: error)
            }
        }
    }
}