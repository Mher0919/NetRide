import SwiftUI
import UIKit

/// Replace vehicle (mirrors ReplaceVehicleScreen).
struct ReplaceVehicleView: View {
    @EnvironmentObject var driverProvider: DriverProvider
    @State private var year = 0
    @State private var make = ""
    @State private var model = ""
    @State private var color = ""
    @State private var interiorColor = ""
    @State private var licensePlateNumber = ""
    @State private var licensePlateState = "CA"
    @State private var zipCode = ""
    @State private var years: [Int] = []
    @State private var makes: [String] = []
    @State private var models: [String] = []
    @State private var registrationUrl: String?
    @State private var insuranceUrl: String?
    @State private var inspectionUrl: String?
    @State private var pendingPicker: PickerTarget?
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var success = false

    enum PickerTarget { case registration, insurance, inspection }

    let states = ["AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY"]

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
                        Text("Vehicle submitted for review!")
                            .font(.system(size: 22, weight: .semibold))
                        AppButton(title: "Done") {
                            AppRouter.shared.pop()
                        }
                    }
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 14) {
                            Text("Replace Vehicle")
                                .font(.system(size: 24, weight: .semibold))
                                .foregroundColor(AppTheme.secondaryDarkText)

                            Picker("Year", selection: $year) {
                                Text("Select year").tag(0)
                                ForEach(years, id: \.self) { y in Text("\(y)").tag(y) }
                            }
                            .pickerStyle(.menu)
                            AppTextField(placeholder: "Make", text: $make)
                            AppTextField(placeholder: "Model", text: $model)
                            AppTextField(placeholder: "Color", text: $color)
                            AppTextField(placeholder: "Interior color (optional)", text: $interiorColor)
                            HStack {
                                AppTextField(placeholder: "Plate number", text: $licensePlateNumber)
                                Picker("State", selection: $licensePlateState) {
                                    ForEach(states, id: \.self) { Text($0).tag($0) }
                                }
                                .pickerStyle(.menu)
                                .frame(width: 90)
                            }
                            AppTextField(placeholder: "ZIP code", text: $zipCode, keyboard: .numberPad)

                            photoTile("Registration Photo", registrationUrl != nil) { pendingPicker = .registration }
                            photoTile("Insurance Photo", insuranceUrl != nil) { pendingPicker = .insurance }
                            photoTile("Inspection Photo", inspectionUrl != nil) { pendingPicker = .inspection }

                            if let errorMessage {
                                Text(errorMessage).font(.system(size: 13)).foregroundColor(AppTheme.errorColor)
                            }

                            AppButton(title: "Submit Vehicle", isEnabled: valid) {
                                submit()
                            }
                        }
                        .padding()
                    }
                }
            }
        }
        .navigationTitle("Replace Vehicle")
        .onAppear { Task { await load() } }
        .sheet(isPresented: Binding(get: { pendingPicker != nil }, set: { if !$0 { pendingPicker = nil } })) {
            DriverImagePicker { image in
                handlePhoto(image)
            }
        }
    }

    private var valid: Bool {
        year > 0 && !make.isEmpty && !model.isEmpty && !color.isEmpty
            && !licensePlateNumber.isEmpty && !zipCode.isEmpty
            && registrationUrl != nil && insuranceUrl != nil && inspectionUrl != nil
    }

    private func photoTile(_ title: String, _ done: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                Image(systemName: done ? "checkmark.circle.fill" : "camera.fill")
                Text(done ? "\(title) ✓" : title)
                Spacer()
            }
            .foregroundColor(AppTheme.secondaryDarkText)
            .padding()
            .background(AppTheme.lightCardBackground)
            .cornerRadius(12)
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(AppTheme.softBorderColor))
        }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        years = (try? await OnboardingService.getVehicleYears()) ?? []
        if let profile = try? await UserService.getProfile() {
            if let vehicle = profile["active_vehicle"] as? [String: Any] {
                year = (vehicle["year"] as? Int) ?? 0
                make = (vehicle["make"] as? String) ?? ""
                model = (vehicle["model"] as? String) ?? ""
                color = (vehicle["color"] as? String) ?? ""
                interiorColor = (vehicle["interior_color"] as? String) ?? ""
                licensePlateNumber = (vehicle["license_plate_number"] as? String) ?? ""
                licensePlateState = (vehicle["license_plate_state"] as? String) ?? "CA"
                zipCode = (vehicle["zip_code"] as? String) ?? ""
            }
        }
    }

    private func handlePhoto(_ image: UIImage) {
        guard let data = image.jpegData(compressionQuality: 0.7) else { return }
        Task {
            do {
                let url = try await AuthService.uploadImage(base64: data.base64EncodedString(), mimetype: "image/jpeg", filename: "vehicle.jpg")
                switch pendingPicker {
                case .registration: registrationUrl = url
                case .insurance: insuranceUrl = url
                case .inspection: inspectionUrl = url
                case nil: break
                }
            } catch {
                errorMessage = ErrorHandler.message(for: error)
            }
        }
    }

    private func submit() {
        Task {
            do {
                try await UserService.submitVehicle(
                    make: make, model: model, year: year, color: color,
                    interiorColor: interiorColor.isEmpty ? nil : interiorColor,
                    licensePlateNumber: licensePlateNumber,
                    licensePlateState: licensePlateState,
                    zipCode: zipCode,
                    registrationPhotoUrl: registrationUrl ?? "",
                    insurancePhotoUrl: insuranceUrl ?? "",
                    inspectionPhotoUrl: inspectionUrl ?? ""
                )
                await driverProvider.refreshAll()
                success = true
            } catch {
                errorMessage = ErrorHandler.message(for: error)
            }
        }
    }
}