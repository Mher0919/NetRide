import SwiftUI
import UIKit

/// Document re-submission (mirrors DocumentResubmissionScreen).
struct DocumentResubmissionView: View {
    @EnvironmentObject var driverProvider: DriverProvider
    @State private var requirements: [[String: Any]] = []
    @State private var isLoading = true
    @State private var submissions: [String: [String]] = [:] // requirementId -> urls
    @State private var pendingPicker: String?
    @State private var errorMessage: String?
    @State private var success = false

    var body: some View {
        ZStack {
            AppTheme.primaryBackground.ignoresSafeArea()
            Group {
                if isLoading {
                    ProgressView()
                } else if success {
                    VStack(spacing: 16) {
                        Image(systemName: "checkmark.seal.fill")
                            .font(.system(size: 52))
                            .foregroundColor(AppTheme.successGreen)
                        Text("Documents submitted!")
                            .font(.system(size: 22, weight: .semibold))
                        AppButton(title: "Done") { AppRouter.shared.pop() }
                    }
                } else if requirements.isEmpty {
                    VStack(spacing: 12) {
                        Text("No documents to resubmit right now.")
                            .font(.system(size: 15))
                            .foregroundColor(AppTheme.secondaryDarkText)
                        AppButton(title: "Back") { AppRouter.shared.pop() }
                    }
                } else {
                    ScrollView {
                        VStack(spacing: 16) {
                            ForEach(requirements.indices, id: \.self) { idx in
                                let req = requirements[idx]
                                let requirementId = (req["id"] as? String) ?? ""
                                let docType = (req["document_type"] as? String) ?? ""
                                requirementCard(req, requirementId: requirementId, docType: docType)
                            }
                            if let errorMessage {
                                Text(errorMessage).font(.system(size: 13)).foregroundColor(AppTheme.errorColor)
                            }
                            AppButton(title: "Submit for Review") {
                                submitAll()
                            }
                        }
                        .padding()
                    }
                }
            }
        }
        .navigationTitle("Documents")
        .onAppear { Task { await load() } }
        .sheet(isPresented: Binding(get: { pendingPicker != nil }, set: { if !$0 { pendingPicker = nil } })) {
            if let requirementId = pendingPicker {
                DriverImagePicker { image in
                    uploadDocImage(image, requirementId: requirementId)
                }
            }
        }
    }

    private func requirementCard(_ req: [String: Any], requirementId: String, docType: String) -> some View {
        let urls = submissions[requirementId] ?? []
        return VStack(alignment: .leading, spacing: 10) {
            Text(label(for: docType))
                .font(.system(size: 16, weight: .semibold))
                .foregroundColor(AppTheme.secondaryDarkText)
            if let reason = req["request_reason"] as? String, !reason.isEmpty {
                Text(reason)
                    .font(.system(size: 12))
                    .foregroundColor(AppTheme.warningColor)
            }
            Text("\(urls.count) file(s) added")
                .font(.system(size: 12))
                .foregroundColor(AppTheme.secondaryDarkText.opacity(0.6))
            Button {
                pendingPicker = requirementId
            } label: {
                HStack {
                    Image(systemName: "plus.circle.fill")
                    Text("Add Photo")
                    Spacer()
                }
                .font(.system(size: 14, weight: .medium))
                .foregroundColor(AppTheme.primaryBrandGreen)
                .padding()
                .background(AppTheme.lightCardBackground)
                .cornerRadius(12)
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(AppTheme.softBorderColor))
            }
        }
        .padding()
        .background(Color.white)
        .cornerRadius(16)
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(AppTheme.softBorderColor, lineWidth: 1))
    }

    private func label(for docType: String) -> String {
        switch docType {
        case "license_photo_url": return "License (Front)"
        case "license_photo_back_url": return "License (Back)"
        case "insurance_photo_url": return "Insurance"
        case "registration_photo_url": return "Registration"
        case "inspection_photo_url": return "Vehicle Inspection"
        case "id_photo_front_url": return "ID Photo (Front)"
        case "id_photo_back_url": return "ID Photo (Back)"
        default: return docType
        }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        let all = (try? await UserService.getDocumentRequirements()) ?? []
        requirements = all.filter { req in
            (req["status"] as? String) == "resubmission_required"
                && (req["document_type"] as? String) != "inspection_photo_url"
        }
    }

    private func uploadDocImage(_ image: UIImage, requirementId: String) {
        guard let data = image.jpegData(compressionQuality: 0.7) else { return }
        Task {
            do {
                let url = try await AuthService.uploadImage(base64: data.base64EncodedString(), mimetype: "image/jpeg", filename: "doc.jpg")
                submissions[requirementId, default: []].append(url)
            } catch {
                errorMessage = ErrorHandler.message(for: error)
            }
        }
    }

    private func submitAll() {
        var batch: [[String: Any]] = []
        for (requirementId, urls) in submissions where !urls.isEmpty {
            batch.append(["requirementId": requirementId, "newDocumentUrls": urls])
        }
        guard !batch.isEmpty else { return }
        Task {
            do {
                try await UserService.batchResubmit(submissions: batch)
                success = true
                await driverProvider.refreshAll()
            } catch {
                errorMessage = ErrorHandler.message(for: error)
            }
        }
    }
}