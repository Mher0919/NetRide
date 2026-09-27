import SwiftUI
import UIKit

/// 6-step onboarding (mirrors OnboardingScreen in the driver app).
struct OnboardingView: View {
    @EnvironmentObject var driverProvider: DriverProvider

    @State private var step = 0
    @State private var profileImageUrl: String?
    @State private var fullName = ""
    @State private var dateOfBirth = Date()
    @State private var phone = ""
    @State private var phoneCode = ""
    @State private var phoneStep: PhoneStep = .entry
    @State private var licenseFrontUrl: String?
    @State private var licenseBackUrl: String?
    @State private var insuranceUrl: String?
    @State private var registrationUrl: String?
    @State private var licensePlateNumber = ""
    @State private var licensePlateState = "CA"
    @State private var zipCode = ""
    @State private var make = ""
    @State private var model = ""
    @State private var year = 0
    @State private var color = ""
    @State private var years: [Int] = []
    @State private var makes: [String] = []
    @State private var models: [String] = []
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var showImagePicker = false

    enum PhoneStep { case entry, code }

    var body: some View {
        ZStack {
            AppTheme.primaryBackground.ignoresSafeArea()
            VStack(spacing: 0) {
                stepIndicator
                ScrollView {
                    VStack(spacing: 16) {
                        stepContent
                        if let errorMessage {
                            Text(errorMessage).font(.system(size: 13)).foregroundColor(AppTheme.errorColor)
                        }
                        AppButton(title: step == 5 ? "Submit Application" : "Continue",
                                  isEnabled: canContinue && !isLoading) {
                            next()
                        }
                    }
                    .padding(20)
                }
            }
        }
        .onAppear { Task { await loadInitial() } }
        .sheet(isPresented: $showImagePicker) {
            DriverImagePicker { image in
                handlePickedPhoto(image)
            }
        }
    }

