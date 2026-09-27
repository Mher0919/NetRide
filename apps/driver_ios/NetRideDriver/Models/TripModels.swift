import Foundation
import CoreLocation

/// Mirrors trip_models.dart in the driver app.
struct Location: Equatable {
    var lat: Double
    var lng: Double
    var address: String?

    var coordinate: CLLocationCoordinate2D { CLLocationCoordinate2D(latitude: lat, longitude: lng) }

    init(lat: Double, lng: Double, address: String? = nil) {
        self.lat = lat
        self.lng = lng
        self.address = address
    }

    init(json: Any?) {
        let map = json as? [String: Any] ?? [:]
        self.lat = (map["lat"] as? Double) ?? (map["lat"] as? NSNumber)?.doubleValue ?? 0
        self.lng = (map["lng"] as? Double) ?? (map["lng"] as? NSNumber)?.doubleValue ?? 0
        self.address = map["address"] as? String
    }

    var toJson: [String: Any] {
        var dict: [String: Any] = ["lat": lat, "lng": lng]
        if let address { dict["address"] = address }
        return dict
    }
}

struct RiderInfo: Equatable {
    var name: String
    var email: String?
    var rating: Double
    var totalRides: Int

    init(json: Any?) {
        let map = json as? [String: Any] ?? [:]
        self.name = (map["name"] as? String) ?? "Rider"
        self.email = map["email"] as? String
        self.rating = (map["rating"] as? Double) ?? (map["rating"] as? NSNumber)?.doubleValue ?? 5.0
        self.totalRides = (map["total_rides"] as? Int) ?? 0
    }
}

struct DriverInfo: Equatable {
    var name: String
    var email: String?
    var rating: Double
    var totalRides: Int

    init(json: Any?) {
        let map = json as? [String: Any] ?? [:]
        self.name = (map["name"] as? String) ?? "Driver"
        self.email = map["email"] as? String
        self.rating = (map["rating"] as? Double) ?? (map["rating"] as? NSNumber)?.doubleValue ?? 5.0
        self.totalRides = (map["total_rides"] as? Int) ?? 0
    }
}

struct ChatMessage: Identifiable, Equatable {
    var id: String?
    var senderId: String
    var role: String
    var message: String
    var timestamp: Date
    var pending: Bool = false
    var failed: Bool = false

    init(senderId: String, role: String, message: String, timestamp: Date, pending: Bool = false, failed: Bool = false) {
        self.senderId = senderId
        self.role = role
        self.message = message
        self.timestamp = timestamp
        self.pending = pending
        self.failed = failed
    }

    init(json: Any?) {
        let map = json as? [String: Any] ?? [:]
        self.id = map["id"] as? String
        self.senderId = (map["senderId"] as? String) ?? (map["sender_id"] as? String) ?? ""
        self.role = (map["role"] as? String) ?? ""
        self.message = (map["message"] as? String) ?? ""
        if let ts = map["timestamp"] as? String {
            self.timestamp = ISO8601DateFormatter().date(from: ts) ?? Date()
        } else {
            self.timestamp = Date()
        }
    }
}

enum TripStatus: String, Equatable {
    case requested = "REQUESTED"
    case accepted = "ACCEPTED"
    case driverArriving = "DRIVER_ARRIVING"
    case inProgress = "IN_PROGRESS"
    case completed = "COMPLETED"
    case cancelled = "CANCELLED"

    static func from(_ raw: String?) -> TripStatus {
        TripStatus(rawValue: raw ?? "") ?? .requested
    }
}

struct Trip: Equatable {
    var id: String
    var riderId: String
    var driverId: String?
    var status: TripStatus
    var pickup: Location
    var destination: Location
    var fareAmount: Double?
    var tipAmount: Double?
    var initialMaxFare: Double?
    var savingLikelihood: Double?
    var riderInfo: RiderInfo?
    var driverInfo: DriverInfo?
    var calculatedPrice: Double?
    var driverEarningsCents: Int?
    var tripDistanceMeters: Double?
    var tripDurationSeconds: Double?
    var routeGeometry: [String: Any]?
    var driverToPickupEta: Double?
    var driverToPickupDistance: Double?
    var driverPricePerMile: Double?
    var offerId: String?
    var expiresAt: Date?
    var requestedAt: Date?
    var cancelledBy: String?
    var cancellationReasonCode: String?
    var cancellationReasonText: String?

