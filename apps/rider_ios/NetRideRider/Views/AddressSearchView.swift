import SwiftUI
import Combine

/// Address search-as-you-type with recent destinations (mirrors AddressSearchDelegate).
struct AddressSearchView: View {
    var isPickup: Bool
    var onSelect: (SearchResult) -> Void

    @State private var query = ""
    @State private var results: [SearchResult] = []
    @State private var recent: [SearchResult] = []
    @State private var loading = false
    @State private var debounceTask: Task<Void, Never>?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                HStack(spacing: 10) {
                    Image(systemName: "magnifyingglass")
                        .foregroundColor(AppTheme.softBorderColor)
                    TextField("Search California", text: $query)
                        .font(.system(size: 16))
                        .autocorrectionDisabled()
                        .onChange(of: query) { _ in onQueryChange() }
                    if !query.isEmpty {
                        Button {
                            query = ""
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .foregroundColor(AppTheme.softBorderColor)
                        }
                    }
                }
                .padding(14)
                .background(Color.white)
                .cornerRadius(12)
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(AppTheme.softBorderColor))
                .padding(.horizontal, 16)
                .padding(.vertical, 12)

                List {
                    if query.count < 3 {
                        Section("Recent") {
                            ForEach(recent) { result in
                                resultRow(result)
                            }
                        }
                    } else {
                        Section {
                            ForEach(results) { result in
                                resultRow(result)
                            }
                        }
                        if loading {
                            HStack { Spacer(); ProgressView(); Spacer() }
                        }
                        if !loading && results.isEmpty {
                            VStack(spacing: 6) {
                                Text("No results found")
                                    .font(.system(size: 15, weight: .medium))
                                    .foregroundColor(AppTheme.secondaryDarkText)
                                Text("NetRide only operates in California right now.")
                                    .font(.system(size: 13))
                                    .foregroundColor(AppTheme.secondaryDarkText.opacity(0.6))
                            }
                            .padding(.vertical, 30)
                        }
                    }
                }
                .listStyle(.plain)
            }
            .background(AppTheme.primaryBackground)
            .navigationTitle(isPickup ? "Set Pickup" : "Choose Destination")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .onAppear {
            Task {
                recent = (try? await SearchHistoryService.instance.fetch()) ?? []
            }
        }
    }

    private func resultRow(_ result: SearchResult) -> some View {
        Button {
            onSelect(result)
            dismiss()
        } label: {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(result.displayName)
                        .font(.system(size: 15, weight: .medium))
                        .foregroundColor(AppTheme.secondaryDarkText)
                        .lineLimit(1)
                    HStack(spacing: 6) {
                        Text("CA")
                            .font(.system(size: 11, weight: .semibold))
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(AppTheme.primaryBrandGreen.opacity(0.15))
                            .cornerRadius(4)
                        if let distance = result.distanceMiles {
                            Text(String(format: "%.1f mi", distance))
                                .font(.system(size: 12))
                                .foregroundColor(AppTheme.secondaryDarkText.opacity(0.6))
                        }
                        if let eta = result.etaMinutes {
                            Text("· \(Int(eta)) min")
                                .font(.system(size: 12))
                                .foregroundColor(AppTheme.secondaryDarkText.opacity(0.6))
                        }
                    }
                }
                Spacer()
                Image(systemName: "arrow.up.left")
                    .font(.system(size: 12))
                    .foregroundColor(AppTheme.softBorderColor)
            }
        }
    }

    private func onQueryChange() {
        debounceTask?.cancel()
        guard query.trimmingCharacters(in: .whitespaces).count >= 3 else {
            results = []
            return
        }
        debounceTask = Task {
            try? await Task.sleep(nanoseconds: 400_000_000)
            guard !Task.isCancelled else { return }
            let trimmed = query.trimmingCharacters(in: .whitespaces)
            guard trimmed.count >= 3 else { return }
            loading = true
            defer { loading = false }
            do {
                results = try await SearchService.search(query: trimmed, lat: nil, lon: nil)
            } catch {
                results = []
            }
        }
    }
}