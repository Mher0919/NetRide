import Foundation
import CoreLocation

/// Mirrors RoutingService + GoogleRoutesService in the driver app.
enum RoutingService {
    static func getRoute(start: Location, end: Location) async throws -> RouteResponse {
        do {
            return try await googlePlan(start: start, end: end)
        } catch {
            do {
                return try await fallbackRoute(start: start, end: end)
            } catch {
                return localFallback(start: start, end: end)
            }
        }
    }

    static func googlePlan(start: Location, end: Location) async throws -> RouteResponse {
        let res = try await APIClient.request("POST", "routing/google-plan", body: [
            "origin": [start.lat, start.lng],
            "destination": [end.lat, end.lng],
            "originHex": SpatialHash.encode(lat: start.lat, lng: start.lng),
            "destHex": SpatialHash.encode(lat: end.lat, lng: end.lng),
        ], timeout: 10)
        let response = RouteResponse(json: res)
        guard !response.geometry.isEmpty else { throw APIError.invalidData }
        // Cache
        RouteCacheService.shared.set(
            RouteSummary(originHex: SpatialHash.encode(lat: start.lat, lng: start.lng),
                         destHex: SpatialHash.encode(lat: end.lat, lng: end.lng),
                         distanceMeters: response.distanceMeters,
                         durationSeconds: response.durationSeconds,
                         trafficDurationSeconds: response.trafficDurationSeconds,
                         cachedAt: Date()),
            origin: start, dest: end
        )
        return response
    }

    static func fallbackRoute(start: Location, end: Location) async throws -> RouteResponse {
        let res = try await APIClient.request("POST", "geospatial/route", body: [
            "start": [start.lat, start.lng],
            "end": [end.lat, end.lng],
        ], timeout: 10)
        let response = RouteResponse(json: res)
        guard !response.geometry.isEmpty else { throw APIError.invalidData }
        return response
    }

    static func localFallback(start: Location, end: Location) -> RouteResponse {
        let s = start.coordinate
        let e = end.coordinate
        let direct = SpatialHash.haversine(s, e)
        let detour = direct * 1.4
        let mid1 = CLLocationCoordinate2D(latitude: s.latitude + (e.latitude - s.latitude) * 0.33,
                                          longitude: s.longitude + (e.longitude - s.longitude) * 0.33)
        let mid2 = CLLocationCoordinate2D(latitude: s.latitude + (e.latitude - s.latitude) * 0.66,
                                          longitude: s.longitude + (e.longitude - s.longitude) * 0.66)
        var response = RouteResponse(json: nil)
        response.geometry = [s, mid1, mid2, e]
        response.distanceMeters = detour
        response.durationSeconds = detour / 5.5
        response.trafficDurationSeconds = response.durationSeconds.map { $0 * 1.2 }
        response.engine = "Local-Premium-Fallback"
        return response
    }

    static func requestReroute(tripId: String, leg: String, lat: Double, lng: Double) async throws -> NavigationRoute? {
        let res = try await APIClient.request("POST", "navigation/reroute", body: [
            "tripId": tripId,
            "leg": leg,
            "lat": lat,
            "lng": lng,
        ], timeout: 10)
        let map = res as? [String: Any] ?? [:]
        guard let route = map["route"] as? [String: Any] else { return nil }
        return NavigationRoute(json: route)
    }

    static func getCachedLeg(tripId: String, leg: String) async throws -> NavigationRoute? {
        let res = try await APIClient.request("GET", "navigation/cached", query: ["tripId": tripId, "leg": leg], timeout: 5)
        let map = res as? [String: Any] ?? [:]
        guard let route = map["route"] as? [String: Any] else { return nil }
        return NavigationRoute(json: route)
    }

    static func getEta(origin: Location, dest: Location) async throws -> RouteSummary {
        if let cached = EtaCacheService.shared.get(origin: origin, dest: dest) {
            return cached
        }
        let response = try await googlePlan(start: origin, end: dest)
        let summary = RouteSummary(
            originHex: SpatialHash.encode(lat: origin.lat, lng: origin.lng),
            destHex: SpatialHash.encode(lat: dest.lat, lng: dest.lng),
            distanceMeters: response.distanceMeters,
            durationSeconds: response.durationSeconds,
            trafficDurationSeconds: response.trafficDurationSeconds,
            cachedAt: Date()
        )
        EtaCacheService.shared.set(summary, origin: origin, dest: dest)
        return summary
    }
}