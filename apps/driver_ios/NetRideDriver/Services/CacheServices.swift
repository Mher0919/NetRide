import Foundation
import CoreLocation

/// Route cache for the driver app (mirrors route_cache_service.dart).
final class RouteCacheService {
    static let shared = RouteCacheService()

    private let prefix = "route_cache_v2:"
    private var lru: [String: Date] = [:]
    private var inMemory: [String: RouteSummary] = [:]
    private let maxLRU = 200

    private init() {}

    private func key(origin: Location, dest: Location) -> String {
        SpatialHash.encode(lat: origin.lat, lng: origin.lng) + ":" + SpatialHash.encode(lat: dest.lat, lng: dest.lng)
    }

    func get(origin: Location, dest: Location) -> RouteSummary? {
        let k = key(origin: origin, dest: dest)
        guard let summary = inMemory[k] else { return nil }
        let hasTraffic = summary.trafficDurationSeconds != nil
        let ttl: TimeInterval = hasTraffic ? 15 * 60 : 7 * 24 * 3600
        if Date().timeIntervalSince(summary.cachedAt) > ttl {
            inMemory.removeValue(forKey: k)
            lru.removeValue(forKey: k)
            return nil
        }
        touch(k)
        return summary
    }

    func set(_ summary: RouteSummary, origin: Location, dest: Location) {
        let k = key(origin: origin, dest: dest)
        inMemory[k] = summary
        touch(k)
        // Keep LRU bounded.
        if lru.count > maxLRU, let oldest = lru.min(by: { $0.value < $1.value })?.key {
            inMemory.removeValue(forKey: oldest)
            lru.removeValue(forKey: oldest)
        }
    }

    private func touch(_ key: String) {
        lru[key] = Date()
    }

    func invalidate(origin: Location, dest: Location) {
        let k = key(origin: origin, dest: dest)
        inMemory.removeValue(forKey: k)
        lru.removeValue(forKey: k)
    }
}

/// ETA cache (in-memory only) for the driver app.
final class EtaCacheService {
    static let shared = EtaCacheService()

    private var store: [String: (summary: RouteSummary, savedAt: Date)] = [:]
    private let maxEntries = 500

    private init() {}

    private func key(origin: Location, dest: Location) -> String {
        SpatialHash.encode(lat: origin.lat, lng: origin.lng, precision: 7) + ":" +
            SpatialHash.encode(lat: dest.lat, lng: dest.lng, precision: 7)
    }

    func get(origin: Location, dest: Location) -> RouteSummary? {
        guard let entry = store[key(origin: origin, dest: dest)] else { return nil }
        let hasTraffic = entry.summary.trafficDurationSeconds != nil
        let ttl: TimeInterval = hasTraffic ? 15 * 60 : 24 * 3600
        if Date().timeIntervalSince(entry.savedAt) > ttl {
            store.removeValue(forKey: key(origin: origin, dest: dest))
            return nil
        }
        return entry.summary
    }

    func set(_ summary: RouteSummary, origin: Location, dest: Location) {
        store[key(origin: origin, dest: dest)] = (summary, Date())
        if store.count > maxEntries {
            store.remove(store.min(by: { $0.value.savedAt < $1.value.savedAt })!.key)
        }
    }
}

/// Geohash helpers (mirrors spatial_hash.dart in driver app).
enum SpatialHash {
    private static let base32 = Array("0123456789bcdefghjkmnpqrstuvwxyz")

    static func encode(lat: Double, lng: Double, precision: Int = 8) -> String {
        var latMin = -90.0, latMax = 90.0
        var lngMin = -180.0, lngMax = 180.0
        var bit = 0
        var ch = 0
        var out = ""
        var even = true
        while out.count < precision {
            if even {
                let mid = (lngMin + lngMax) / 2
                if lng >= mid { ch = ch * 2 + 1; lngMin = mid } else { ch = ch * 2; lngMax = mid }
            } else {
                let mid = (latMin + latMax) / 2
                if lat >= mid { ch = ch * 2 + 1; latMin = mid } else { ch = ch * 2; latMax = mid }
            }
            even.toggle()
            bit += 1
            if bit == 5 {
                out.append(base32[ch])
                bit = 0
                ch = 0
            }
        }
        return out
    }

    struct Box { var latMin: Double; var latMax: Double; var lngMin: Double; var lngMax: Double }

    static func decode(_ hash: String) -> Box {
        var latMin = -90.0, latMax = 90.0
        var lngMin = -180.0, lngMax = 180.0
        var even = true
        for c in hash {
            guard let idx = base32.firstIndex(of: c) else { continue }
            var mask = 16
            while mask > 0 {
                if even {
                    let mid = (lngMin + lngMax) / 2
                    if idx & mask > 0 { lngMin = mid } else { lngMax = mid }
                } else {
                    let mid = (latMin + latMax) / 2
                    if idx & mask > 0 { latMin = mid } else { latMax = mid }
                }
                even.toggle()
                mask >>= 1
            }
        }
        return Box(latMin: latMin, latMax: latMax, lngMin: lngMin, lngMax: lngMax)
    }

    static func neighbors(of hash: String) -> [String] {
        let box = decode(hash)
        let latSpan = box.latMax - box.latMin
        let lngSpan = box.lngMax - box.lngMin
        let offsets = [(-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1)]
        return offsets.map { (dLat, dLng) in
            encode(
                lat: min(max(box.latMin + dLat * latSpan, -90), 90),
                lng: min(max(box.lngMin + dLng * lngSpan, -180), 180),
                precision: hash.count
            )
        }
    }

    static func haversine(_ a: CLLocationCoordinate2D, _ b: CLLocationCoordinate2D) -> Double {
        let r = 6371000.0
        let dLat = (b.latitude - a.latitude).degreesToRadians
        let dLng = (b.longitude - a.longitude).degreesToRadians
        let lat1 = a.latitude.degreesToRadians
        let lat2 = b.latitude.degreesToRadians
        let h = sin(dLat / 2) * sin(dLat / 2) + cos(lat1) * cos(lat2) * sin(dLng / 2) * sin(dLng / 2)
        return 2 * r * asin(sqrt(h))
    }
}

extension Double {
    var degreesToRadians: Double { self * .pi / 180 }
    var radiansToDegrees: Double { self * 180 / .pi }
}