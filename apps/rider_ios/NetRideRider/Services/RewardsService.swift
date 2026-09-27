import Foundation

/// Mirrors RewardsService in the rider app.
enum RewardsService {
    static var devicePayload: [String: Any] {
        ["device": ["deviceId": SessionStore.shared.installId, "platform": "ios"]]
    }

    static func getReferral() async throws -> ReferralInfo {
        let res = try await APIClient.request("GET", "referral")
        return ReferralInfo(json: res)
    }

    static func getReferralHistory() async throws -> [ReferralHistoryEntry] {
        let res = try await APIClient.request("GET", "referral/history")
        let map = res as? [String: Any] ?? [:]
        let arr = map["history"] as? [[String: Any]] ?? []
        return arr.map { ReferralHistoryEntry(json: $0) }
    }

    static func getOnboardingStatus() async throws -> (eligible: Bool, state: String, deviceRisk: String) {
        let res = try await APIClient.request("GET", "referral/onboarding-status", body: devicePayload)
        let map = res as? [String: Any] ?? [:]
        return (
            eligible: map["eligible"] as? Bool ?? false,
            state: (map["state"] as? String) ?? "USED",
            deviceRisk: (map["device_risk"] as? String) ?? "NORMAL"
        )
    }

    static func scanReferral(payload: String? = nil, url: String? = nil, code: String? = nil) async throws -> (relationshipId: String?, status: String?, referrerName: String?) {
        var body: [String: Any] = devicePayload
        if let payload { body["payload"] = payload }
        if let url { body["url"] = url }
        if let code { body["code"] = code }
        let res = try await APIClient.request("POST", "referral/scan", body: body)
        let map = res as? [String: Any] ?? [:]
        return (
            relationshipId: map["relationship_id"] as? String,
            status: map["status"] as? String,
            referrerName: map["referrer_name"] as? String
        )
    }

    static func skipOnboarding() async throws {
        _ = try await APIClient.request("POST", "referral/skip")
    }

    static func getCredits() async throws -> CreditAccount {
        let res = try await APIClient.request("GET", "credits")
        return CreditAccount(json: res)
    }

    static func getCreditTransactions(limit: Int = 50, offset: Int = 0) async throws -> [LedgerTransaction] {
        let res = try await APIClient.request("GET", "credits/transactions", query: ["limit": "\(limit)", "offset": "\(offset)"])
        let map = res as? [String: Any] ?? [:]
        let arr = map["transactions"] as? [[String: Any]] ?? []
        return arr.map { LedgerTransaction(json: $0) }
    }

    static func getWallet() async throws -> WalletAccount {
        let res = try await APIClient.request("GET", "wallet")
        return WalletAccount(json: res)
    }

    static func getWalletTransactions(limit: Int = 50, offset: Int = 0) async throws -> [LedgerTransaction] {
        let res = try await APIClient.request("GET", "wallet/transactions", query: ["limit": "\(limit)", "offset": "\(offset)"])
        let map = res as? [String: Any] ?? [:]
        let arr = map["transactions"] as? [[String: Any]] ?? []
        return arr.map { LedgerTransaction(json: $0) }
    }

    static func validatePromo(code: String, distanceMeters: Double? = nil, durationSeconds: Double? = nil) async throws -> PromoPreview {
        var body: [String: Any] = ["code": code.uppercased()]
        if let distanceMeters { body["distanceMeters"] = distanceMeters }
        if let durationSeconds { body["durationSeconds"] = durationSeconds }
        let res = try await APIClient.request("POST", "promo/validate", body: body)
        return PromoPreview(json: res)
    }
}

/// Friendly referral error copy (mirrors friendlyReferralError).
enum ReferralErrors {
    static func friendly(for code: String?) -> String {
        switch code {
        case "SELF_REFERRAL": return "You can't refer yourself."
        case "ALREADY_USED": return "This referral code has already been used."
        case "CODE_EXPIRED": return "This referral code has expired."
        case "CODE_NOT_FOUND": return "We couldn't find that referral code."
        case "REFERRALS_CLOSED": return "Referrals are currently closed."
        case "REFERRER_UNAVAILABLE": return "This referral isn't available right now."
        case "INVALID_LINK", "INVALID_PAYLOAD": return "That referral link is invalid."
        default: return "We couldn't process that referral code. Please try again."
        }
    }
}