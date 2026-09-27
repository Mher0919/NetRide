import SwiftUI

/// Trip history (mirrors ActivityScreen in the rider app).
struct ActivityView: View {
    @State private var trips: [[String: Any]] = []
    @State private var isLoading = true
    @State private var showReport = false
    @State private var reportRideId: String?

    var body: some View {
        NavigationStack {
            Group {
                if isLoading {
                    ProgressView()
                } else if trips.isEmpty {
                    VStack(spacing: 12) {
                        Image(systemName: "clock.arrow.circlepath")
                            .font(.system(size: 44))
                            .foregroundColor(AppTheme.softBorderColor)
                        Text("No trips yet")
                            .font(.system(size: 18, weight: .semibold))
                            .foregroundColor(AppTheme.secondaryDarkText)
                        Text("Your ride history will appear here.")
                            .font(.system(size: 14))
                            .foregroundColor(AppTheme.secondaryDarkText.opacity(0.6))
                    }
                } else {
                    List {
                        ForEach(trips.indices, id: \.self) { idx in
                            tripCard(trips[idx])
                        }
                    }
                    .listStyle(.plain)
                    .refreshable { await load() }
                }
            }
            .navigationTitle("Activity")
        }
        .onAppear { Task { await load() } }
        .sheet(isPresented: $showReport) {
            if let reportRideId {
                ReportSheetView(rideId: reportRideId)
            }
        }
    }

    private func tripCard(_ trip: [String: Any]) -> some View {
        let id = (trip["id"] as? String) ?? ""
        let status = (trip["status"] as? String) ?? ""
        let fare = (trip["fare_amount"] as? Double) ?? (trip["estimated_fare"] as? Double)
        let pickup = (trip["pickup"] as? [String: Any])?["address"] as? String ?? (trip["pickup_address"] as? String) ?? "Pickup"
        let destination = (trip["destination"] as? [String: Any])?["address"] as? String ?? (trip["destination_address"] as? String) ?? "Destination"
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
                            .foregroundColor(AppTheme.secondaryDarkText)
                    }
                }
                Text(date)
                    .font(.system(size: 12))
                    .foregroundColor(AppTheme.secondaryDarkText.opacity(0.6))
                Text(pickup)
                    .font(.system(size: 14))
                    .foregroundColor(AppTheme.secondaryDarkText)
                Text(destination)
                    .font(.system(size: 14))
                    .foregroundColor(AppTheme.secondaryDarkText)
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
                deleteTrip(id)
            } label: {
                Label("Delete", systemImage: "trash")
            }
        }
    }

    private func statusColor(_ status: String) -> Color {
        switch status {
        case "COMPLETED": return AppTheme.successGreen
        case "CANCELLED": return AppTheme.errorColor
        case "IN_PROGRESS", "ACCEPTED": return AppTheme.warningColor
        default: return AppTheme.secondaryDarkText
        }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let res = try await APIClient.request("GET", "ride/history")
            trips = res as? [[String: Any]] ?? []
        } catch {
            trips = []
        }
    }

    private func deleteTrip(_ id: String) {
        Task {
            try? await APIClient.request("DELETE", "ride/history/\(id)")
            await load()
        }
    }
}