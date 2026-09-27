import Foundation
import CoreLocation

/// Mirrors heatmap_service.dart in the driver app.
enum HeatmapService {
    static func fetch(lat: Double, lng: Double, radiusKm: Int = 10) async throws -> DemandQuery {
        let res = try await APIClient.request("GET", "heatmap", query: [
            "lat": "\(lat)",
            "lng": "\(lng)",
            "radiusKm": "\(radiusKm)",
        ])
        return DemandQuery(json: res)
    }

    static func friendlyError(_ error: Error) -> String {
        if let api = error as? APIError {
            if case .server(let status, _) = api, status == 401 {
                return "Please sign in again."
            }
            return "Demand data unavailable."
        }
        if let ns = error as NSError?, ns.domain == NSURLErrorDomain, ns.code == NSURLErrorTimedOut {
            return "Demand data is taking too long — retrying shortly."
        }
        return "Demand data unavailable."
    }
}

/// Mirrors file_url.dart in the driver app.
enum FileUrl {
    static func resolve(_ url: String?) -> String? {
        guard let url, !url.isEmpty else { return nil }
        if url.hasPrefix("/api/") || url.hasPrefix("/uploads/") {
            return EnvConfig.apiBaseURL + url
        }
        if url.hasPrefix("http://localhost") || url.hasPrefix("http://127.0.0.1") {
            return EnvConfig.apiBaseURL + url.dropFirst("http://".count).drop(while: { $0 != "/" })
        }
        return url
    }
}

extension String {
    func drop(while predicate: (Character) -> Bool) -> String {
        var s = self
        while let first = s.first, predicate(first) {
            s.removeFirst()
        }
        return s
    }
}

/// Mirrors phone_utils.dart in the driver app.
enum PhoneUtils {
    static func normalizeUS(_ raw: String) -> String? {
        let digits = raw.filter(\.isNumber)
        var national = digits
        if national.hasPrefix("1") && national.count == 11 { national = String(national.dropFirst()) }
        guard national.count == 10 else { return nil }
        guard national.first != "0", national.first != "1" else { return nil }
        return "+1" + national
    }

    static func format(_ raw: String) -> String {
        let digits = raw.filter(\.isNumber)
        if digits.count == 10 {
            let i = digits.index(digits.startIndex, offsetBy: 3)
            let j = digits.index(i, offsetBy: 3)
            return "(\(digits[..<i])) \(digits[i..<j])-\(digits[j...])"
        }
        return raw
    }
}