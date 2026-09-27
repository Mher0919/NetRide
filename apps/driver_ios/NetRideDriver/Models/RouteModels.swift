import Foundation
import CoreLocation

/// Mirrors route_models.dart in the driver app.
struct RouteStep {
    var distanceMeters: Double
    var durationSeconds: Double
    var instruction: String
    var maneuver: String
    var polyline: [CLLocationCoordinate2D]
    var name: String?
    var ref: String?
    var lanes: [[String: Any]]?

    init(json: Any?) {
        let map = json as? [String: Any] ?? [:]
        self.distanceMeters = (map["distance"] as? Double) ?? (map["distance_meters"] as? Double) ?? 0
        if let durationString = map["duration"] as? String {
            self.durationSeconds = Self.parseDuration(durationString)
        } else {
            self.durationSeconds = (map["duration"] as? Double) ?? 0
        }
        self.instruction = (map["instruction"] as? String) ?? ""
        self.maneuver = (map["maneuver"] as? String) ?? ""
        self.name = map["name"] as? String
        self.ref = map["ref"] as? String
        self.lanes = map["lanes"] as? [[String: Any]]
        if let raw = map["polyline"] as? String {
            self.polyline = PolylineDecoder.decode(raw)
        } else if let raw = map["maneuver"] as? [String: Any],
                  let loc = raw["location"] as? [Any], loc.count >= 2 {
            let lng = (loc[0] as? NSNumber)?.doubleValue ?? 0
            let lat = (loc[1] as? NSNumber)?.doubleValue ?? 0
            self.polyline = [CLLocationCoordinate2D(latitude: lat, longitude: lng)]
        } else {
            self.polyline = []
        }
    }

    private static func parseDuration(_ s: String) -> Double {
        // "123s"
        let digits = s.filter(\.isNumber)
        return Double(digits) ?? 0
    }
}

struct RouteResponse {
    var originHex: String?
    var destHex: String?
    var distanceMeters: Double?
    var durationSeconds: Double?
    var trafficDurationSeconds: Double?
    var geometry: [CLLocationCoordinate2D]
    var steps: [RouteStep]
    var engine: String
    var cacheHit: Bool
    var speedLimitsByRoad: [String: Double]?

    var distanceMiles: Double? {
        guard let distanceMeters else { return nil }
        return distanceMeters / 1609.34
    }

    var durationMinutes: Double? {
        let d = trafficDurationSeconds ?? durationSeconds
        return d.map { $0 / 60 }
    }

    init(json: Any?) {
        let map = json as? [String: Any] ?? [:]
        self.originHex = (map["origin_hex"] as? String) ?? (map["originHex"] as? String)
        self.destHex = (map["dest_hex"] as? String) ?? (map["destHex"] as? String)
        self.distanceMeters = (map["distanceMeters"] as? Double) ?? (map["distance"] as? Double)
        self.durationSeconds = (map["durationSeconds"] as? Double) ?? (map["duration"] as? Double)
        self.trafficDurationSeconds = (map["trafficDurationSeconds"] as? Double) ?? (map["traffic_duration_seconds"] as? Double)
        self.geometry = Self.extractPoints(map)
        let rawSteps = map["steps"] as? [[String: Any]] ?? []
        self.steps = rawSteps.map { RouteStep(json: $0) }
        self.engine = (map["engine"] as? String) ?? "GoogleRoutes"
        self.cacheHit = map["cacheHit"] as? Bool ?? map["cache_hit"] as? Bool ?? false
        self.speedLimitsByRoad = map["speedLimitsByRoad"] as? [String: Double]
    }

    static func extractPoints(_ map: [String: Any]) -> [CLLocationCoordinate2D] {
        if let geom = map["geometry"] as? [String: Any], let coords = geom["coordinates"] as? [[Any]] {
            return coords.compactMap { pair in
                guard pair.count >= 2,
                      let lng = (pair[0] as? NSNumber)?.doubleValue,
                      let lat = (pair[1] as? NSNumber)?.doubleValue else { return nil }
                return CLLocationCoordinate2D(latitude: lat, longitude: lng)
            }
        }
        if let polyline = map["polyline"] as? [[Any]] {
            return polyline.compactMap { pair in
                guard pair.count >= 2,
                      let lng = (pair[0] as? NSNumber)?.doubleValue,
                      let lat = (pair[1] as? NSNumber)?.doubleValue else { return nil }
                return CLLocationCoordinate2D(latitude: lat, longitude: lng)
            }
        }
        if let encoded = map["encodedPolyline"] as? String {
            return PolylineDecoder.decode(encoded, precision: 6)
        }
        return []
    }
}

