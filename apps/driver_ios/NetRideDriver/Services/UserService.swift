import Foundation

/// Mirrors UserService in the driver app.
enum UserService {
    static func getProfile() async throws -> [String: Any] {
        let res = try await APIClient.request("GET", "driver/profile")
        return res as? [String: Any] ?? [:]
    }

    static func patchProfile(_ patch: [String: Any]) async throws -> [String: Any] {
        let res = try await APIClient.request("PATCH", "driver/profile", body: patch)
        return res as? [String: Any] ?? [:]
    }

    static func getVehicles() async throws -> [[String: Any]] {
        let res = try await APIClient.request("GET", "driver/vehicles")
        return res as? [[String: Any]] ?? []
    }

    static func submitProfileChange(changes: [String: Any], reason: String? = nil) async throws {
        var body: [String: Any] = ["changes": changes]
        if let reason { body["reason"] = reason }
        _ = try await APIClient.request("POST", "driver/profile-changes", body: body)
    }

    static func getCurrentProfileChange() async throws -> [String: Any]? {
        let res = try await APIClient.request("GET", "driver/profile-changes/current")
        return res as? [String: Any]
    }

    static func getWallet() async throws -> [String: Any] {
        let res = try await APIClient.request("GET", "driver/wallet")
        return res as? [String: Any] ?? [:]
    }

    static func addPayoutCard(cardNumber: String, expMonth: Int, expYear: Int, cardholderName: String, zip: String, cvc: String) async throws -> [String: Any] {
        let res = try await APIClient.request("POST", "driver/payout-cards", body: [
            "card_number": cardNumber,
            "exp_month": expMonth,
            "exp_year": expYear,
            "cardholder_name": cardholderName,
            "zip": zip,
            "cvc": cvc,
        ])
        return res as? [String: Any] ?? [:]
    }

    static func requestPayout(amountCents: Int) async throws -> [String: Any] {
        let res = try await APIClient.request("POST", "driver/wallet/request-payout", body: ["amount_cents": amountCents])
        return res as? [String: Any] ?? [:]
    }

    static func getPayouts(limit: Int = 20) async throws -> [[String: Any]] {
        let res = try await APIClient.request("GET", "driver/payouts", query: ["limit": "\(limit)"])
        let map = res as? [String: Any] ?? [:]
        return map["payouts"] as? [[String: Any]] ?? []
    }

    static func getDocumentRequirements() async throws -> [[String: Any]] {
        let res = try await APIClient.request("GET", "driver/documents/requirements")
        let map = res as? [String: Any] ?? [:]
        return map["requirements"] as? [[String: Any]] ?? []
    }

    static func batchResubmit(submissions: [[String: Any]]) async throws {
        _ = try await APIClient.request("POST", "driver/documents/batch-resubmit", body: ["submissions": submissions])
    }

    static func resubmitDocument(requirementId: String, newDocumentUrls: [String]) async throws {
        _ = try await APIClient.request("POST", "driver/documents/resubmit", body: [
            "requirementId": requirementId,
            "newDocumentUrls": newDocumentUrls,
        ])
    }

    static func submitVehicle(make: String, model: String, year: Int, color: String, interiorColor: String?,
                              licensePlateNumber: String, licensePlateState: String, zipCode: String,
                              registrationPhotoUrl: String, insurancePhotoUrl: String, inspectionPhotoUrl: String) async throws {
        var body: [String: Any] = [
            "make": make,
            "model": model,
            "year": year,
            "color": color,
            "license_plate_number": licensePlateNumber,
            "license_plate_state": licensePlateState,
            "zip_code": zipCode,
            "registration_photo_url": registrationPhotoUrl,
            "insurance_photo_url": insurancePhotoUrl,
            "inspection_photo_url": inspectionPhotoUrl,
        ]
        if let interiorColor { body["interior_color"] = interiorColor }
        _ = try await APIClient.request("POST", "driver/vehicles/submit", body: body)
    }

    static func verifyIdentity(licensePhotoUrl: String, licensePhotoBackUrl: String, dateOfBirth: String, licenseNumber: String?) async throws {
        var body: [String: Any] = [
            "license_photo_url": licensePhotoUrl,
            "license_photo_back_url": licensePhotoBackUrl,
            "date_of_birth": dateOfBirth,
        ]
        if let licenseNumber { body["license_number"] = licenseNumber }
        _ = try await APIClient.request("POST", "driver/verify-identity", body: body)
    }

    static func dismissVerificationFeedback() async throws {
        _ = try await APIClient.request("PATCH", "ride/verification/dismiss")
    }

    static func getInspectionLocations(zip: String) async throws -> [String: Any] {
        let res = try await APIClient.request("GET", "geospatial/inspection-locations", query: ["zip": zip])
        return res as? [String: Any] ?? [:]
    }

    static func rateRide(rideId: String, rating: Int, reviewText: String? = nil) async throws {
        var body: [String: Any] = ["ride_id": rideId, "rating": rating]
        if let reviewText { body["review_text"] = reviewText }
        _ = try await APIClient.request("POST", "ride/rate", body: body)
    }

    static func getRideHistory() async throws -> [[String: Any]] {
        let res = try await APIClient.request("GET", "ride/history")
        return res as? [[String: Any]] ?? []
    }

    static func deleteHistory(id: String) async throws {
        _ = try await APIClient.request("DELETE", "ride/history/\(id)")
    }
}

/// Onboarding-specific endpoints (mirrors onboarding calls).
enum OnboardingService {
    static func getProgress() async throws -> [String: Any] {
        let res = try await APIClient.request("GET", "driver/onboarding/progress")
        return res as? [String: Any] ?? [:]
    }

    static func saveStep(step: Int, data: [String: Any]) async throws {
        _ = try await APIClient.request("POST", "driver/onboarding/step", body: ["step": step, "data": data])
    }

    static func complete() async throws {
        _ = try await APIClient.request("POST", "driver/onboarding/complete")
    }

    static func getVehicleYears() async throws -> [Int] {
        let res = try await APIClient.request("GET", "driver/vehicle-models/years")
        return res as? [Int] ?? []
    }

    static func getVehicleMakes(year: Int) async throws -> [String] {
        let res = try await APIClient.request("GET", "driver/vehicle-models/makes", query: ["year": "\(year)"])
        return res as? [String] ?? []
    }

    static func getVehicleModels(make: String, year: Int) async throws -> [String] {
        let res = try await APIClient.request("GET", "driver/vehicle-models/models", query: ["make": make, "year": "\(year)"])
        return res as? [String] ?? []
    }
}