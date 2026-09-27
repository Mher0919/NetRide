import SwiftUI

/// App settings (mirrors SettingsScreen).
struct SettingsView: View {
    var hasPassword: Bool
    @State private var soundEnabled = true
    @State private var showAccountAction = false
    @State private var isDeletion = false
    @State private var currentPassword = ""
    @State private var message: String?
    @State private var errorMessage: String?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Toggle("Sound effects", isOn: $soundEnabled)
                        .onChange(of: soundEnabled) { value in
                            SoundService.shared.setEnabled(value)
                        }
                }

                if hasPassword {
                    Section("Password & Security") {
                        Button("Change Password") {
                            changePassword()
                        }
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
                if let errorMessage {
                    Text(errorMessage).font(.system(size: 13)).foregroundColor(AppTheme.errorColor)
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .sheet(isPresented: $showAccountAction) {
                AccountActionView(isDeletion: isDeletion)
            }
        }
        .onAppear { soundEnabled = SessionStore.shared.soundEnabled }
        .alert("Change Password", isPresented: Binding(
            get: { !currentPassword.isEmpty },
            set: { if !$0 { currentPassword = "" } }
        )) {
            TextField("Current password", text: $currentPassword)
            Button("Send Verification") { requestPasswordChange() }
            Button("Cancel", role: .cancel) { currentPassword = "" }
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
                    errorMessage = ErrorHandler.message(for: error)
                }
            }
        })
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        UIApplication.shared.keyWindow?.rootViewController?.present(alert, animated: true)
    }

    private func requestPasswordChange() {
        Task {
            do {
                try await AuthService.requestPasswordChange(currentPassword: currentPassword)
                message = "Verification email sent!"
            } catch {
                errorMessage = ErrorHandler.message(for: error)
            }
            currentPassword = ""
        }
    }
}

/// Deactivate / delete account confirmation (mirrors AccountActionScreen).
struct AccountActionView: View {
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
                 : "Your account will be temporarily deactivated. You can reactivate by signing in again.")
                .font(.system(size: 14))
                .multilineTextAlignment(.center)
                .foregroundColor(AppTheme.secondaryDarkText)
            Toggle(isOn: $acknowledged) {
                Text("I understand")
                    .font(.system(size: 14, weight: .medium))
            }
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