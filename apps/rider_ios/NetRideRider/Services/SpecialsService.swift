import Foundation

/// Mirrors SpecialsService in the rider app.
enum SpecialsService {
    static func list(limit: Int = 50, lat: Double? = nil, lng: Double? = nil) async throws -> [Sponsor] {
        var q: [String: String] = ["limit": "\(limit)"]
        if let lat { q["lat"] = "\(lat)" }
        if let lng { q["lng"] = "\(lng)" }
        let res = try await APIClient.request("GET", "specials", query: q)
        let map = res as? [String: Any] ?? [:]
        let arr = map["sponsors"] as? [[String: Any]] ?? []
        return arr.map { Sponsor(json: $0) }
    }

    static func count() async throws -> Int {
        let res = try await APIClient.request("GET", "specials/count")
        let map = res as? [String: Any] ?? [:]
        return map["count"] as? Int ?? 0
    }

    static func detail(id: String) async throws -> Sponsor {
        let res = try await APIClient.request("GET", "specials/\(id)")
        let map = res as? [String: Any] ?? [:]
        return Sponsor(json: map["sponsor"])
    }

    static func introState() async throws -> Bool {
        let res = try await APIClient.request("GET", "specials/intro-state")
        let map = res as? [String: Any] ?? [:]
        return map["seen"] as? Bool ?? false
    }

    static func markIntroSeen() async throws {
        _ = try await APIClient.request("POST", "specials/intro-seen")
    }

    static func createRedemption(sponsorId: String) async throws -> SpecialRedemption {
        let res = try await APIClient.request("POST", "specials/\(sponsorId)/redemption")
        let map = res as? [String: Any] ?? [:]
        return SpecialRedemption(json: map["redemption"])
    }

    static func currentRedemption() async throws -> SpecialRedemption? {
        let res = try await APIClient.request("GET", "specials/redemptions/current")
        let map = res as? [String: Any] ?? [:]
        guard let r = map["redemption"] as? [String: Any] else { return nil }
        return SpecialRedemption(json: r)
    }

    static func pendingRedemptions() async throws -> [SpecialRedemption] {
        let res = try await APIClient.request("GET", "specials/redemptions/pending")
        let map = res as? [String: Any] ?? [:]
        let arr = map["redemptions"] as? [[String: Any]] ?? []
        return arr.map { SpecialRedemption(json: $0) }
    }

    static func markVerified(id: String) async throws -> SpecialRedemption {
        let res = try await APIClient.request("POST", "specials/redemptions/\(id)/verified")
        let map = res as? [String: Any] ?? [:]
        return SpecialRedemption(json: map["redemption"])
    }

    static func chooseReward(id: String, choice: String, confirmed: Bool = true) async throws -> SpecialRedemption {
        let res = try await APIClient.request("POST", "specials/redemptions/\(id)/reward", body: [
            "choice": choice,
            "confirmed": confirmed,
        ])
        let map = res as? [String: Any] ?? [:]
        return SpecialRedemption(json: map["redemption"])
    }
}