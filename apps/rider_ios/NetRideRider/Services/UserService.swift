import Foundation

/// Mirrors UserService in the rider app.
enum UserService {
    static func getProfile() async throws -> [String: Any] {
        let res = try await APIClient.request("GET", "user/profile")
        return res as? [String: Any] ?? [:]
    }

    static func updateProfile(_ patch: [String: Any]) async throws -> [String: Any] {
        let res = try await APIClient.request("PATCH", "user/profile", body: patch)
        return res as? [String: Any] ?? [:]
    }

    static func verifyIdentity(idPhotoFrontUrl: String, idPhotoBackUrl: String, dateOfBirth: String) async throws {
        _ = try await APIClient.request("POST", "user/verify-identity", body: [
            "id_photo_front_url": idPhotoFrontUrl,
            "id_photo_back_url": idPhotoBackUrl,
            "date_of_birth": dateOfBirth,
        ])
    }

    static func rateRide(rideId: String, rating: Int, reviewText: String? = nil, favorite: Bool = false) async throws {
        var body: [String: Any] = ["ride_id": rideId, "rating": rating, "favorite": favorite]
        if let reviewText { body["review_text"] = reviewText }
        _ = try await APIClient.request("POST", "ride/rate", body: body)
    }

    static func submitTip(rideId: String, amount: Double) async throws {
        _ = try await APIClient.request("POST", "ride/\(rideId)/tip", body: ["amount": amount])
    }

    static func getFavorites() async throws -> [FavoriteDriver] {
        let res = try await APIClient.request("GET", "user/favorites")
        let arr = res as? [[String: Any]] ?? []
        return arr.map { FavoriteDriver(json: $0) }
    }

    static func removeFavorite(driverId: String) async throws {
        _ = try await APIClient.request("DELETE", "user/favorites/\(driverId)")
    }
}