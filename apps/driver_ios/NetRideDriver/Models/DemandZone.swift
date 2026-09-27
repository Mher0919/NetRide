import Foundation
import CoreLocation

/// Mirrors demand_zone.dart in the driver app.
struct DemandZone: Identifiable {
    var id = UUID()
    var lat: Double
    var lng: Double
    var radiusM: Double
    var score: Double
    var riders: Int

    init(json: Any?) {
        let map = json as? [String: Any] ?? [:]
        self.lat = (map["lat"] as? Double) ?? (map["lat"] as? NSNumber)?.doubleValue ?? 0
        self.lng = (map["lng"] as? Double) ?? (map["lng"] as? NSNumber)?.doubleValue ?? 0
        self.radiusM = (map["radiusM"] as? Double) ?? (map["radius_m"] as? NSNumber)?.doubleValue ?? 800
        self.score = min(max((map["score"] as? Double) ?? (map["score"] as? NSNumber)?.doubleValue ?? 0, 0), 1)
        self.riders = (map["riders"] as? Int) ?? 0
    }
}

struct DemandQuery {
    var zones: [DemandZone]
    var generatedAt: Date?
    var windowMinutes: Int
    var expiresAt: Date?

    init(json: Any?) {
        let map = json as? [String: Any] ?? [:]
        let raw = map["zones"] as? [[String: Any]] ?? []
        self.zones = raw.map { DemandZone(json: $0) }
        if let s = map["generatedAt"] as? String { self.generatedAt = ISO8601DateFormatter().date(from: s) }
        self.windowMinutes = (map["windowMinutes"] as? Int) ?? 60
        if let s = map["expiresAt"] as? String { self.expiresAt = ISO8601DateFormatter().date(from: s) }
    }
}