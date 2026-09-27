import SwiftUI
import UIKit

/// Vehicle inspection (mirrors VehicleInspectionScreen).
struct VehicleInspectionView: View {
    @EnvironmentObject var driverProvider: DriverProvider
    @State private var zip = ""
    @State private var stations: [[String: Any]] = []
    @State private var photos: [String] = []
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var success = false
    @State private var requirementId: String?

    private let maxImages = 3

    var body: some View {
        ZStack {
            AppTheme.primaryBackground.ignoresSafeArea()
            Group {
                if success {
                    VStack(spacing: 16) {
                        Image(systemName: "checkmark.seal.fill")
                            .font(.system(size: 52))
                            .foregroundColor(AppTheme.successGreen)
                        Text("Inspection submitted!")
                            .font(.system(size: 22, weight: .semibold))
                        AppButton(title: "Done") { AppRouter.shared.pop() }
                    }
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 16) {
                            Text("Vehicle Inspection")
                                .font(.system(size: 24, weight: .semibold))
                                .foregroundColor(AppTheme.secondaryDarkText)

                            AppTextField(placeholder: "California ZIP code", text: $zip, keyboard: .numberPad)
                            AppButton(title: "Find Inspection Stations", style: .outlined, isEnabled: isValidZip) {
                                searchStations()
                            }

                            if !stations.isEmpty {
                                VStack(alignment: .leading, spacing: 10) {
                                    Text("\(stations.count) stations nearby")
                                        .font(.system(size: 15, weight: .semibold))
                                        .foregroundColor(AppTheme.secondaryDarkText)
                                    ForEach(stations.indices, id: \.self) { idx in
                                        stationCard(stations[idx])
                                    }
                                }
                            }

                            Divider()
                            Text("Upload up to 3 inspection photos")
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundColor(AppTheme.secondaryDarkText)

                            HStack(spacing: 10) {
                                ForEach(0..<maxImages, id: \.self) { idx in
                                    Button {
                                        addPhoto()
                                    } label: {
                                        if photos.indices.contains(idx) {
                                            Image(systemName: "checkmark.circle.fill")
                                                .font(.system(size: 28))
                                                .foregroundColor(AppTheme.successGreen)
                                        } else {
                                            Image(systemName: "camera.fill")
                                                .font(.system(size: 22))
                                                .foregroundColor(AppTheme.primaryBrandGreen)
                                        }
                                    }
                                    .frame(maxWidth: .infinity)
                                    .frame(height: 70)
                                    .background(AppTheme.lightCardBackground)
                                    .cornerRadius(12)
                                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(AppTheme.softBorderColor))
                                }
                            }
                            Text("\(photos.count)/\(maxImages) uploaded")
                                .font(.system(size: 12))
                                .foregroundColor(AppTheme.secondaryDarkText.opacity(0.6))

                            if let errorMessage {
                                Text(errorMessage).font(.system(size: 13)).foregroundColor(AppTheme.errorColor)
                            }

                            AppButton(title: "Submit Inspection", isEnabled: !photos.isEmpty) {
                                submit()
                            }
                        }
                        .padding()
                    }
                }
            }
        }
        .navigationTitle("Inspection")
        .onAppear { Task { await loadRequirement() } }
        .sheet(isPresented: $showPicker) {
            DriverImagePicker { image in
                uploadPhoto(image)
            }
        }
    }

    @State private var showPicker = false

    private var isValidZip: Bool {
        let digits = zip.filter(\.isNumber)
        guard digits.count == 5, let value = Int(digits) else { return false }
        return (90000...96199).contains(value)
    }

    private func stationCard(_ station: [String: Any]) -> some View {
        let name = (station["display_name"] as? String) ?? "Inspection Station"
        let address = station["address"] as? [String: Any] ?? [:]
        let street = (address["house_number"] as? String ?? "") + " " + (address["road"] as? String ?? "")
        let city = (address["city"] as? String) ?? ""
        let state = (address["state"] as? String) ?? ""
        let distance = (station["distance_miles"] as? Double) ?? 0
        let lat = (station["lat"] as? Double) ?? 0
        let lng = (station["lon"] as? Double) ?? 0

        return VStack(alignment: .leading, spacing: 6) {
            Text(name)
                .font(.system(size: 15, weight: .semibold))
                .foregroundColor(AppTheme.secondaryDarkText)
            Text("\(street), \(city), \(state) · \(String(format: "%.1f", distance)) mi")
                .font(.system(size: 13))
                .foregroundColor(AppTheme.secondaryDarkText.opacity(0.7))
            Button("Get Directions") {
                let url = URL(string: "https://www.google.com/maps/dir/?api=1&destination=\(lat),\(lng)&travelmode=driving")!
                UIApplication.shared.open(url)
            }
            .font(.system(size: 13, weight: .semibold))
            .foregroundColor(AppTheme.primaryBrandGreen)
        }
        .padding()
        .background(Color.white)
        .cornerRadius(14)
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(AppTheme.softBorderColor, lineWidth: 1))
    }

    private func loadRequirement() async {
        let all = (try? await UserService.getDocumentRequirements()) ?? []
        for req in all where (req["document_type"] as? String) == "inspection_photo_url" {
            requirementId = req["id"] as? String
            break
        }
    }

    private func searchStations() {
        isLoading = true
        errorMessage = nil
        Task {
            do {
                let res = try await UserService.getInspectionLocations(zip: zip)
                stations = res["stations"] as? [[String: Any]] ?? []
                if stations.isEmpty { errorMessage = "No stations found for that ZIP." }
            } catch {
                errorMessage = ErrorHandler.message(for: error)
            }
            isLoading = false
        }
    }

    private func addPhoto() {
        guard photos.count < maxImages else {
            errorMessage = "Maximum of \(maxImages) photos."
            return
        }
        showPicker = true
    }

    private func uploadPhoto(_ image: UIImage) {
        guard let data = image.jpegData(compressionQuality: 0.7) else { return }
        Task {
            do {
                let url = try await AuthService.uploadImage(base64: data.base64EncodedString(), mimetype: "image/jpeg", filename: "inspection.jpg")
                photos.append(url)
            } catch {
                errorMessage = ErrorHandler.message(for: error)
            }
        }
    }

    private func submit() {
        guard let requirementId else {
            errorMessage = "No inspection requirement found."
            return
        }
        Task {
            do {
                try await UserService.resubmitDocument(requirementId: requirementId, newDocumentUrls: photos)
                await driverProvider.refreshAll()
                success = true
            } catch {
                errorMessage = ErrorHandler.message(for: error)
            }
        }
    }
}