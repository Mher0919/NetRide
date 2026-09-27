import SwiftUI

/// Trip history with earnings summary (mirrors ActivityScreen in the driver app).
struct DriverActivityView: View {
    @State private var trips: [[String: Any]] = []
    @State private var isLoading = true
    @State private var showReport = false
    @State private var reportRideId: String?

    var body: some View {
        NavigationStack {
            Group {
                if isLoading {
                    ProgressView()
                } else {
                    List {
                        Section {
                            let total = totalEarnings
                            HStack {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text("Total Earnings")
                                        .font(.system(size: 13, weight: .medium))
                                        .foregroundColor(AppTheme.primaryBackground)
                                    Text("$\(total, specifier: "%.2f")")
                                        .font(.system(size: 28, weight: .bold))
                                        .foregroundColor(.white)
                                }
                                Spacer()
                            }
                            .padding()
                            .background(AppTheme.secondaryDarkText)
                            .cornerRadius(14)
                        }
                        .listRowBackground(Color.clear)

                        ForEach(trips.indices, id: \.self) { idx in
                            tripCard(trips[idx])
                        }
                    }
                    .refreshable { await load() }
                }
            }
            .navigationTitle("Activity")
        }
        .onAppear { Task { await load() } }
        .sheet(isPresented: $showReport) {
            if let reportRideId {
                DriverReportView(rideId: reportRideId)
            }
        }
    }

    private var totalEarnings: Double {
        trips.filter { ($0["status"] as? String) == "COMPLETED" }
            .reduce(0) { acc, trip in
                acc + ((trip["fare_amount"] as? Double) ?? 0) + ((trip["tip_amount"] as? Double) ?? 0)
            }
    }

    private func tripCard(_ trip: [String: Any]) -> some View {
        let id = (trip["id"] as? String) ?? ""
        let status = (trip["status"] as? String) ?? ""
        let fare = (trip["fare_amount"] as? Double) ?? (trip["estimated_fare"] as? Double)
        let pickup = (trip["pickup"] as? [String: Any])?["address"] as? String ?? (trip["pickup_address"] as? String) ?? "Pickup"
        let destination = (trip["destination"] as? [String: Any])?["address"] as? String ?? (trip["destination_address"] as? String) ?? "Destination"
        let rating = trip["rating"] as? Int ?? 0
        let date = (trip["requested_at"] as? String) ?? (trip["created_at"] as? String) ?? ""

        return HStack(alignment: .top, spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(status.uppercased())
                        .font(.system(size: 12, weight: .bold))
                        .foregroundColor(statusColor(status))
                    Spacer()
                    if let fare {
                        Text(String(format: "$%.2f", fare))
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundColor(fareColor(status))
                    }
                }
                Text(date)
                    .font(.system(size: 12))
                    .foregroundColor(AppTheme.secondaryDarkText.opacity(0.6))
                Text(pickup).font(.system(size: 14)).foregroundColor(AppTheme.secondaryDarkText)
                Text(destination).font(.system(size: 14)).foregroundColor(AppTheme.secondaryDarkText)
                if rating > 0 {
                    HStack(spacing: 2) {
                        Image(systemName: "star.fill")
                            .font(.system(size: 11))
                            .foregroundColor(AppTheme.warningColor)
                        Text("\(rating)")
                            .font(.system(size: 12))
                            .foregroundColor(AppTheme.secondaryDarkText)
                    }
                }
                if status == "CANCELLED" || status == "COMPLETED" {
                    Button("Report an issue") {
                        reportRideId = id
                        showReport = true
                    }
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(AppTheme.errorColor)
                    .padding(.top, 4)
                }
            }
        }
        .padding(.vertical, 6)
        .swipeActions {
            Button(role: .destructive) {
                Task {
                    try? await UserService.deleteHistory(id: id)
                    await load()
                }
            } label: {
                Label("Delete", systemImage: "trash")
            }
        }
    }

    private func statusColor(_ status: String) -> Color {
        switch status {
        case "COMPLETED": return AppTheme.successGreen
        case "CANCELLED": return AppTheme.errorColor
        default: return AppTheme.secondaryDarkText
        }
    }

    private func fareColor(_ status: String) -> Color {
        status == "COMPLETED" ? AppTheme.secondaryDarkText : AppTheme.secondaryDarkText.opacity(0.6)
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        trips = (try? await UserService.getRideHistory()) ?? []
    }
}

/// Report sheet for the driver app.
struct DriverReportView: View {
    var rideId: String
    @State private var reasons: [(code: String, label: String)] = []
    @State private var selectedReason: String?
    @State private var description = ""
    @State private var canReport = false
    @State private var alreadyReported = false
    @State private var reportedUser: String?
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var submitted = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                if isLoading {
                    Spacer(); ProgressView(); Spacer()
                } else if alreadyReported {
                    Spacer()
                    Image(systemName: "checkmark.seal.fill").font(.system(size: 48)).foregroundColor(AppTheme.successGreen)
                    Text("Report submitted").font(.system(size: 20, weight: .semibold))
                    Spacer()
                } else if canReport {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 14) {
                            Text("Report \(reportedUser ?? "your rider")")
                                .font(.system(size: 20, weight: .semibold))
                            ForEach(reasons, id: \.code) { reason in
                                Button {
                                    selectedReason = reason.code
                                } label: {
                                    HStack {
                                        Text(reason.label).foregroundColor(AppTheme.secondaryDarkText)
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
                            AppButton(title: "Submit Report", isEnabled: selectedReason != nil && description.count >= 10) {
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