struct RouteSummary {
    var originHex: String
    var destHex: String
    var distanceMeters: Double?
    var durationSeconds: Double?
    var trafficDurationSeconds: Double?
    var cachedAt: Date

    func needsRefresh(maxAge: TimeInterval = 15 * 60) -> Bool {
        Date().timeIntervalSince(cachedAt) > maxAge
    }
}

/// Navigation route (server-hydrated shape from navigation events).
struct NavigationRoute {
    var points: [CLLocationCoordinate2D]
    var steps: [RouteStep]
    var distance: Double?
    var duration: Double?
    var eta: Double?
    var trafficDurationSeconds: Double?
    var speedLimitsByRoad: [String: Double]?
    var engine: String
    var cacheHit: Bool

    init(json: Any?) {
        let map = json as? [String: Any] ?? [:]
        self.points = []
        if let raw = map["points_list"] as? [[Any]] {
            self.points = raw.compactMap { pair in
                guard pair.count >= 2,
                      let lng = (pair[0] as? NSNumber)?.doubleValue,
                      let lat = (pair[1] as? NSNumber)?.doubleValue else { return nil }
                return CLLocationCoordinate2D(latitude: lat, longitude: lng)
            }
        } else if let raw = map["polyline"] as? [[Any]] {
            self.points = raw.compactMap { pair in
                guard pair.count >= 2,
                      let lng = (pair[0] as? NSNumber)?.doubleValue,
                      let lat = (pair[1] as? NSNumber)?.doubleValue else { return nil }
                return CLLocationCoordinate2D(latitude: lat, longitude: lng)
            }
        } else if let geom = map["geometry"] as? [String: Any], let coords = geom["coordinates"] as? [[Any]] {
            self.points = coords.compactMap { pair in
                guard pair.count >= 2,
                      let lng = (pair[0] as? NSNumber)?.doubleValue,
                      let lat = (pair[1] as? NSNumber)?.doubleValue else { return nil }
                return CLLocationCoordinate2D(latitude: lat, longitude: lng)
            }
        } else if let encoded = map["encodedPolyline"] as? String {
            self.points = PolylineDecoder.decode(encoded, precision: 6)
        }
        let rawSteps = map["steps"] as? [[String: Any]] ?? []
        self.steps = rawSteps.map { RouteStep(json: $0) }
        self.distance = (map["distance"] as? Double)
        self.duration = (map["duration"] as? Double) ?? (map["osrm_duration"] as? Double)
        self.eta = (map["eta"] as? Double)
        self.trafficDurationSeconds = (map["trafficDurationSeconds"] as? Double)
        self.speedLimitsByRoad = map["speedLimitsByRoad"] as? [String: Double]
        self.engine = (map["engine"] as? String) ?? "GoogleRoutes"
        self.cacheHit = map["cache_hit"] as? Bool ?? map["cacheHit"] as? Bool ?? false
    }
}

/// Decodes Google encoded polylines (polyline5 / polyline6).
enum PolylineDecoder {
    static func decode(_ encoded: String, precision: Int = 5) -> [CLLocationCoordinate2D] {
        let factor = pow(10.0, Double(precision))
        var coords: [CLLocationCoordinate2D] = []
        var index = encoded.startIndex
        var lat = 0.0
        var lng = 0.0

        func nextValue() -> Double {
            var result = 0
            var shift = 0
            var byte = 0
            repeat {
                guard index < encoded.endIndex else { return 0 }
                byte = Int(encoded[index].asciiValue ?? 0) - 63
                index = encoded.index(after: index)
                result |= (byte & 0x1f) << shift
                shift += 5
            } while byte >= 0x20
            let delta = (result & 1) != 0 ? ~(result >> 1) : (result >> 1)
            return Double(delta)
        }

        while index < encoded.endIndex {
            lat += nextValue()
            lng += nextValue()
            coords.append(CLLocationCoordinate2D(latitude: lat / factor, longitude: lng / factor))
        }
        return coords
    }
}