import Foundation

/// Mirrors SearchService + SearchHistoryService in the rider app.
enum SearchService {
    static func search(query: String, lat: Double?, lon: Double?) async throws -> [SearchResult] {
        var q: [String: String] = ["q": query]
        if let lat { q["lat"] = "\(lat)" }
        if let lon { q["lon"] = "\(lon)" }
        let res = try await APIClient.request("GET", "geospatial/search", query: q, timeout: 8)
        let arr = res as? [[String: Any]] ?? []
        return arr.map { SearchResult(json: $0) }
    }
}

final class SearchHistoryService {
    static let instance = SearchHistoryService()

    private init() {}

    func fetch() async throws -> [SearchResult] {
        let res = try await APIClient.request("GET", "user/search-history")
        let arr = res as? [[String: Any]] ?? []
        return arr.map { SearchResult(json: $0) }
    }

    func save(_ result: SearchResult) async throws {
        _ = try await APIClient.request("POST", "user/search-history", body: result.historyPayload)
    }

    func clear() async throws {
        _ = try await APIClient.request("DELETE", "user/search-history")
    }
}