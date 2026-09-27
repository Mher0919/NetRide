import Foundation
import CoreLocation

/// Mirrors RoutingService in the rider app: tries google-plan, falls back to plan,
/// then a local premium fallback plan.
enum RoutingService {
    private static var inflight: [String: Task<RoutePlan, Error>] = [:]

    static func plan(origin: Location, dest: Location, bypassCache: Bool = false) async throws -> RoutePlan {
        let key = SpatialHash.routeCacheKey(origin: origin, dest: dest)

        if !bypassCache, let cached = RouteCacheService.shared.get(origin: origin, dest: dest),
           let polyline = cached.polyline {
            var plan = RoutePlan(json: nil)
            plan.polyline = polyline.map { CLLocationCoordinate2D(latitude: $0[0], longitude: $0[1]) }
            plan.distanceMeters = cached.distanceMeters
            plan.durationSeconds = cached.durationSeconds
            plan.trafficDurationSeconds = cached.trafficDurationSeconds
            plan.engine = "Cache"
            return plan
        }

        // Dedupe in-flight requests for the same key.
        if let existing = inflight[key] {
            return try await existing.value
        }

        let task = Task<RoutePlan, Error> {
            do {
                return try await fetchGoogle(origin: origin, dest: dest)
            } catch {
                return try await fetchFallback(origin: origin, dest: dest)
            }
        }
        inflight[key] = task
        defer { inflight.removeValue(forKey: key) }
        return try await task.value
    }

    private static func fetchGoogle(origin: Location, dest: Location) async throws -> RoutePlan {
        let res = try await APIClient.request("POST", "routing/google-plan", body: [
            "origin": [origin.lat, origin.lng],
            "destination": [dest.lat, dest.lng],
        ], timeout: 10)
        let plan = RoutePlan(json: res)
        guard !plan.polyline.isEmpty else { throw APIError.invalidData }
        // Persist cache (polyline only).
        if let distance = plan.distanceMeters, let duration = plan.durationSeconds {
            RouteCacheService.shared.set(
                CachedRoute(
                    originLat: origin.lat, originLon: origin.lng,
                    destLat: dest.lat, destLon: dest.lng,
                    distanceMeters: distance, durationSeconds: duration,
                    trafficDurationSeconds: plan.trafficDurationSeconds,
                    polyline: plan.polyline.map { [$0.latitude, $0.longitude] },
                    savedAt: Date()
                ),
                origin: origin, dest: dest
            )
        }
        return plan
    }

    private static func fetchFallback(origin: Location, dest: Location) async throws -> RoutePlan {
        do {
            let res = try await APIClient.request("POST", "routing/plan", body: [
                "origin": [origin.lat, origin.lng],
                "destination": [dest.lat, dest.lng],
            ], timeout: 10)
            let plan = RoutePlan(json: res)
            if !plan.polyline.isEmpty { return plan }
            throw APIError.invalidData
        } catch {
            return localFallback(origin: origin, dest: dest)
        }
    }

    /// Local premium fallback: straight line + midpoints, urban speed 5.5 m/s, detour 1.4.
    private static func localFallback(origin: Location, dest: Location) -> RoutePlan {
        let start = origin.coordinate
        let end = dest.coordinate
        let directDistance = SpatialHash.haversine(start, end)
        let detour = directDistance * 1.4
        let duration = detour / 5.5
        let mid1 = CLLocationCoordinate2D(
            latitude: start.latitude + (end.latitude - start.latitude) * 0.33,
            longitude: start.longitude + (end.longitude - start.longitude) * 0.33
        )
        let mid2 = CLLocationCoordinate2D(
            latitude: start.latitude + (end.latitude - start.latitude) * 0.66,
            longitude: start.longitude + (end.longitude - start.longitude) * 0.66
        )
        var plan = RoutePlan(json: nil)
        plan.polyline = [start, mid1, mid2, end]
        plan.distanceMeters = detour
        plan.durationSeconds = duration
        plan.etaSeconds = duration * 1.2
        plan.engine = "Local-Premium-Fallback"
        return plan
    }
}