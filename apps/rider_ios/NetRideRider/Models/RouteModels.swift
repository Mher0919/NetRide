import Foundation
import CoreLocation

/// Mirrors routing responses in the rider app.
struct RoutePlan {
    var polyline: [CLLocationCoordinate2D]
    var distanceMeters: Double?
    var durationSeconds: Double?
    var etaSeconds: Double?
    var trafficDurationSeconds: Double?
    var fare: [String: Any]?
    var engine: String
    var cacheHit: Bool

    var totalFare: Double? {
        guard let fare else { return nil }
        return (fare["totalFare"] as? Double) ?? (fare["total_fare"] as? Double)
    }

    var etaSecondsEffective: Double? {
        if let t = trafficDurationSeconds, t > 0 { return t }
        if let e = etaSeconds, e > 0 { return e }
        return durationSeconds
    }

    init(json: Any?) {
        let map = json as? [String: Any] ?? [:]
        self.polyline = []
        if let raw = map["polyline"] as? [[Any]] {
            self.polyline = raw.compactMap { pair in
                guard pair.count >= 2,
                      let lng = (pair[0] as? NSNumber)?.doubleValue,
                      let lat = (pair[1] as? NSNumber)?.doubleValue else { return nil }
                return CLLocationCoordinate2D(latitude: lat, longitude: lng)
            }
        } else if let raw = map["points_list"] as? [[Any]] {
            self.polyline = raw.compactMap { pair in
                guard pair.count >= 2,
                      let lng = (pair[0] as? NSNumber)?.doubleValue,
                      let lat = (pair[1] as? NSNumber)?.doubleValue else { return nil }
                return CLLocationCoordinate2D(latitude: lat, longitude: lng)
            }
        } else if let geometry = map["geometry"] as? [String: Any] {
            self.polyline = Self.coordsFromGeoJSON(geometry)
        }
        self.distanceMeters = (map["distanceMeters"] as? Double) ?? (map["distance_meters"] as? Double) ?? (map["distance"] as? Double)
        self.durationSeconds = (map["durationSeconds"] as? Double) ?? (map["duration_seconds"] as? Double) ?? (map["duration"] as? Double)
        self.etaSeconds = (map["etaSeconds"] as? Double) ?? (map["eta"] as? Double)
        self.trafficDurationSeconds = (map["trafficDurationSeconds"] as? Double) ?? (map["traffic_duration_seconds"] as? Double)
        self.fare = map["fare"] as? [String: Any]
        self.engine = (map["engine"] as? String) ?? "GoogleRoutes"
        self.cacheHit = map["cacheHit"] as? Bool ?? map["cache_hit"] as? Bool ?? false
    }

    private static func coordsFromGeoJSON(_ geometry: [String: Any]) -> [CLLocationCoordinate2D] {
        guard let type = geometry["type"] as? String, type == "LineString",
              let coords = geometry["coordinates"] as? [[Any]] else {
            if let coordinates = geometry["coordinates"] as? [[Any]] {
                return coordinates.compactMap { pair in
                    guard pair.count >= 2,
                          let lng = (pair[0] as? NSNumber)?.doubleValue,
                          let lat = (pair[1] as? NSNumber)?.doubleValue else { return nil }
                    return CLLocationCoordinate2D(latitude: lat, longitude: lng)
                }
            }
            return []
        }
        return coords.compactMap { pair in
            guard pair.count >= 2,
                  let lng = (pair[0] as? NSNumber)?.doubleValue,
                  let lat = (pair[1] as? NSNumber)?.doubleValue else { return nil }
            return CLLocationCoordinate2D(latitude: lat, longitude: lng)
        }
    }
}

/// Cached route shape persisted by RouteCacheService.
struct CachedRoute: Codable {
    var originLat: Double
    var originLon: Double
    var destLat: Double
    var destLon: Double
    var originName: String?
    var destName: String?
    var distanceMeters: Double?
    var durationSeconds: Double?
    var trafficDurationSeconds: Double?
    var polyline: [[Double]]?
    var savedAt: Date
    var vehicleClass: String?
}