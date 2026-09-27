import Foundation
import CoreLocation

/// Route cache mirroring RouteCacheService (rider) — persisted to disk under `rider_route_cache:v2:`.
final class RouteCacheService {
    static let shared = RouteCacheService()

    private let prefix = "rider_route_cache:v2:"
    private let cleanupKey = "rider_route_cache:v2_cleanup_done"

    private init() {}

    private var cacheDir: URL? {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
        return base?.appendingPathComponent("netride_route_cache")
    }

    private func key(_ origin: Location, _ dest: Location) -> String {
        SpatialHash.routeCacheKey(origin: origin, dest: dest)
    }

    private var isExpired: (CachedRoute) -> Bool { route in
        let hasTraffic = route.trafficDurationSeconds != nil
        let ttl: TimeInterval = hasTraffic ? 15 * 60 : 24 * 3600
        return Date().timeIntervalSince(route.savedAt) > ttl
    }

    func get(origin: Location, dest: Location) -> CachedRoute? {
        let k = key(origin, dest)
        guard let url = cacheDir?.appendingPathComponent(k + ".json"),
              let data = try? Data(contentsOf: url),
              let route = try? JSONDecoder().decode(CachedRoute.self, from: data) else {
            return nil
        }
        if isExpired(route) {
            try? FileManager.default.removeItem(at: url)
            return nil
        }
        return route
    }

    func set(_ route: CachedRoute, origin: Location, dest: Location) {
        guard let dir = cacheDir else { return }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent(key(origin, dest) + ".json")
        if let data = try? JSONEncoder().encode(route) {
            try? data.write(to: url)
        }
    }

    /// Fares are never cached; callers always re-fetch.
    var needsFareRefresh: Bool { true }
}

/// ETA cache mirroring EtaCacheService — in-memory only.
final class EtaCacheService {
    static let shared = EtaCacheService()

    private let prefix = "rider_eta_cache:v2:"
    private var store: [String: (summary: CachedRoute, savedAt: Date)] = [:]

    private init() {}

    private func key(_ origin: Location, _ dest: Location) -> String {
        SpatialHash.encode(lat: origin.lat, lng: origin.lng, precision: 7) + ":" +
            SpatialHash.encode(lat: dest.lat, lng: dest.lng, precision: 7)
    }

    func get(origin: Location, dest: Location) -> CachedRoute? {
        guard let entry = store[key(origin, dest)] else { return nil }
        let hasTraffic = entry.summary.trafficDurationSeconds != nil
        let ttl: TimeInterval = hasTraffic ? 15 * 60 : 24 * 3600
        if Date().timeIntervalSince(entry.savedAt) > ttl {
            store.removeValue(forKey: key(origin, dest))
            return nil
        }
        return entry.summary
    }

    func set(_ summary: CachedRoute, origin: Location, dest: Location) {
        store[key(origin, dest)] = (summary, Date())
    }
}