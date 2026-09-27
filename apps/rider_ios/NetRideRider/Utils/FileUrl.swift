import Foundation

/// Resolves `/api/files/...` paths and stale localhost URLs to absolute API URLs.
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