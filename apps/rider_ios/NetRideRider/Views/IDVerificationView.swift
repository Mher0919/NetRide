import SwiftUI

/// ID verification flow (mirrors the ID verification section of ProfileScreen).
struct IDVerificationView: View {
    var profile: [String: Any]
    @State private var dateOfBirth = Date()
    @State private var frontUrl: String?
    @State private var backUrl: String?
    @State private var showFrontPicker = false
    @State private var showBackPicker = false
    @State private var submitting = false
    @State private var message: String?
    @State private var errorMessage: String?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                DatePicker("Date of birth", selection: $dateOfBirth, in: ...Date(), displayedComponents: .date)
                photoButton("ID Photo (Front)", frontUrl != nil, $showFrontPicker)
                photoButton("ID Photo (Back)", backUrl != nil, $showBackPicker)

                if let message {
                    Text(message).font(.system(size: 13)).foregroundColor(AppTheme.successGreen)
                }
                if let errorMessage {
                    Text(errorMessage).font(.system(size: 13)).foregroundColor(AppTheme.errorColor)
                }

                AppButton(title: "Submit for Verification", isEnabled: frontUrl != nil && backUrl != nil && !submitting) {
                    submit()
                }
                Spacer()
            }
            .padding()
            .navigationTitle("ID Verification")
            .navigationBarTitleDisplayMode(.inline)
            .sheet(isPresented: $showFrontPicker) {
                IDPhotoPicker { url in frontUrl = url }
            }
            .sheet(isPresented: $showBackPicker) {
                IDPhotoPicker { url in backUrl = url }
            }
        }
    }

    private func photoButton(_ title: String, _ done: Bool, _ show: Binding<Bool>) -> some View {
        Button {
            show.wrappedValue = true
        } label: {
            HStack {
                Image(systemName: done ? "checkmark.circle.fill" : "camera.fill")
                Text(done ? "\(title) ✓" : title)
                Spacer()
            }
            .padding()
            .background(AppTheme.lightCardBackground)
            .cornerRadius(12)
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(AppTheme.softBorderColor))
        }
        .foregroundColor(AppTheme.secondaryDarkText)
    }

    private func submit() {
        guard let frontUrl, let backUrl else { return }
        submitting = true
        errorMessage = nil
        Task {
            do {
                let formatter = DateFormatter()
                formatter.dateFormat = "yyyy-MM-dd"
                try await UserService.verifyIdentity(
                    idPhotoFrontUrl: frontUrl,
                    idPhotoBackUrl: backUrl,
                    dateOfBirth: formatter.string(from: dateOfBirth)
                )
                message = "Verification request sent to admin."
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { dismiss() }
            } catch {
                errorMessage = ErrorHandler.message(for: error)
            }
            submitting = false
        }
    }
}

struct IDPhotoPicker: UIViewControllerRepresentable {
    var onPicked: (String) -> Void
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
        var parent: IDPhotoPicker
        init(_ parent: IDPhotoPicker) { self.parent = parent }

        func imagePickerController(_ picker: UIImagePickerController,
                                   didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage,
               let data = image.jpegData(compressionQuality: 0.7) {
                Task {
                    do {
                        let url = try await AuthService.uploadImage(
                            base64: data.base64EncodedString(),
                            mimetype: "image/jpeg",
                            filename: "id_photo.jpg"
                        )
                        parent.onPicked(url)
                    } catch {}
                }
            }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.dismiss()
        }
    }
}