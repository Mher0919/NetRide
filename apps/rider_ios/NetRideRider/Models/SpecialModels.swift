import Foundation

/// Mirrors special_models.dart in the rider app.
struct SponsorDiscount {
    var type: String
    var percent: Double?
    var maxPercent: Double?
    var fixedAmountCents: Int?
    var label: String?

    init(json: Any?) {
        let map = json as? [String: Any] ?? [:]
        self.type = (map["type"] as? String) ?? "PERCENT"
        self.percent = (map["percent"] as? Double) ?? (map["percent"] as? NSNumber)?.doubleValue
        self.maxPercent = (map["maxPercent"] as? Double) ?? (map["max_percent"] as? NSNumber)?.doubleValue
        self.fixedAmountCents = (map["fixedAmountCents"] as? Int) ?? (map["fixed_amount_cents"] as? Int)
        self.label = map["label"] as? String
    }

    var displayLabel: String { label ?? "SPECIAL" }
}

struct Sponsor: Identifiable {
    var id: String
    var businessName: String
    var businessType: String?
    var businessDescription: String?
    var address: String?
    var city: String?
    var state: String?
    var latitude: Double?
    var longitude: Double?
    var logoUrl: String?
    var coverImageUrl: String?
    var discount: SponsorDiscount
    var kmAway: Double?
    var status: String?

    init(json: Any?) {
        let map = json as? [String: Any] ?? [:]
        self.id = (map["id"] as? String) ?? ""
        self.businessName = (map["businessName"] as? String) ?? ""
        self.businessType = map["businessType"] as? String
        self.businessDescription = map["businessDescription"] as? String
        self.address = map["address"] as? String
        self.city = map["city"] as? String
        self.state = map["state"] as? String
        self.latitude = (map["latitude"] as? Double) ?? (map["latitude"] as? NSNumber)?.doubleValue
        self.longitude = (map["longitude"] as? Double) ?? (map["longitude"] as? NSNumber)?.doubleValue
        self.logoUrl = map["logoUrl"] as? String
        self.coverImageUrl = map["coverImageUrl"] as? String
        self.discount = SponsorDiscount(json: map["discount"])
        self.kmAway = (map["kmAway"] as? Double) ?? (map["km_away"] as? NSNumber)?.doubleValue
        self.status = map["status"] as? String
    }
}

enum RedemptionStatus: String {
    case created = "CREATED"
    case ridePending = "RIDE_PENDING"
    case waitingForSponsor = "WAITING_FOR_SPONSOR"
    case sponsorValidated = "SPONSOR_VALIDATED"
    case rewardSelected = "REWARD_SELECTED"
    case rewardCompleted = "REWARD_COMPLETED"
    case cancelled = "CANCELLED"
    case expired = "EXPIRED"
    case rewardFailed = "REWARD_FAILED"

    static func from(_ raw: String?) -> RedemptionStatus {
        RedemptionStatus(rawValue: raw ?? "") ?? .created
    }

    var isActive: Bool {
        switch self {
        case .created, .ridePending, .waitingForSponsor, .sponsorValidated, .rewardSelected:
            return true
        default:
            return false
        }
    }
}

struct SpecialRedemption: Identifiable {
    var id: String
    var sponsorId: String?
    var riderId: String?
    var driverId: String?
    var rideId: String?
    var sponsorName: String
    var sponsorBusinessType: String?
    var sponsorLatitude: Double?
    var sponsorLongitude: Double?
    var sponsorAddress: String?
    var discountType: String
    var discountPercent: Double?
    var discountFixedAmountCents: Int?
    var discountLabel: String?
    var calculatedDiscountCents: Int?
    var validationExpiresAt: Date?
    var validationAttempts: Int
    var maxValidationAttempts: Int
    var status: RedemptionStatus
    var rideRequestedAt: Date?
    var rideCompletedAt: Date?
    var sponsorValidatedAt: Date?
    var cancelledBy: String?
    var cancelledAt: Date?
    var cancellationReasonCode: String?
    var cancellationReasonText: String?
    var rewardChoice: String?
    var rewardAmountCents: Int?
    var sponsorFundedCents: Int?
    var driverAllocationCents: Int?
    var netrideAllocationCents: Int?
    var netrideBonusCents: Int?
    var rewardProcessedAt: Date?
    var rewardFailedReason: String?
    var createdAt: Date?
    var updatedAt: Date?

    init(json: Any?) {
        let map = json as? [String: Any] ?? [:]
        self.id = (map["id"] as? String) ?? ""
        self.sponsorId = map["sponsor_id"] as? String
        self.riderId = map["rider_id"] as? String
        self.driverId = map["driver_id"] as? String
        self.rideId = map["ride_id"] as? String
        self.sponsorName = (map["sponsor_name"] as? String) ?? ""
        self.sponsorBusinessType = map["sponsor_business_type"] as? String
        self.sponsorLatitude = (map["sponsor_latitude"] as? Double) ?? (map["sponsor_latitude"] as? NSNumber)?.doubleValue
        self.sponsorLongitude = (map["sponsor_longitude"] as? Double) ?? (map["sponsor_longitude"] as? NSNumber)?.doubleValue
        self.sponsorAddress = map["sponsor_address"] as? String
        self.discountType = (map["discount_type"] as? String) ?? "PERCENT"
        self.discountPercent = (map["discount_percent"] as? Double) ?? (map["discount_percent"] as? NSNumber)?.doubleValue
        self.discountFixedAmountCents = map["discount_fixed_amount_cents"] as? Int
        self.discountLabel = map["discount_label"] as? String
        self.calculatedDiscountCents = map["calculated_discount_cents"] as? Int
        self.validationExpiresAt = Self.parseDate(map["validation_expires_at"])
        self.validationAttempts = (map["validation_attempts"] as? Int) ?? 0
        self.maxValidationAttempts = (map["max_validation_attempts"] as? Int) ?? 5
        self.status = RedemptionStatus.from(map["status"] as? String)
        self.rideRequestedAt = Self.parseDate(map["ride_requested_at"])
        self.rideCompletedAt = Self.parseDate(map["ride_completed_at"])
        self.sponsorValidatedAt = Self.parseDate(map["sponsor_validated_at"])
        self.cancelledBy = map["cancelled_by"] as? String
        self.cancelledAt = Self.parseDate(map["cancelled_at"])
        self.cancellationReasonCode = map["cancellation_reason_code"] as? String
        self.cancellationReasonText = map["cancellation_reason_text"] as? String
        self.rewardChoice = map["reward_choice"] as? String
        self.rewardAmountCents = map["reward_amount_cents"] as? Int
        self.sponsorFundedCents = map["sponsor_funded_cents"] as? Int
        self.driverAllocationCents = map["driver_allocation_cents"] as? Int
        self.netrideAllocationCents = map["netride_allocation_cents"] as? Int
        self.netrideBonusCents = map["netride_bonus_cents"] as? Int
        self.rewardProcessedAt = Self.parseDate(map["reward_processed_at"])
        self.rewardFailedReason = map["reward_failed_reason"] as? String
        self.createdAt = Self.parseDate(map["created_at"])
        self.updatedAt = Self.parseDate(map["updated_at"])
    }

    private static func parseDate(_ value: Any?) -> Date? {
        guard let s = value as? String else { return nil }
        return ISO8601DateFormatter().date(from: s)
    }
}