    init(json: Any?) {
        let map = json as? [String: Any] ?? [:]
        self.id = (map["id"] as? String) ?? ""
        self.riderId = (map["rider_id"] as? String) ?? ""
        self.driverId = map["driver_id"] as? String
        self.status = TripStatus.from(map["status"] as? String)
        self.pickup = Location(json: map["pickup"])
        self.destination = Location(json: map["destination"])
        self.fareAmount = (map["fare_amount"] as? Double) ?? (map["fare_amount"] as? NSNumber)?.doubleValue
        self.tipAmount = (map["tip_amount"] as? Double) ?? (map["tip_amount"] as? NSNumber)?.doubleValue
        self.initialMaxFare = (map["initial_max_fare"] as? Double) ?? (map["initial_max_fare"] as? NSNumber)?.doubleValue
        self.savingLikelihood = (map["saving_likelihood"] as? Double) ?? (map["saving_likelihood"] as? NSNumber)?.doubleValue
        if let ri = map["rider_info"] { self.riderInfo = RiderInfo(json: ri) }
        if let di = map["driver_info"] { self.driverInfo = DriverInfo(json: di) }
        self.calculatedPrice = (map["calculated_price"] as? Double) ?? (map["calculated_price"] as? NSNumber)?.doubleValue
        self.driverEarningsCents = map["driver_earnings_cents"] as? Int
        self.tripDistanceMeters = (map["trip_distance_meters"] as? Double) ?? (map["trip_distance_meters"] as? NSNumber)?.doubleValue
        self.tripDurationSeconds = (map["trip_duration_seconds"] as? Double) ?? (map["trip_duration_seconds"] as? NSNumber)?.doubleValue
        self.routeGeometry = map["route_geometry"] as? [String: Any]
        self.driverToPickupEta = (map["driver_to_pickup_eta"] as? Double) ?? (map["driver_to_pickup_eta"] as? NSNumber)?.doubleValue
        self.driverToPickupDistance = (map["driver_to_pickup_distance"] as? Double) ?? (map["driver_to_pickup_distance"] as? NSNumber)?.doubleValue
        self.driverPricePerMile = (map["driver_price_per_mile"] as? Double) ?? (map["driver_price_per_mile"] as? NSNumber)?.doubleValue
        self.offerId = (map["offerId"] as? String) ?? (map["offer_id"] as? String)
        if let s = map["expires_at"] as? String { self.expiresAt = ISO8601DateFormatter().date(from: s) }
        if let s = map["requested_at"] as? String { self.requestedAt = ISO8601DateFormatter().date(from: s) }
        self.cancelledBy = map["cancelled_by"] as? String
        self.cancellationReasonCode = map["cancellation_reason_code"] as? String
        self.cancellationReasonText = map["cancellation_reason_text"] as? String
    }

    var isTestTrip: Bool {
        guard let riderEmail = riderInfo?.email, let driverEmail = driverInfo?.email else { return false }
        return Self.isTestEmail(riderEmail) && Self.isTestEmail(driverEmail)
    }

    private static func isTestEmail(_ email: String) -> Bool {
        let lower = email.lowercased()
        if lower.hasSuffix("@netride.test") || lower.hasSuffix("@netride.dev") { return true }
        return lower.range(of: #"(^|\+)(test|sandbox|dev)([-_.]|$)"#, options: .regularExpression) != nil
    }

    static func == (lhs: Trip, rhs: Trip) -> Bool {
        lhs.id == rhs.id &&
        lhs.riderId == rhs.riderId &&
        lhs.driverId == rhs.driverId &&
        lhs.status == rhs.status &&
        lhs.pickup == rhs.pickup &&
        lhs.destination == rhs.destination &&
        lhs.fareAmount == rhs.fareAmount &&
        lhs.tipAmount == rhs.tipAmount &&
        lhs.initialMaxFare == rhs.initialMaxFare &&
        lhs.savingLikelihood == rhs.savingLikelihood &&
        lhs.riderInfo == rhs.riderInfo &&
        lhs.driverInfo == rhs.driverInfo &&
        lhs.calculatedPrice == rhs.calculatedPrice &&
        lhs.driverEarningsCents == rhs.driverEarningsCents &&
        lhs.tripDistanceMeters == rhs.tripDistanceMeters &&
        lhs.tripDurationSeconds == rhs.tripDurationSeconds &&
        lhs.driverToPickupEta == rhs.driverToPickupEta &&
        lhs.driverToPickupDistance == rhs.driverToPickupDistance &&
        lhs.driverPricePerMile == rhs.driverPricePerMile &&
        lhs.offerId == rhs.offerId &&
        lhs.expiresAt == rhs.expiresAt &&
        lhs.requestedAt == rhs.requestedAt &&
        lhs.cancelledBy == rhs.cancelledBy &&
        lhs.cancellationReasonCode == rhs.cancellationReasonCode &&
        lhs.cancellationReasonText == rhs.cancellationReasonText
    }
}

enum DriverStatus: String {
    case offline = "offline"
    case online = "online"
    case onTrip = "onTrip"
}

enum VehicleClass: String {
    case core = "CORE"
    case elite = "ELITE"
    case prestige = "PRESTIGE"
}

enum DriverComplianceStatus {
    case profileChangePending
    case profileChangeApproved
    case backgroundCheckRejected
    case backgroundCheckPending
    case backgroundCheckApproved
    case documentActionRequired
    case vehicleInspectionRequired
    case documentSubmitted
    case headshotActionRequired
}