    private var stepIndicator: some View {
        HStack(spacing: 6) {
            ForEach(0..<6, id: \.self) { idx in
                Capsule()
                    .fill(idx <= step ? AppTheme.primaryBrandGreen : AppTheme.softBorderColor)
                    .frame(height: 4)
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 12)
    }

    @ViewBuilder
    private var stepContent: some View {
        switch step {
        case 0: headshotStep
        case 1: personalInfoStep
        case 2: phoneStepView
        case 3: documentsStep
        case 4: vehicleStep
        default: reviewStep
        }
    }

    private var headshotStep: some View {
        VStack(spacing: 16) {
            Text("Headshot")
                .font(.system(size: 22, weight: .semibold))
                .foregroundColor(AppTheme.secondaryDarkText)
            Button {
                showImagePicker = true
            } label: {
                if let url = FileUrl.resolve(profileImageUrl) {
                    AsyncImage(url: URL(string: url)!) { phase in
                        if let image = phase.image {
                            image.resizable().scaledToFill().frame(width: 120, height: 120).clipShape(Circle())
                        } else {
                            placeholderPhoto
                        }
                    }
                } else {
                    placeholderPhoto
                }
            }
            Text("Take a clear photo of your face")
                .font(.system(size: 14))
                .foregroundColor(AppTheme.secondaryDarkText)
        }
        .padding(.top, 20)
    }

    private var placeholderPhoto: some View {
        ZStack {
            Circle().fill(AppTheme.lightCardBackground).frame(width: 120, height: 120)
            Image(systemName: "camera.fill")
                .font(.system(size: 34))
                .foregroundColor(AppTheme.primaryBrandGreen)
        }
    }

    private var personalInfoStep: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Personal Info")
                .font(.system(size: 22, weight: .semibold))
                .foregroundColor(AppTheme.secondaryDarkText)
            AppTextField(placeholder: "Full legal name", text: $fullName, textContentType: .name)
            DatePicker("Date of birth", selection: $dateOfBirth, in: ...Date(), displayedComponents: .date)
        }
        .padding(.top, 20)
    }

    private var phoneStepView: some View {
        VStack(spacing: 16) {
            Text("Phone Verification")
                .font(.system(size: 22, weight: .semibold))
                .foregroundColor(AppTheme.secondaryDarkText)
            switch phoneStep {
            case .entry:
                AppTextField(placeholder: "(555) 555-5555", text: $phone, keyboard: .phonePad, textContentType: .telephoneNumber)
                AppButton(title: "Send Code", isEnabled: PhoneUtils.normalizeUS(phone) != nil) { sendPhoneCode() }
            case .code:
                TextField("", text: $phoneCode)
                    .keyboardType(.numberPad)
                    .font(.system(size: 32, weight: .bold, design: .monospaced))
                    .multilineTextAlignment(.center)
                    .onChange(of: phoneCode) { newValue in
                        phoneCode = String(newValue.filter(\.isNumber).prefix(6))
                        if phoneCode.count == 6 { verifyPhoneCode() }
                    }
                    .frame(width: 220)
                    .padding()
                    .background(Color.white)
                    .cornerRadius(12)
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(AppTheme.softBorderColor))
            }
        }
        .padding(.top, 20)
    }

    private var documentsStep: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Identity Documents")
                .font(.system(size: 22, weight: .semibold))
                .foregroundColor(AppTheme.secondaryDarkText)
            docButton("License Photo (Front)", licenseFrontUrl != nil, .license)
            docButton("License Photo (Back)", licenseBackUrl != nil, .licenseBack)
            docButton("Insurance", insuranceUrl != nil, .insurance)
            docButton("Registration", registrationUrl != nil, .registration)
        }
        .padding(.top, 20)
    }

    private var vehicleStep: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Vehicle Info")
                .font(.system(size: 22, weight: .semibold))
                .foregroundColor(AppTheme.secondaryDarkText)
            Picker("Year", selection: $year) {
                Text("Select year").tag(0)
                ForEach(years, id: \.self) { y in Text("\(y)").tag(y) }
            }
            .pickerStyle(.menu)
            AppTextField(placeholder: "Make", text: $make)
            AppTextField(placeholder: "Model", text: $model)
            AppTextField(placeholder: "Color", text: $color)
            AppTextField(placeholder: "License plate", text: $licensePlateNumber)
            AppTextField(placeholder: "ZIP code", text: $zipCode, keyboard: .numberPad)
        }
        .padding(.top, 20)
    }

    private var reviewStep: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Review & Submit")
                .font(.system(size: 22, weight: .semibold))
                .foregroundColor(AppTheme.secondaryDarkText)
            reviewRow("Name", fullName)
            reviewRow("Vehicle", "\(year) \(make) \(model)")
            reviewRow("Plate", licensePlateNumber)
            reviewRow("Phone", PhoneUtils.format(phone))
            reviewRow("Photos", docsComplete ? "All uploaded" : "Incomplete")
        }
        .padding(.top, 20)
    }

    private func docButton(_ title: String, _ done: Bool, _ type: DocType) -> some View {
        Button {
            pickDocument(type)
        } label: {
            HStack {
                Image(systemName: done ? "checkmark.circle.fill" : "doc.fill")
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

    private func reviewRow(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).font(.system(size: 14, weight: .medium)).foregroundColor(AppTheme.secondaryDarkText.opacity(0.6))
            Spacer()
            Text(value).font(.system(size: 14)).foregroundColor(AppTheme.secondaryDarkText)
        }
    }

    private enum DocType { case license, licenseBack, insurance, registration }

    private var canContinue: Bool {
        switch step {
        case 0: return profileImageUrl != nil
        case 1: return fullName.count >= 2
        case 2: return phoneStep == .code
        case 3: return docsComplete
        case 4: return year > 0 && !make.isEmpty && !model.isEmpty && !color.isEmpty
            && !licensePlateNumber.isEmpty && !zipCode.isEmpty
        default: return true
        }
    }

    private var docsComplete: Bool {
        licenseFrontUrl != nil && licenseBackUrl != nil && insuranceUrl != nil && registrationUrl != nil
    }

    private func loadInitial() async {
        isLoading = true
        do {
            async let years = OnboardingService.getVehicleYears()
            async let progress = OnboardingService.getProgress()
            let (y, p) = try await (years, progress)
            self.years = y
            if let step = p["onboarding_step"] as? Int, step >= 5 {
                AppRouter.shared.replaceWith(.main)
            }
            fullName = p["full_name"] as? String ?? ""
            profileImageUrl = p["profile_image_url"] as? String
            if let dob = p["date_of_birth"] as? String {
                let formatter = ISO8601DateFormatter()
                formatter.formatOptions = [.withFullDate]
                if let d = formatter.date(from: dob) { dateOfBirth = d }
            }
            phone = p["phone_number"] as? String ?? ""
            if p["phone_verified"] as? Bool == true {
                phoneStep = .code
            }
        } catch {
            errorMessage = ErrorHandler.message(for: error)
        }
        isLoading = false
    }

    private func next() {
        isLoading = true
        errorMessage = nil
        Task {
            do {
                switch step {
                case 0:
                    try await OnboardingService.saveStep(step: 0, data: ["profile_image_url": profileImageUrl ?? ""])
                case 1:
                    let formatter = DateFormatter()
                    formatter.dateFormat = "yyyy-MM-dd"
                    try await OnboardingService.saveStep(step: 1, data: [
                        "full_name": fullName,
                        "date_of_birth": formatter.string(from: dateOfBirth),
                    ])
                case 3:
                    try await OnboardingService.saveStep(step: 3, data: [
                        "license_photo_url": licenseFrontUrl ?? "",
                        "license_photo_back_url": licenseBackUrl ?? "",
                        "insurance_photo_url": insuranceUrl ?? "",
                        "registration_photo_url": registrationUrl ?? "",
                    ])
                case 4:
                    try await OnboardingService.saveStep(step: 4, data: [
                        "license_plate_number": licensePlateNumber,
                        "license_plate_state": licensePlateState,
                        "zip_code": zipCode,
                        "make": make,
                        "model": model,
                        "year": year,
                        "color": color,
                    ])
                case 5:
                    try await OnboardingService.complete()
                    AppRouter.shared.replaceWith(.main)
                    return
                default:
                    break
                }
                if step < 5 { step += 1 }
            } catch {
                errorMessage = ErrorHandler.message(for: error)
            }
            isLoading = false
        }
    }

    private func sendPhoneCode() {
        guard let normalized = PhoneUtils.normalizeUS(phone) else { return }
        isLoading = true
        Task {
            do {
                let auto = try await AuthService.requestPhoneOTP(phone: normalized, role: "DRIVER")
                if auto {
                    phoneStep = .code
                } else {
                    phoneStep = .code
                }
            } catch {
                errorMessage = ErrorHandler.message(for: error)
            }
            isLoading = false
        }
    }

    private func verifyPhoneCode() {
        guard let normalized = PhoneUtils.normalizeUS(phone) else { return }
        isLoading = true
        Task {
            do {
                try await AuthService.verifyPhoneOTP(phone: normalized, code: phoneCode, role: "DRIVER")
            } catch {
                errorMessage = ErrorHandler.message(for: error)
            }
            isLoading = false
        }
    }

    private func handlePickedPhoto(_ image: UIImage) {
        guard let data = image.jpegData(compressionQuality: 0.7) else { return }
        Task {
            do {
                let url = try await AuthService.uploadImage(base64: data.base64EncodedString(), mimetype: "image/jpeg", filename: "upload.jpg")
                switch pendingDocType {
                case .license: licenseFrontUrl = url
                case .licenseBack: licenseBackUrl = url
                case .insurance: insuranceUrl = url
                case .registration: registrationUrl = url
                case nil: profileImageUrl = url
                }
            } catch {
                errorMessage = ErrorHandler.message(for: error)
            }
        }
    }

    @State private var pendingDocType: DocType?

    private func pickDocument(_ type: DocType) {
        pendingDocType = type
        showImagePicker = true
    }
}

struct DriverImagePicker: UIViewControllerRepresentable {
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
        var parent: DriverImagePicker
        init(_ parent: DriverImagePicker) { self.parent = parent }
        func imagePickerController(_ picker: UIImagePickerController,
                                   didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage {
                parent.onPicked(image)
            }
            parent.dismiss()
        }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.dismiss()
        }
    }
}

struct SuccessView: View {
    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "checkmark.seal.fill")
                .font(.system(size: 56))
                .foregroundColor(AppTheme.successGreen)
            Text("Application Submitted!")
                .font(.system(size: 24, weight: .semibold))
                .foregroundColor(AppTheme.secondaryDarkText)
            Text("We'll review your application and get back to you.")
                .font(.system(size: 14))
                .foregroundColor(AppTheme.secondaryDarkText)
            AppButton(title: "Continue") {
                AppRouter.shared.replaceWith(.main)
            }
            .padding(.top, 12)
        }
        .padding(24)
    }
}