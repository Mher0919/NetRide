import Foundation

/// Mirrors reward_models.dart in the rider app.
struct ReferralInfo {
    var code: String
    var qrPayload: String
    var referralUrl: String
    var issuedAt: Date?
    var expiresAt: Date?
    var canScan: Bool
    var relationshipStatus: String?
    var referrer: [String: Any]?
    var referredCount: Int
    var rewardsEarnedCents: Int
    var history: [ReferralHistoryEntry]

    init(json: Any?) {
        let map = json as? [String: Any] ?? [:]
        self.code = (map["code"] as? String) ?? ""
        self.qrPayload = (map["qr_payload"] as? String) ?? ""
        self.referralUrl = (map["referral_url"] as? String) ?? ""
        self.issuedAt = Self.date(map["issued_at"])
        self.expiresAt = Self.date(map["expires_at"])
        self.canScan = map["can_scan"] as? Bool ?? true
        self.relationshipStatus = map["relationship_status"] as? String
        self.referrer = map["referrer"] as? [String: Any]
        self.referredCount = (map["referred_count"] as? Int) ?? 0
        self.rewardsEarnedCents = (map["rewards_earned_cents"] as? Int) ?? 0
        let rawHistory = map["history"] as? [[String: Any]] ?? []
        self.history = rawHistory.map { ReferralHistoryEntry(json: $0) }
    }

    private static func date(_ value: Any?) -> Date? {
        guard let s = value as? String else { return nil }
        return ISO8601DateFormatter().date(from: s)
    }
}

struct ReferralHistoryEntry: Identifiable {
    var id: String
    var friendName: String?
    var friendEmail: String?
    var status: String
    var scannedAt: Date?
    var firstRideCompletedAt: Date?
    var rewardGrantedAt: Date?
    var amountCents: Int?

    init(json: Any?) {
        let map = json as? [String: Any] ?? [:]
        self.id = (map["id"] as? String) ?? UUID().uuidString
        self.friendName = map["friend_name"] as? String
        self.friendEmail = map["friend_email"] as? String
        self.status = (map["status"] as? String) ?? ""
        self.scannedAt = Self.date(map["scanned_at"])
        self.firstRideCompletedAt = Self.date(map["first_ride_completed_at"])
        self.rewardGrantedAt = Self.date(map["reward_granted_at"])
        self.amountCents = map["amount_cents"] as? Int
    }

    private static func date(_ value: Any?) -> Date? {
        guard let s = value as? String else { return nil }
        return ISO8601DateFormatter().date(from: s)
    }
}

struct CreditAccount {
    var userId: String?
    var balanceCents: Int
    var lifetimeEarnedCents: Int

    init(json: Any?) {
        let map = json as? [String: Any] ?? [:]
        self.userId = map["user_id"] as? String
        self.balanceCents = (map["balance_cents"] as? Int) ?? 0
        self.lifetimeEarnedCents = (map["lifetime_earned_cents"] as? Int) ?? 0
    }
}

struct LedgerTransaction: Identifiable {
    var id: String
    var amountCents: Int
    var type: String
    var referenceType: String?
    var referenceId: String?
    var rideId: String?
    var description: String?
    var balanceAfterCents: Int?
    var createdAt: Date?

    init(json: Any?) {
        let map = json as? [String: Any] ?? [:]
        self.id = (map["id"] as? String) ?? UUID().uuidString
        self.amountCents = (map["amount_cents"] as? Int) ?? 0
        self.type = (map["type"] as? String) ?? ""
        self.referenceType = map["reference_type"] as? String
        self.referenceId = map["reference_id"] as? String
        self.rideId = map["ride_id"] as? String
        self.description = map["description"] as? String
        self.balanceAfterCents = map["balance_after_cents"] as? Int
        if let s = map["created_at"] as? String { self.createdAt = ISO8601DateFormatter().date(from: s) }
    }
}

struct WalletAccount {
    var userId: String?
    var balanceCents: Int
    var lifetimeDepositedCents: Int
    var lifetimeSpentCents: Int

    init(json: Any?) {
        let map = json as? [String: Any] ?? [:]
        self.userId = map["user_id"] as? String
        self.balanceCents = (map["balance_cents"] as? Int) ?? 0
        self.lifetimeDepositedCents = (map["lifetime_deposited_cents"] as? Int) ?? 0
        self.lifetimeSpentCents = (map["lifetime_spent_cents"] as? Int) ?? 0
    }
}

struct PromoPreview {
    var valid: Bool
    var code: String?
    var reason: String?
    var discountCents: Int?
    var fareCents: Int?
    var finalCents: Int?
    var discountLabel: String?
    var partnerName: String?
    var maxDiscountCents: Int?

    init(json: Any?) {
        let map = json as? [String: Any] ?? [:]
        self.valid = map["valid"] as? Bool ?? false
        self.code = map["code"] as? String
        self.reason = map["reason"] as? String
        self.discountCents = map["discount_cents"] as? Int
        self.fareCents = map["fare_cents"] as? Int
        self.finalCents = map["final_cents"] as? Int
        self.discountLabel = map["discount_label"] as? String
        self.partnerName = map["partner_name"] as? String
        self.maxDiscountCents = map["max_discount_cents"] as? Int
    }
}

struct FavoriteDriver: Identifiable {
    var id: String
    var driverId: String
    var fullName: String?
    var profileImageUrl: String?
    var phoneNumber: String?
    var rating: Double
    var ratingCount: Int

    init(json: Any?) {
        let map = json as? [String: Any] ?? [:]
        self.id = (map["id"] as? String) ?? UUID().uuidString
        self.driverId = (map["driver_id"] as? String) ?? ""
        let driver = map["driver"] as? [String: Any] ?? [:]
        let user = driver["user"] as? [String: Any] ?? [:]
        self.fullName = user["full_name"] as? String
        self.profileImageUrl = user["profile_image_url"] as? String
        self.phoneNumber = user["phone_number"] as? String
        self.rating = (user["rating"] as? Double) ?? (user["rating"] as? NSNumber)?.doubleValue ?? 5.0
        self.ratingCount = (user["rating_count"] as? Int) ?? 0
    }
}