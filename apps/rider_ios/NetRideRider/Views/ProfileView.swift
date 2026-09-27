import SwiftUI
import PhotosUI

/// Account tab (mirrors ProfileScreen in the rider app).
struct ProfileView: View {
    @State private var profile: [String: Any] = [:]
    @State private var isLoading = true
    @State private var unreadCount = 0
    @State private var showSettings = false
    @State private var showCredits = false
    @State private var showWallet = false
    @State private var showReferral = false
    @State private var showFavorites = false
    @State private var showNotifications = false
    @State private var showIdVerification = false
    @State private var showImagePicker = false
    @State private var pickedImage: UIImage?
    @State private var fullName = ""
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
            .sheet(isPresented: $showSettings) { SettingsView(hasPassword: profile["has_password"] as? Bool ?? false) }
            .sheet(isPresented: $showCredits) { CreditsView() }
            .sheet(isPresented: $showWallet) { WalletView() }
            .sheet(isPresented: $showReferral) { ReferralView() }
            .sheet(isPresented: $showFavorites) { FavoriteDriversView() }
            .sheet(isPresented: $showNotifications) { NotificationsView() }
            .sheet(isPresented: $showIdVerification) { IDVerificationView(profile: profile) }
            .sheet(isPresented: $showImagePicker) {
                ImagePickerView(image: $pickedImage) { image in
                    uploadProfileImage(image)
                }
            }
        }
        .onAppear { Task { await load() } }
    }

    private var profileHeader: some View {
        VStack(spacing: 12) {
            Button {
                showImagePicker = true
            } label: {
                if let url = FileUrl.resolve(profile["profile_image_url"] as? String),
                   let remote = URL(string: url) {
                    AsyncImage(url: remote) { phase in
                        if let image = phase.image {
                            image.resizable().scaledToFill()
                        } else {
                            Image(systemName: "person.crop.circle.fill")
                                .resizable().scaledToFit()
                                .foregroundColor(AppTheme.primaryBrandGreen)
                        }
                    }
                    .frame(width: 96, height: 96)
                    .clipShape(Circle())
                } else {
                    Image(systemName: "person.crop.circle.fill")
                        .resizable().scaledToFit()
                        .frame(width: 96, height: 96)
                        .foregroundColor(AppTheme.primaryBrandGreen)
                }
            }
            Text(profile["full_name"] as? String ?? "")
                .font(.system(size: 22, weight: .semibold))
                .foregroundColor(AppTheme.secondaryDarkText)
            Text(profile["email"] as? String ?? "")
                .font(.system(size: 14))
                .foregroundColor(AppTheme.secondaryDarkText.opacity(0.7))
            if let phone = profile["phone_number"] as? String, !phone.isEmpty {
                Text(PhoneUtils.format(phone))
                    .font(.system(size: 14))
                    .foregroundColor(AppTheme.secondaryDarkText.opacity(0.7))
            }
            if let errorMessage {
                Text(errorMessage).font(.system(size: 13)).foregroundColor(AppTheme.errorColor)
            }
        }
    }

    private var menuTiles: some View {
        VStack(spacing: 0) {
            menuRow(icon: "star.fill", title: "Favorite Drivers") { showFavorites = true }
            Divider()
            menuRow(icon: "bell.fill", title: "Notifications") {
                showNotifications = true
                unreadCount = 0
            }
            .overlay(alignment: .trailing) {
                if unreadCount > 0 {
                    Text("\(unreadCount)")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundColor(.white)
                        .padding(6)
                        .background(AppTheme.errorColor)
                        .clipShape(Circle())
                        .padding(.trailing, 40)
                }
            }
            Divider()
            menuRow(icon: "gearshape.fill", title: "App Settings") { showSettings = true }
            Divider()
            menuRow(icon: "creditcard.fill", title: "Payment") { showWallet = true }
            Divider()
            menuRow(icon: "dollarsign.circle.fill", title: "Ride Credits") { showCredits = true }
            Divider()
            menuRow(icon: "gift.fill", title: "Refer & Earn") { showReferral = true }
            Divider()
            menuRow(icon: "person.text.rectangle", title: "ID Verification") { showIdVerification = true }
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
            fullName = profile["full_name"] as? String ?? ""
            unreadCount = (try? await NotificationService.shared.unreadCount()) ?? 0
        } catch {
            if let api = error as? APIError, case .server(let status, _) = api, status == 404 {
                await AuthService.logout()
                AppRouter.shared.replaceWith(.login)
            }
        }
    }

    private func uploadProfileImage(_ image: UIImage) {
        guard let data = image.jpegData(compressionQuality: 0.7) else { return }
        let base64 = data.base64EncodedString()
        Task {
            do {
                let url = try await AuthService.uploadImage(base64: base64, mimetype: "image/jpeg", filename: "profile.jpg")
                _ = try await UserService.updateProfile(["profile_image_url": url])
                await load()
            } catch {
                errorMessage = ErrorHandler.message(for: error)
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

/// Image picker wrapper (mirrors pickImageWithSource).
struct ImagePickerView: UIViewControllerRepresentable {
    @Binding var image: UIImage?
    var onPicked: (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.delegate = context.coordinator
        picker.sourceType = .photoLibrary
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        var parent: ImagePickerView
        init(_ parent: ImagePickerView) { self.parent = parent }

        func imagePickerController(_ picker: UIImagePickerController,
                                   didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage {
                parent.image = image
                parent.onPicked(image)
            }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.dismiss()
        }
    }
}