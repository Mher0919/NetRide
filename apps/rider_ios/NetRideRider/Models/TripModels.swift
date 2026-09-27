import Foundation
import CoreLocation

/// Mirrors trip_models.dart in the rider app.
struct Location {
    var lat: Double
    var lng: Double
    var heading: Double?
    var address: String?

    var coordinate: CLLocationCoordinate2D { CLLocationCoordinate2D(latitude: lat, longitude: lng) }

    init(lat: Double, lng: Double, heading: Double? = nil, address: String? = nil) {
        self.lat = lat
        self.lng = lng
        self.heading = heading
        self.address = address
    }

    init(json: Any?) {
        let map = json as? [String: Any] ?? [:]
        self.lat = (map["lat"] as? Double) ?? (map["lat"] as? NSNumber)?.doubleValue ?? 0
        self.lng = (map["lng"] as? Double) ?? (map["lng"] as? NSNumber)?.doubleValue ?? 0
        self.heading = (map["heading"] as? Double) ?? (map["heading"] as? NSNumber)?.doubleValue
        self.address = map["address"] as? String
    }

    var toJson: [String: Any] {
        var dict: [String: Any] = ["lat": lat, "lng": lng]
        if let heading { dict["heading"] = heading }
        if let address { dict["address"] = address }
        return dict
    }
}

struct DriverInfo {
    var id: String
    var name: String
    var email: String?
    var vehicle: String?
    var plate: String?
    var rating: Double
    var totalRides: Int
    var location: Location?

    init(json: Any?) {
        let map = json as? [String: Any] ?? [:]
        self.id = (map["id"] as? String) ?? ""
        self.name = (map["name"] as? String) ?? ""
        self.email = map["email"] as? String
        self.vehicle = map["vehicle"] as? String
        self.plate = map["plate"] as? String
        self.rating = (map["rating"] as? Double) ?? (map["rating"] as? NSNumber)?.doubleValue ?? 5.0
        self.totalRides = (map["totalRides"] as? Int) ?? (map["total_rides"] as? Int) ?? 0
        if let loc = map["location"] {
            self.location = Location(json: loc)
        }
    }
}

struct RiderInfo {
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

enum TripStatus: String {
    case requested = "REQUESTED"
    case accepted = "ACCEPTED"
    case driverArriving = "DRIVER_ARRIVING"
    case inProgress = "IN_PROGRESS"
    case completed = "COMPLETED"
    case cancelled = "CANCELLED"
    case idle = "IDLE"

    static func from(_ raw: String?) -> TripStatus {
        TripStatus(rawValue: raw ?? "") ?? .requested
    }
}

struct Trip {
    var id: String
    var riderId: String
    var driverId: String?
    var status: TripStatus
    var pickup: Location
    var destination: Location
    var fareAmount: Double?
    var initialMaxFare: Double?
    var savingLikelihood: Double?
    var riderInfo: RiderInfo?
    var driverInfo: DriverInfo?
    var cancelledBy: String?
    var cancellationReasonCode: String?
    var cancellationReasonText: String?
    var cancelReason: String?

    init(json: Any?) {
        let map = json as? [String: Any] ?? [:]
        self.id = (map["id"] as? String) ?? ""
        self.riderId = (map["rider_id"] as? String) ?? ""
        self.driverId = map["driver_id"] as? String
        self.status = TripStatus.from(map["status"] as? String)
        self.pickup = Location(json: map["pickup"])
        self.destination = Location(json: map["destination"])
        self.fareAmount = (map["fare_amount"] as? Double) ?? (map["fare_amount"] as? NSNumber)?.doubleValue
        self.initialMaxFare = (map["initial_max_fare"] as? Double) ?? (map["initial_max_fare"] as? NSNumber)?.doubleValue
        self.savingLikelihood = (map["saving_likelihood"] as? Double) ?? (map["saving_likelihood"] as? NSNumber)?.doubleValue
        if let ri = map["rider_info"] { self.riderInfo = RiderInfo(json: ri) }
        if let di = map["driver_info"] { self.driverInfo = DriverInfo(json: di) }
        self.cancelledBy = map["cancelled_by"] as? String
        self.cancellationReasonCode = map["cancellation_reason_code"] as? String
        self.cancellationReasonText = map["cancellation_reason_text"] as? String
        self.cancelReason = map["cancelReason"] as? String
    }
}

enum VehicleClass: String {
    case core = "CORE"
    case elite = "ELITE"
    case prestige = "PRESTIGE"
}