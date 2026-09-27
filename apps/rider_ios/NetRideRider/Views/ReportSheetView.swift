import SwiftUI

/// Report sheet for terminal rides (mirrors ReportSheet).
struct ReportSheetView: View {
    var rideId: String
    @State private var reasons: [(code: String, label: String)] = []
    @State private var selectedReason: String?
    @State private var description = ""
    @State private var canReport = false
    @State private var alreadyReported = false
    @State private var reportedStatus: String?
    @State private var reportedUser: String?
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var submitted = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                if isLoading {
                    Spacer()
                    ProgressView()
                    Spacer()
                } else if alreadyReported {
                    Spacer()
                    Image(systemName: "checkmark.seal.fill")
                        .font(.system(size: 48))
                        .foregroundColor(AppTheme.successGreen)
                    Text("Report submitted")
                        .font(.system(size: 20, weight: .semibold))
                    if let status = reportedStatus {
                        Text("Status: \(status)")
                            .font(.system(size: 14))
                            .foregroundColor(AppTheme.secondaryDarkText)
                    }
                    Spacer()
                } else if canReport {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 14) {
                            Text("Report \(reportedUser ?? "your driver")")
                                .font(.system(size: 20, weight: .semibold))
                            ForEach(reasons, id: \.code) { reason in
                                Button {
                                    selectedReason = reason.code
                                } label: {
                                    HStack {
                                        Text(reason.label)
                                            .foregroundColor(AppTheme.secondaryDarkText)
                                        Spacer()
                                        Image(systemName: selectedReason == reason.code ? "largecircle.fill.circle" : "circle")
                                            .foregroundColor(selectedReason == reason.code ? AppTheme.primaryBrandGreen : AppTheme.softBorderColor)
                                    }
                                    .padding()
                                    .background(AppTheme.lightCardBackground)
                                    .cornerRadius(12)
                                }
                            }
                            TextField("Tell us more (at least 10 characters)", text: $description, axis: .vertical)
                                .lineLimit(3...6)
                                .padding(12)
                                .background(AppTheme.lightCardBackground)
                                .cornerRadius(12)
                            if let errorMessage {
                                Text(errorMessage).font(.system(size: 13)).foregroundColor(AppTheme.errorColor)
                            }
                            AppButton(
                                title: "Submit Report",
                                isEnabled: selectedReason != nil && description.count >= 10
                            ) {
                                submit()
                            }
                        }
                        .padding()
                    }
                } else {
                    Spacer()
                    Text("This ride can't be reported right now.")
                        .font(.system(size: 15))
                        .foregroundColor(AppTheme.secondaryDarkText)
                    Spacer()
                }
            }
            .navigationTitle("Report an Issue")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
        }
        .onAppear { load() }
        .alert("Report submitted", isPresented: $submitted) {
            Button("OK") { dismiss() }
        }
    }

    private func load() {
        Task {
            do {
                let res = try await APIClient.request("GET", "ride/\(rideId)/report")
                let map = res as? [String: Any] ?? [:]
                canReport = map["canReport"] as? Bool ?? false
                alreadyReported = map["alreadyReported"] as? Bool ?? false
                let report = map["report"] as? [String: Any]
                reportedStatus = report?["status"] as? String
                let user = map["reported_user"] as? [String: Any]
                reportedUser = user?["full_name"] as? String
                let raw = map["reasons"] as? [[String: Any]] ?? []
                reasons = raw.compactMap { item in
                    guard let code = item["code"] as? String, let label = item["label"] as? String else { return nil }
                    return (code, label)
                }
            } catch {
                errorMessage = ErrorHandler.message(for: error)
            }
            isLoading = false
        }
    }

    private func submit() {
        guard let reasonCode = selectedReason else { return }
        Task {
            do {
                var body: [String: Any] = ["reason_code": reasonCode, "description": description]
                if reasonCode == "other" { body["reason_text"] = description }
                _ = try await APIClient.request("POST", "ride/\(rideId)/report", body: body)
                submitted = true
            } catch {
                errorMessage = ErrorHandler.message(for: error)
            }
        }
    }
}